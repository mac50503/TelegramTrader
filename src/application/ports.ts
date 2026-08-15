import type { TelegramMessage, SignalAnalysis, TradeSignal, SignalStatus } from "../models/signal.js";
import type { Mt5Context, Trade, TradeAssignment } from "../models/trade.js";

export interface TelegramAdapter {
  start(onMessage: (message: TelegramMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

export interface SignalAnalyzer {
  analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis>;
}

export interface SignalRepository {
  createFromTelegram(message: TelegramMessage, expiresAt: string): TradeSignal | null;
  findById(id: string): TradeSignal | null;
  list(limit: number, offset: number, status?: SignalStatus): TradeSignal[];
  setStatus(id: string, status: SignalStatus, reason?: { code: string; message: string }): void;
  saveAnalysis(id: string, analysis: SignalAnalysis): void;
  saveValidated(id: string, approvedLot: string, validationJson: string): void;
  hasSemanticDuplicate(signal: TradeSignal, since: string): boolean;
}

export interface TradeRepository {
  assignNext(clientId: string, mode: "SIMULATION" | "LIVE"): TradeAssignment | null;
  currentAssignment(clientId: string): TradeAssignment | null;
  acknowledge(signalId: string, clientId: string, assignmentToken: string): Trade;
  recordExecution(input: RecordExecutionInput): Trade;
  recordClose(input: RecordCloseInput): Trade;
  findTradeBySignalId(signalId: string): Trade | null;
  countDailyTrades(dayStart: string): number;
  realizedDailyLoss(dayStart: string): string;
  countActiveTrades(): number;
}

export interface ContextRepository {
  upsertContext(context: Mt5Context): void;
  findContext(clientId: string): Mt5Context | null;
  findLatestContext(): Mt5Context | null;
}

export interface IdempotencyRepository {
  get(scope: string, key: string): { statusCode: number; body: unknown } | null;
  put(scope: string, key: string, statusCode: number, body: unknown): void;
}

export interface AuditRepository {
  recordEvent(eventType: string, fields: { signalId?: string; tradeId?: string; source?: string; status?: string; payload?: unknown }): void;
  recordError(fields: { signalId?: string; tradeId?: string; code: string; message: string; details?: unknown }): void;
}

export interface RecordExecutionInput {
  signalId: string;
  clientId: string;
  assignmentToken: string;
  executionId: string;
  requestId: string;
  result: "SIMULATED_EXECUTION" | "FILLED" | "REJECTED" | "UNKNOWN";
  requestedPrice: string;
  executionPrice?: string | undefined;
  requestedVolume: string;
  executedVolume?: string | undefined;
  orderTicket?: string | undefined;
  dealTicket?: string | undefined;
  positionTicket?: string | undefined;
  retcode?: string | undefined;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  brokerResponse?: unknown | undefined;
  executedAt: string;
}

export interface RecordCloseInput {
  signalId: string;
  clientId: string;
  assignmentToken: string;
  closePrice: string;
  grossProfit: string;
  commission: string;
  swap: string;
  netProfit: string;
  closeReason: string;
  closedAt: string;
}
