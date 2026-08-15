import type { TradeSide, TradingMode } from "./signal.js";

export type TradeStatus = "ASSIGNED" | "SUBMITTED" | "FILLED" | "REJECTED" | "CLOSED" | "UNKNOWN";
export type ExecutionResult = "SIMULATED_EXECUTION" | "FILLED" | "REJECTED" | "UNKNOWN";

export interface Trade {
  id: string;
  signalId: string;
  clientId: string;
  assignmentToken: string;
  status: TradeStatus;
  tradingMode: TradingMode;
  assignedAt: string;
  acknowledgedAt: string | null;
  executedAt: string | null;
  closedAt: string | null;
}

export interface TradeAssignment {
  signalId: string;
  tradeId: string;
  assignmentToken: string;
  mode: TradingMode;
  symbol: string;
  side: TradeSide;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  volume: string;
  expiresAt: string;
}

export interface Mt5Context {
  clientId: string;
  accountId: string;
  broker: string;
  currency: string;
  balance: string;
  equity: string;
  capturedAt: string;
  symbols: SymbolSpecification[];
}

export interface SymbolSpecification {
  canonicalSymbol: string;
  brokerSymbol: string;
  digits: number;
  point: string;
  tickSize: string;
  tickValueProfit: string;
  tickValueLoss: string;
  contractSize: string;
  volumeMin: string;
  volumeMax: string;
  volumeStep: string;
}
