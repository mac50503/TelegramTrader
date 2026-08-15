export const signalStatuses = [
  "RECEIVED", "ANALYZING", "IGNORED", "VALIDATED", "QUEUED", "ASSIGNED",
  "EXECUTED", "CLOSED", "REJECTED", "EXPIRED", "ERROR", "RECONCILIATION_REQUIRED"
] as const;

export type SignalStatus = (typeof signalStatuses)[number];
export type TradeSide = "BUY" | "SELL";
export type TradingMode = "SIMULATION" | "LIVE";

export interface TelegramMessage {
  chatId: string;
  messageId: string;
  timestamp: string;
  text: string;
  chatName: string;
  source: "TELEGRAM";
}

export type SignalAnalysis =
  | { isSignal: false }
  | {
      isSignal: true;
      symbol: string;
      side: TradeSide;
      entry: string;
      stopLoss: string;
      takeProfit: string;
      lot?: string | undefined;
      riskPercentage?: string | undefined;
      confidence: number;
    };

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
  stopLoss: string | null;
  takeProfit: string | null;
  requestedLot: string | null;
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
