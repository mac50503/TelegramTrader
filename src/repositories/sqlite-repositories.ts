import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import type {
  AuditRepository, ContextRepository, IdempotencyRepository, RecordCloseInput, RecordExecutionInput, RecordSlUpdateInput,
  SignalRepository, TradeRepository
} from "../application/ports.js";
import type { SignalAnalysis, SignalStatus, TelegramMessage, TradeSignal, TradingMode } from "../models/signal.js";
import type { Mt5Context, Trade, TradeAssignment } from "../models/trade.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import { newAssignmentToken, newId } from "../shared/ids.js";

type Row = Record<string, unknown>;

function now(): string { return new Date().toISOString(); }
function json(value: unknown): string { return JSON.stringify(value ?? null); }
function nullableMt5Ticket(value: string | undefined): string | null {
  const ticket = value?.trim();
  return ticket && ticket !== "0" ? ticket : null;
}

function mapSignal(row: Row): TradeSignal {
  return {
    id: String(row.id), telegramChatId: String(row.telegram_chat_id), telegramMessageId: String(row.telegram_message_id),
    source: String(row.source), chatName: String(row.chat_name), originalMessage: String(row.original_message),
    aiResultJson: row.ai_result_json === null ? null : String(row.ai_result_json),
    validationResultJson: row.validation_result_json === null ? null : String(row.validation_result_json),
    symbol: row.symbol === null ? null : String(row.symbol), side: row.side as TradeSignal["side"],
    entry: row.entry === null ? null : String(row.entry),
    entryMin: row.entry_min === null ? (row.entry === null ? null : String(row.entry)) : String(row.entry_min),
    entryMax: row.entry_max === null ? (row.entry === null ? null : String(row.entry)) : String(row.entry_max),
    stopLoss: row.stop_loss === null ? null : String(row.stop_loss),
    takeProfit: row.take_profit === null ? null : String(row.take_profit), requestedLot: row.requested_lot === null ? null : String(row.requested_lot),
    approvedLot: row.approved_lot === null ? null : String(row.approved_lot), riskPercentage: row.risk_percentage === null ? null : String(row.risk_percentage),
    confidence: row.confidence === null ? null : Number(row.confidence), receivedAt: String(row.received_at), expiresAt: String(row.expires_at),
    status: row.status as SignalStatus, rejectionCode: row.rejection_code === null ? null : String(row.rejection_code),
    rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), version: Number(row.version),
    signalGroupId: row.signal_group_id === null ? null : String(row.signal_group_id),
    legIndex: Number(row.leg_index ?? 0), legCount: Number(row.leg_count ?? 1)
  };
}

function mapTrade(row: Row): Trade {
  return {
    id: String(row.id), signalId: String(row.signal_id), clientId: String(row.client_id), assignmentToken: String(row.assignment_token),
    status: row.status as Trade["status"], tradingMode: row.trading_mode as Trade["tradingMode"], assignedAt: String(row.assigned_at),
    acknowledgedAt: row.acknowledged_at === null ? null : String(row.acknowledged_at),
    executedAt: row.executed_at === null ? null : String(row.executed_at), closedAt: row.closed_at === null ? null : String(row.closed_at)
  };
}

export class SqliteRepositories implements SignalRepository, TradeRepository, ContextRepository, IdempotencyRepository, AuditRepository {
  constructor(private readonly db: Database.Database) {}

  createFromTelegram(message: TelegramMessage, expiresAt: string): TradeSignal | null {
    return this.db.transaction(() => {
      const duplicate = this.db.prepare("SELECT id FROM signals WHERE source=? AND telegram_chat_id=? AND telegram_message_id=?")
        .get(message.source, message.chatId, message.messageId);
      if (duplicate) return null;
      const date = message.timestamp.slice(0, 10).replaceAll("-", "");
      const counter = this.db.prepare(`INSERT INTO daily_counters(counter_date,value) VALUES(?,1)
        ON CONFLICT(counter_date) DO UPDATE SET value=value+1 RETURNING value`).get(date) as { value: number };
      const id = `SIG-${date}-${String(counter.value).padStart(6, "0")}`;
      const timestamp = now();
      this.db.prepare(`INSERT INTO signals(
        id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,received_at,expires_at,status,created_at,updated_at,
        signal_group_id,leg_index,leg_count
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,1)`).run(id, message.chatId, message.messageId, message.source, message.chatName, message.text,
        message.timestamp, expiresAt, "RECEIVED", timestamp, timestamp, id);
      this.db.prepare("INSERT INTO signal_status_history(signal_id,to_status,created_at) VALUES(?,?,?)").run(id, "RECEIVED", timestamp);
      return this.findById(id);
    })();
  }

  findById(id: string): TradeSignal | null {
    const row = this.db.prepare("SELECT * FROM signals WHERE id=?").get(id) as Row | undefined;
    return row ? mapSignal(row) : null;
  }

  list(limit: number, offset: number, status?: SignalStatus): TradeSignal[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM signals WHERE status=? ORDER BY received_at DESC LIMIT ? OFFSET ?").all(status, limit, offset)
      : this.db.prepare("SELECT * FROM signals ORDER BY received_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    return (rows as Row[]).map(mapSignal);
  }

  setStatus(id: string, status: SignalStatus, reason?: { code: string; message: string }): void {
    this.db.transaction(() => {
      const current = this.findById(id);
      if (!current) throw new NotFoundError("Signal");
      const timestamp = now();
      this.db.prepare(`UPDATE signals SET status=?,rejection_code=?,rejection_reason=?,updated_at=?,version=version+1 WHERE id=?`)
        .run(status, reason?.code ?? null, reason?.message ?? null, timestamp, id);
      this.db.prepare(`INSERT INTO signal_status_history(signal_id,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?)`)
        .run(id, current.status, status, reason?.message ?? null, timestamp);
    })();
  }

  saveAnalysis(id: string, analysis: SignalAnalysis): void {
    const detected = analysis.isSignal ? analysis : null;
    const result = this.db.prepare(`UPDATE signals SET ai_result_json=?,symbol=?,side=?,entry=?,entry_min=?,entry_max=?,stop_loss=?,take_profit=?,requested_lot=?,
      risk_percentage=?,confidence=?,leg_count=?,analyzed_at=?,updated_at=?,version=version+1 WHERE id=?`).run(
      json(analysis), detected?.symbol ?? null, detected?.side ?? null, detected?.entry ?? null,
      detected?.entryMin ?? null, detected?.entryMax ?? null, detected?.stopLoss ?? null,
      detected?.takeProfits[0] ?? null, detected?.lot ?? null, detected?.riskPercentage ?? null, detected?.confidence ?? null,
      detected?.takeProfits.length ?? 1, now(), now(), id);
    if (result.changes !== 1) throw new NotFoundError("Signal");
  }

  createSiblingLeg(parent: TradeSignal, legIndex: number, legCount: number, takeProfit: string, groupId: string): TradeSignal {
    return this.db.transaction(() => {
      const id = `${parent.id}-TP${legIndex + 1}`;
      const timestamp = now();
      this.db.prepare(`INSERT INTO signals(
        id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,ai_result_json,
        symbol,side,entry,entry_min,entry_max,stop_loss,take_profit,requested_lot,risk_percentage,confidence,
        received_at,expires_at,status,created_at,updated_at,signal_group_id,leg_index,leg_count
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, parent.telegramChatId, parent.telegramMessageId, parent.source, parent.chatName, parent.originalMessage, parent.aiResultJson,
        parent.symbol, parent.side, parent.entry, parent.entryMin, parent.entryMax, parent.stopLoss, takeProfit,
        parent.requestedLot, parent.riskPercentage, parent.confidence,
        parent.receivedAt, parent.expiresAt, "ANALYZING", timestamp, timestamp, groupId, legIndex, legCount);
      this.db.prepare("INSERT INTO signal_status_history(signal_id,to_status,created_at) VALUES(?,?,?)").run(id, "ANALYZING", timestamp);
      return this.findById(id)!;
    })();
  }

  saveValidated(id: string, approvedLot: string, validationJson: string): void {
    const result = this.db.prepare(`UPDATE signals SET approved_lot=?,validation_result_json=?,validated_at=?,updated_at=?,version=version+1 WHERE id=?`)
      .run(approvedLot, validationJson, now(), now(), id);
    if (result.changes !== 1) throw new NotFoundError("Signal");
  }

  hasSemanticDuplicate(signal: TradeSignal, since: string): boolean {
    if (!signal.symbol || !signal.side || !signal.entryMin || !signal.entryMax || !signal.stopLoss || !signal.takeProfit) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM signals WHERE id<>? AND source=? AND symbol=? AND side=?
      AND COALESCE(entry_min,entry)=? AND COALESCE(entry_max,entry)=? AND stop_loss=?
      AND take_profit=? AND received_at>=? AND status NOT IN ('IGNORED','REJECTED','ERROR') LIMIT 1`)
      .get(signal.id, signal.source, signal.symbol, signal.side, signal.entryMin, signal.entryMax, signal.stopLoss, signal.takeProfit, since));
  }

  assignNext(clientId: string, mode: "SIMULATION" | "LIVE", maxSimultaneousTrades: number): TradeAssignment | null {
    return this.db.transaction(() => {
      const active = this.countActiveTradesForClient(clientId);
      if (active >= maxSimultaneousTrades) return null;
      const row = this.db.prepare("SELECT * FROM signals WHERE status='QUEUED' AND expires_at>? ORDER BY received_at,id LIMIT 1").get(now()) as Row | undefined;
      if (!row) return null;
      const signal = mapSignal(row);
      if (!signal.symbol || !signal.side || !signal.entry || !signal.entryMin || !signal.entryMax || !signal.stopLoss || !signal.takeProfit || !signal.approvedLot) return null;
      const tradeId = newId("TRD");
      const token = newAssignmentToken();
      const timestamp = now();
      this.db.prepare(`INSERT INTO trades(id,signal_id,client_id,assignment_token,status,trading_mode,assigned_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(tradeId, signal.id, clientId, token, "ASSIGNED", mode, timestamp, timestamp, timestamp);
      this.setStatus(signal.id, "ASSIGNED");
      return this.mapAssignment({ ...row, trade_id: tradeId, assignment_token: token, trading_mode: mode });
    })();
  }

  countActiveTradesForClient(clientId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) count FROM trades WHERE client_id=? AND status IN ('ASSIGNED','SUBMITTED','FILLED','UNKNOWN')")
      .get(clientId) as { count: number }).count);
  }

  currentAssignments(clientId: string): TradeAssignment[] {
    const rows = this.db.prepare(`SELECT t.id trade_id,t.assignment_token,t.trading_mode,s.* FROM trades t JOIN signals s ON s.id=t.signal_id
      WHERE t.client_id=? AND t.status IN ('ASSIGNED','SUBMITTED','FILLED','UNKNOWN') ORDER BY t.assigned_at`).all(clientId) as Row[];
    return rows.filter((row) => row.symbol && row.side && row.entry && row.stop_loss && row.take_profit && row.approved_lot)
      .map((row) => this.mapAssignment(row));
  }

  private mapAssignment(row: Row): TradeAssignment {
    const entryMin = row.entry_min ?? row.entry;
    const entryMax = row.entry_max ?? row.entry;
    return { signalId: String(row.id), tradeId: String(row.trade_id), assignmentToken: String(row.assignment_token),
      mode: row.trading_mode as TradeAssignment["mode"], symbol: String(row.symbol), side: row.side as TradeAssignment["side"],
      entry: String(row.entry), entryMin: String(entryMin), entryMax: String(entryMax),
      stopLoss: String(row.stop_loss), takeProfit: String(row.take_profit), volume: String(row.approved_lot),
      expiresAt: String(row.expires_at),
      groupId: String(row.signal_group_id ?? row.id), legIndex: Number(row.leg_index ?? 0), legCount: Number(row.leg_count ?? 1) };
  }

  acknowledge(signalId: string, clientId: string, assignmentToken: string): Trade {
    const result = this.db.prepare(`UPDATE trades SET acknowledged_at=COALESCE(acknowledged_at,?),updated_at=?,version=version+1
      WHERE signal_id=? AND client_id=? AND assignment_token=?`).run(now(), now(), signalId, clientId, assignmentToken);
    if (result.changes !== 1) throw new ConflictError("INVALID_ASSIGNMENT", "Assignment does not belong to this client or token");
    return this.requiredTrade(signalId);
  }

  recordExecution(input: RecordExecutionInput): Trade {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT trade_id FROM executions WHERE id=? OR request_id=?").get(input.executionId, input.requestId) as { trade_id: string } | undefined;
      if (existing) return mapTrade(this.db.prepare("SELECT * FROM trades WHERE id=?").get(existing.trade_id) as Row);
      const trade = this.requiredTrade(input.signalId);
      if (trade.clientId !== input.clientId || trade.assignmentToken !== input.assignmentToken) throw new ConflictError("INVALID_ASSIGNMENT", "Invalid assignment token");
      if (trade.status === "CLOSED") throw new ConflictError("TRADE_ALREADY_CLOSED", "Trade is already closed");
      const timestamp = now();
      const orderTicket = nullableMt5Ticket(input.orderTicket);
      const dealTicket = nullableMt5Ticket(input.dealTicket);
      const positionTicket = nullableMt5Ticket(input.positionTicket);
      this.db.prepare(`INSERT INTO executions(id,trade_id,request_id,result,mt5_order_ticket,mt5_deal_ticket,mt5_position_ticket,
        requested_price,execution_price,requested_volume,executed_volume,retcode,error_code,error_description,broker_response_json,executed_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.executionId, trade.id, input.requestId, input.result, orderTicket,
        dealTicket, positionTicket, input.requestedPrice, input.executionPrice ?? null, input.requestedVolume,
        input.executedVolume ?? null, input.retcode ?? null, input.errorCode ?? null, input.errorDescription ?? null,
        json(input.brokerResponse), input.executedAt, timestamp);
      const tradeStatus = input.result === "REJECTED" ? "REJECTED" : input.result === "UNKNOWN" ? "UNKNOWN" : "FILLED";
      const signalStatus = input.result === "REJECTED" ? "REJECTED" : input.result === "UNKNOWN" ? "RECONCILIATION_REQUIRED" : "EXECUTED";
      this.db.prepare("UPDATE trades SET status=?,executed_at=?,updated_at=?,version=version+1 WHERE id=?")
        .run(tradeStatus, input.executedAt, timestamp, trade.id);
      this.setStatus(input.signalId, signalStatus, input.result === "REJECTED" ? { code: "BROKER_REJECTED", message: input.errorDescription ?? "Broker rejected order" } : undefined);
      if (tradeStatus === "FILLED") {
        const signal = this.findById(input.signalId)!;
        this.db.prepare(`INSERT INTO positions(id,trade_id,mt5_position_ticket,symbol,side,volume,open_price,stop_loss,take_profit,opened_at,status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(newId("POS"), trade.id, positionTicket, signal.symbol, signal.side,
          input.executedVolume ?? input.requestedVolume, input.executionPrice ?? input.requestedPrice, signal.stopLoss, signal.takeProfit, input.executedAt, "OPEN");
      }
      return this.requiredTrade(input.signalId);
    })();
  }

  recordClose(input: RecordCloseInput): Trade {
    return this.db.transaction(() => {
      const trade = this.requiredTrade(input.signalId);
      if (trade.clientId !== input.clientId || trade.assignmentToken !== input.assignmentToken) throw new ConflictError("INVALID_ASSIGNMENT", "Invalid assignment token");
      if (trade.status === "CLOSED") return trade;
      if (trade.status !== "FILLED") throw new ConflictError("TRADE_NOT_OPEN", "Trade has no confirmed open position");
      const result = this.db.prepare(`UPDATE positions SET close_price=?,gross_profit=?,commission=?,swap=?,net_profit=?,close_reason=?,closed_at=?,status='CLOSED'
        WHERE trade_id=? AND status='OPEN'`).run(input.closePrice, input.grossProfit, input.commission, input.swap, input.netProfit,
        input.closeReason, input.closedAt, trade.id);
      if (result.changes !== 1) throw new ConflictError("POSITION_NOT_OPEN", "No open position was found");
      this.db.prepare("UPDATE trades SET status='CLOSED',closed_at=?,updated_at=?,version=version+1 WHERE id=?").run(input.closedAt, now(), trade.id);
      this.setStatus(input.signalId, "CLOSED");
      return this.requiredTrade(input.signalId);
    })();
  }

  recordSlUpdate(input: RecordSlUpdateInput): Trade {
    return this.db.transaction(() => {
      const trade = this.requiredTrade(input.signalId);
      if (trade.clientId !== input.clientId || trade.assignmentToken !== input.assignmentToken) throw new ConflictError("INVALID_ASSIGNMENT", "Invalid assignment token");
      if (trade.status !== "FILLED") throw new ConflictError("TRADE_NOT_OPEN", "Trade has no confirmed open position");
      const result = this.db.prepare("UPDATE positions SET stop_loss=? WHERE trade_id=? AND status='OPEN'").run(input.newStopLoss, trade.id);
      if (result.changes !== 1) throw new ConflictError("POSITION_NOT_OPEN", "No open position was found");
      return trade;
    })();
  }

  findTradeBySignalId(signalId: string): Trade | null {
    const row = this.db.prepare("SELECT * FROM trades WHERE signal_id=?").get(signalId) as Row | undefined;
    return row ? mapTrade(row) : null;
  }

  countDailyTrades(dayStart: string, mode: TradingMode): number {
    return Number((this.db.prepare("SELECT COUNT(*) count FROM trades WHERE assigned_at>=? AND trading_mode=?")
      .get(dayStart, mode) as { count: number }).count);
  }

  realizedDailyLoss(dayStart: string, mode: TradingMode): string {
    const rows = this.db.prepare(`SELECT p.net_profit FROM positions p JOIN trades t ON t.id=p.trade_id
      WHERE p.status='CLOSED' AND p.closed_at>=? AND t.trading_mode=?`).all(dayStart, mode) as { net_profit: string }[];
    const total = rows.reduce((sum, row) => Decimal.min(new Decimal(row.net_profit), 0).abs().plus(sum), new Decimal(0));
    return total.toString();
  }

  countActiveTrades(): number {
    return Number((this.db.prepare("SELECT COUNT(*) count FROM trades WHERE status IN ('ASSIGNED','SUBMITTED','FILLED','UNKNOWN')").get() as { count: number }).count);
  }

  upsertContext(context: Mt5Context): void {
    this.db.prepare(`INSERT INTO mt5_clients(client_id,account_id,broker,currency,balance,equity,captured_at,context_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET account_id=excluded.account_id,broker=excluded.broker,
      currency=excluded.currency,balance=excluded.balance,equity=excluded.equity,captured_at=excluded.captured_at,
      context_json=excluded.context_json,updated_at=excluded.updated_at`).run(context.clientId, context.accountId, context.broker,
      context.currency, context.balance, context.equity, context.capturedAt, json(context), now());
  }

  findContext(clientId: string): Mt5Context | null {
    const row = this.db.prepare("SELECT context_json FROM mt5_clients WHERE client_id=?").get(clientId) as { context_json: string } | undefined;
    return row ? JSON.parse(row.context_json) as Mt5Context : null;
  }

  findLatestContext(): Mt5Context | null {
    const row = this.db.prepare("SELECT context_json FROM mt5_clients ORDER BY captured_at DESC LIMIT 1").get() as { context_json: string } | undefined;
    return row ? JSON.parse(row.context_json) as Mt5Context : null;
  }

  get(scope: string, key: string): { statusCode: number; body: unknown } | null {
    const row = this.db.prepare("SELECT status_code,response_json FROM idempotency_records WHERE scope=? AND key=?").get(scope, key) as { status_code: number; response_json: string } | undefined;
    return row ? { statusCode: row.status_code, body: JSON.parse(row.response_json) } : null;
  }

  put(scope: string, key: string, statusCode: number, body: unknown): void {
    this.db.prepare("INSERT OR IGNORE INTO idempotency_records(scope,key,status_code,response_json,created_at) VALUES(?,?,?,?,?)")
      .run(scope, key, statusCode, json(body), now());
  }

  recordEvent(eventType: string, fields: { signalId?: string; tradeId?: string; source?: string; status?: string; payload?: unknown }): void {
    this.db.prepare(`INSERT INTO system_events(id,event_type,signal_id,trade_id,source,status,payload_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(newId("EVT"), eventType, fields.signalId ?? null, fields.tradeId ?? null,
      fields.source ?? null, fields.status ?? null, json(fields.payload), now());
  }

  recordError(fields: { signalId?: string; tradeId?: string; code: string; message: string; details?: unknown }): void {
    this.db.prepare(`INSERT INTO errors(id,signal_id,trade_id,code,message,details_json,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(newId("ERR"), fields.signalId ?? null, fields.tradeId ?? null, fields.code, fields.message, json(fields.details), now());
  }

  private requiredTrade(signalId: string): Trade {
    const trade = this.findTradeBySignalId(signalId);
    if (!trade) throw new NotFoundError("Trade");
    return trade;
  }
}
