export const signalStatuses = [
  "RECEIVED", "ANALYZING", "IGNORED", "VALIDATED", "QUEUED", "ASSIGNED",
  "EXECUTED", "CLOSED", "REJECTED", "EXPIRED", "ERROR", "RECONCILIATION_REQUIRED"
] as const;

export type SignalStatus = (typeof signalStatuses)[number];
export type TradeSide = "BUY" | "SELL";
export type TradingMode = "SIMULATION" | "LIVE";
export const managementActions = ["TAKE_PARTIALS_AND_BREAKEVEN", "CLOSE_ALL", "MOVE_SL_TO_BREAKEVEN", "CLOSE_PARTIAL"] as const;
export type ManagementAction = (typeof managementActions)[number];
export const managementInstructionStatuses = ["PENDING_RESOLUTION", "RESOLVED", "AMBIGUOUS", "APPLIED", "REJECTED", "ERROR"] as const;
export type ManagementInstructionStatus = (typeof managementInstructionStatuses)[number];

export interface TelegramMessage {
  chatId: string;
  messageId: string;
  timestamp: string;
  text: string;
  chatName: string;
  source: "TELEGRAM";
}

export interface ManagementInstruction {
  id: string; telegramChatId: string; telegramMessageId: string; source: string; chatName: string;
  originalMessage: string; action: ManagementAction; symbolHint: string | null; explicitStopLoss: string | null;
  resolvedSignalGroupId: string | null; status: ManagementInstructionStatus; rejectionCode: string | null;
  rejectionReason: string | null; receivedAt: string; resolvedAt: string | null; appliedAt: string | null;
  createdAt: string; updatedAt: string; version: number;
}

export type LegacySignalAnalysis =
  | { isSignal: false }
  | {
      isSignal: true;
      symbol: string;
      side: TradeSide;
      entry: string;
      entryMin: string;
      entryMax: string;
      stopLoss: string;
      takeProfits: string[];
      lot?: string | undefined;
      riskPercentage?: string | undefined;
      confidence: number;
    }
  ;
export type NewSignalAnalysis = { intent: "NEW_SIGNAL"; symbol: string; side: TradeSide; entry: string; entryMin: string; entryMax: string; stopLoss: string; takeProfits: string[]; lot?: string | undefined; riskPercentage?: string | undefined; confidence: number };
export type SignalAnalysis = LegacySignalAnalysis | NewSignalAnalysis | { intent: "NONE" } | { intent: "MANAGEMENT"; action: ManagementAction; symbolHint: string | null; explicitStopLoss: string | null; confidence: number };

export interface TradeSignal {
  id: string;
  telegramChatId: string;
  telegramMessageId: string;
  source: string;
  chatName: string;
  originalMessage: string;
  aiResultJson: string | null;
  validationResultJson: string | null;
  symbol: string | null;
  side: TradeSide | null;
  entry: string | null;
  entryMin: string | null;
  entryMax: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  requestedLot: string | null;
  signalGroupId: string | null;
  legIndex: number;
  legCount: number;
  approvedLot: string | null;
  riskPercentage: string | null;
  confidence: number | null;
  receivedAt: string;
  expiresAt: string;
  status: SignalStatus;
  rejectionCode: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
