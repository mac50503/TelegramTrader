import type Database from "better-sqlite3";
import { Decimal } from "decimal.js";
import type {
  AuditRepository, ContextRepository, IdempotencyRepository, ManagementRepository, RecordCloseInput, RecordExecutionInput, RecordSlUpdateInput,
  SignalRepository, TradeRepository
} from "../application/ports.js";
import type { ManagementAction, ManagementInstruction, SignalAnalysis, SignalStatus, TelegramMessage, TradeSignal, TradingMode } from "../models/signal.js";
import type { ManagementCommand, Mt5Context, Trade, TradeAssignment } from "../models/trade.js";
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

export class SqliteRepositories implements SignalRepository, TradeRepository, ManagementRepository, ContextRepository, IdempotencyRepository, AuditRepository {
  constructor(private readonly db: Database.Database) {}

  createManagementFromTelegram(message: TelegramMessage, action: ManagementAction, symbolHint: string | null, explicitStopLoss: string | null): ManagementInstruction | null {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM management_instructions WHERE source=? AND telegram_chat_id=? AND telegram_message_id=?").get(message.source, message.chatId, message.messageId) as Row | undefined;
      if (existing) return null;
      const id = newId("MGT"); const timestamp = now();
      this.db.prepare(`INSERT INTO management_instructions(id,telegram_chat_id,telegram_message_id,source,chat_name,original_message,action,symbol_hint,explicit_stop_loss,status,received_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'PENDING_RESOLUTION',?,?,?)`).run(id,message.chatId,message.messageId,message.source,message.chatName,message.text,action,symbolHint,explicitStopLoss,message.timestamp,timestamp,timestamp);
      this.recordEvent("MANAGEMENT_RECEIVED", { source: message.source, status: "PENDING_RESOLUTION", payload: { instructionId: id, chatId: message.chatId, action } });
      return this.findManagementInstruction(id);
    })();
  }

  findOpenGroupsForChat(chatId: string): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT s.signal_group_id FROM trades t JOIN signals s ON s.id=t.signal_id JOIN positions p ON p.trade_id=t.id
      WHERE s.telegram_chat_id=? AND t.status='FILLED' AND p.status='OPEN' AND p.closed_at IS NULL AND s.signal_group_id IS NOT NULL ORDER BY s.signal_group_id`).all(chatId) as Row[];
    return rows.map((r) => String(r.signal_group_id));
  }

  countOpenTradesForGroup(groupId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) count FROM trades t JOIN signals s ON s.id=t.signal_id JOIN positions p ON p.trade_id=t.id
      WHERE s.signal_group_id=? AND t.status='FILLED' AND p.status='OPEN' AND p.closed_at IS NULL`).get(groupId) as { count: number };
    return row.count;
  }

  resolve(instructionId: string, groupId: string): ManagementInstruction {
    this.db.prepare("UPDATE management_instructions SET resolved_signal_group_id=?,status='RESOLVED',resolved_at=?,updated_at=?,version=version+1 WHERE id=?").run(groupId,now(),now(),instructionId);
    return this.findManagementInstruction(instructionId)!;
  }

  markAmbiguous(instructionId: string, candidateGroupIds: string[]): ManagementInstruction {
    this.db.prepare("UPDATE management_instructions SET status='AMBIGUOUS',rejection_reason=?,updated_at=?,version=version+1 WHERE id=?").run(`Multiple open groups: ${candidateGroupIds.join(",")}`,now(),instructionId);
    return this.findManagementInstruction(instructionId)!;
  }

  markRejected(instructionId: string, code: string, reason: string): ManagementInstruction {
    this.db.prepare("UPDATE management_instructions SET status='REJECTED',rejection_code=?,rejection_reason=?,updated_at=?,version=version+1 WHERE id=?").run(code,reason,now(),instructionId);
    return this.findManagementInstruction(instructionId)!;
  }

  createCommandsForGroup(instructionId: string, groupId: string, action: ManagementAction): ManagementCommand[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT t.id trade_id,t.client_id,t.status,s.leg_index,p.status position_status FROM trades t JOIN signals s ON s.id=t.signal_id LEFT JOIN positions p ON p.trade_id=t.id
        WHERE s.signal_group_id=? AND t.status IN ('FILLED','ASSIGNED','SUBMITTED') ORDER BY s.leg_index`).all(groupId) as Row[];
      const filled = rows.filter((r) => r.status === "FILLED" && r.position_status === "OPEN");
      const target = (action === "CLOSE_PARTIAL" || action === "TAKE_PARTIALS_AND_BREAKEVEN") ? filled[0]?.trade_id : null;
      const commands: ManagementCommand[] = [];
      for (const row of rows) {
        const isFilled = row.status === "FILLED" && row.position_status === "OPEN";
        if (!isFilled) continue;
        const type = action === "MOVE_SL_TO_BREAKEVEN" || (action === "TAKE_PARTIALS_AND_BREAKEVEN" && row.trade_id !== target) ? "MOVE_SL_TO_BREAKEVEN" : "CLOSE";
        const id = newId("MGC"); const timestamp = now();
        this.db.prepare("INSERT INTO management_commands(id,instruction_id,trade_id,type,status,created_at,updated_at) VALUES(?,?,?,?,'PENDING',?,?)").run(id,instructionId,row.trade_id,type,timestamp,timestamp);
        commands.push(this.findManagementCommand(id)!);
      }
      this.db.prepare("UPDATE management_instructions SET status='APPLIED',applied_at=?,updated_at=?,version=version+1 WHERE id=?").run(now(),now(),instructionId);
      return commands;
    })();
  }

  findPendingCommand(tradeId: string): ManagementCommand | null {
    const row = this.db.prepare("SELECT * FROM management_commands WHERE trade_id=? AND status='PENDING' ORDER BY created_at LIMIT 1").get(tradeId) as Row | undefined;
    return row ? this.mapManagementCommand(row) : null;
  }

  recordCommandResult(commandId: string, clientId: string, status: "APPLIED" | "REJECTED" | "UNKNOWN", details?: { code?: string; description?: string }): ManagementCommand {
    const row = this.db.prepare("SELECT c.*,t.client_id FROM management_commands c JOIN trades t ON t.id=c.trade_id WHERE c.id=?").get(commandId) as Row | undefined;
    if (!row || String(row.client_id) !== clientId) throw new ConflictError("INVALID_ASSIGNMENT", "Management command does not belong to this client");
    this.db.prepare("UPDATE management_commands SET status=?,result_code=?,result_description=?,updated_at=?,version=version+1 WHERE id=?").run(status,details?.code ?? null,details?.description ?? null,now(),commandId);
    return this.findManagementCommand(commandId)!;
  }

  private findManagementInstruction(id: string): ManagementInstruction | null {
    const r = this.db.prepare("SELECT * FROM management_instructions WHERE id=?").get(id) as Row | undefined; if (!r) return null;
    return { id:String(r.id),telegramChatId:String(r.telegram_chat_id),telegramMessageId:String(r.telegram_message_id),source:String(r.source),chatName:String(r.chat_name),originalMessage:String(r.original_message),action:r.action as ManagementAction,symbolHint:r.symbol_hint === null ? null : String(r.symbol_hint),explicitStopLoss:r.explicit_stop_loss === null ? null : String(r.explicit_stop_loss),resolvedSignalGroupId:r.resolved_signal_group_id === null ? null : String(r.resolved_signal_group_id),status:r.status as ManagementInstruction["status"],rejectionCode:r.rejection_code === null ? null : String(r.rejection_code),rejectionReason:r.rejection_reason === null ? null : String(r.rejection_reason),receivedAt:String(r.received_at),resolvedAt:r.resolved_at === null ? null : String(r.resolved_at),appliedAt:r.applied_at === null ? null : String(r.applied_at),createdAt:String(r.created_at),updatedAt:String(r.updated_at),version:Number(r.version)};
  }
  private findManagementCommand(id: string): ManagementCommand | null { const r=this.db.prepare("SELECT * FROM management_commands WHERE id=?").get(id) as Row|undefined; return r ? this.mapManagementCommand(r) : null; }
  private mapManagementCommand(r: Row): ManagementCommand { return { id:String(r.id),instructionId:String(r.instruction_id),tradeId:String(r.trade_id),type:r.type as ManagementCommand["type"],status:r.status as ManagementCommand["status"],resultCode:r.result_code===null?null:String(r.result_code),resultDescription:r.result_description===null?null:String(r.result_description),createdAt:String(r.created_at),updatedAt:String(r.updated_at) }; }

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
    const detected = ("isSignal" in analysis && analysis.isSignal) || ("intent" in analysis && analysis.intent === "NEW_SIGNAL") ? analysis : null;
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
        // Sibling legs share the same Telegram message, but the legacy schema enforces
        // uniqueness on (source, chat, message). Derive a stable per-leg message key while
        // retaining the original message text and signal_group_id for traceability.
        id, parent.telegramChatId, `${parent.telegramMessageId}-TP${legIndex + 1}`, parent.source, parent.chatName, parent.originalMessage, parent.aiResultJson,
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
    return Boolean(this.db.prepare(`SELECT 1 FROM signals WHERE id<>? AND COALESCE(signal_group_id,id)<>? AND source=? AND symbol=? AND side=?
      AND COALESCE(entry_min,entry)=? AND COALESCE(entry_max,entry)=? AND stop_loss=?
      AND take_profit=? AND received_at>=? AND status NOT IN ('IGNORED','REJECTED','ERROR') LIMIT 1`)
      .get(signal.id, signal.signalGroupId ?? signal.id, signal.source, signal.symbol, signal.side,
        signal.entryMin, signal.entryMax, signal.stopLoss, signal.takeProfit, since));
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
    const assignment = { signalId: String(row.id), tradeId: String(row.trade_id), assignmentToken: String(row.assignment_token),
      mode: row.trading_mode as TradeAssignment["mode"], symbol: String(row.symbol), side: row.side as TradeAssignment["side"],
      entry: String(row.entry), entryMin: String(entryMin), entryMax: String(entryMax),
      stopLoss: String(row.stop_loss), takeProfit: String(row.take_profit), volume: String(row.approved_lot),
      expiresAt: String(row.expires_at),
      groupId: String(row.signal_group_id ?? row.id), legIndex: Number(row.leg_index ?? 0), legCount: Number(row.leg_count ?? 1) };
    const command = this.findPendingCommand(String(row.trade_id));
    if (!command) return assignment;
    const instruction = this.db.prepare("SELECT action FROM management_instructions WHERE id=?")
      .get(command.instructionId) as { action: ManagementAction };
    return { ...assignment, managementCommand: { commandId: command.id, type: command.type,
      requiresProfit: command.type === "CLOSE" && instruction.action === "TAKE_PARTIALS_AND_BREAKEVEN",
      idempotencyKey: `mgmt-command-result:${command.id}` } };
  }

  acknowledge(signalId: string, clientId: string, assignmentToken: string): Trade {
    const result = this.db.prepare(`UPDATE trades SET acknowledged_at=COALESCE(acknowledged_at,?),updated_at=?,version=version+1
      WHERE signal_id=? AND client_id=? AND assignment_token=?`).run(now(), now(), signalId, clientId, assignmentToken);
    if (result.changes !== 1) throw new ConflictError("INVALID_ASSIGNMENT", "Assignment does not belong to this client or token");
    return this.requiredTrade(signalId);
  }

  cancel(signalId: string, clientId: string): Trade {
    const trade = this.requiredTrade(signalId);
    if (trade.clientId !== clientId) throw new ConflictError("INVALID_ASSIGNMENT", "Trade does not belong to this client");
    if (!["ASSIGNED", "SUBMITTED"].includes(trade.status)) throw new ConflictError("TRADE_NOT_CANCELABLE", "Only unfilled trades can be canceled");
    const timestamp = now();
    this.db.prepare("UPDATE trades SET status='CANCELED',updated_at=?,version=version+1 WHERE signal_id=? AND client_id=? AND status IN ('ASSIGNED','SUBMITTED')")
      .run(timestamp, signalId, clientId);
    this.setStatus(signalId, "REJECTED", { code: "ADMIN_CANCELED", message: "Canceled administratively before execution" });
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
    // Count only orders that reached the broker/simulator. Rejected assignments and
    // expired pending entries never became positions, so they must not consume the
    // daily execution limit. UNKNOWN remains conservative because the broker may
    // have filled the order even though MT5 could not resolve its position ticket.
    return Number((this.db.prepare(`SELECT COUNT(DISTINCT t.id) count
      FROM trades t JOIN executions e ON e.trade_id=t.id
      WHERE e.executed_at>=? AND t.trading_mode=?
        AND e.result IN ('FILLED','SIMULATED_EXECUTION','UNKNOWN')`)
      .get(dayStart, mode) as { count: number }).count);
  }

  realizedDailyLoss(dayStart: string, mode: TradingMode): string {
    const rows = this.db.prepare(`SELECT p.net_profit FROM positions p JOIN trades t ON t.id=p.trade_id
      WHERE p.status='CLOSED' AND p.closed_at>=? AND t.trading_mode=? AND COALESCE(p.close_reason,'')<>'ADMIN_REVIEW'`).all(dayStart, mode) as { net_profit: string }[];
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
