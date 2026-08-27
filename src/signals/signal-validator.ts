import { Decimal } from "decimal.js";
import type { AppConfig } from "../config/config.js";
import type { TradeSignal } from "../models/signal.js";
import { isPositiveDecimal as positive } from "../shared/decimal.js";

export type ValidationResult = { valid: true } | { valid: false; code: string; reason: string };

export class SignalValidator {
  constructor(private readonly config: AppConfig) {}

  validate(signal: TradeSignal, currentTime = new Date()): ValidationResult {
    if (currentTime.getTime() >= Date.parse(signal.expiresAt)) return { valid: false, code: "SIGNAL_EXPIRED", reason: "Signal has expired" };
    if (!signal.symbol || !/^[A-Z][A-Z0-9._-]{2,29}$/.test(signal.symbol.toUpperCase())) {
      return { valid: false, code: "INVALID_SYMBOL", reason: "Symbol is missing or invalid" };
    }
    if (signal.side !== "BUY" && signal.side !== "SELL") return { valid: false, code: "INVALID_SIDE", reason: "Side must be BUY or SELL" };
    if (!positive(signal.entryMin) || !positive(signal.entryMax) || !positive(signal.stopLoss) || !positive(signal.takeProfit)) {
      return { valid: false, code: "INVALID_PRICE", reason: "Entry range, stop loss and take profit must be positive decimals" };
    }
    const entryMin = new Decimal(signal.entryMin!);
    const entryMax = new Decimal(signal.entryMax!);
    const stopLoss = new Decimal(signal.stopLoss!);
    const takeProfit = new Decimal(signal.takeProfit!);
    if (entryMin.gt(entryMax)) return { valid: false, code: "INVALID_ENTRY_RANGE", reason: "Entry minimum cannot exceed entry maximum" };
    if (signal.side === "BUY" && !stopLoss.lt(entryMin)) return { valid: false, code: "INVALID_STOP_LOSS", reason: "BUY stop loss must be below the complete entry range" };
    if (signal.side === "BUY" && !takeProfit.gt(entryMax)) return { valid: false, code: "INVALID_TAKE_PROFIT", reason: "BUY take profit must be above the complete entry range" };
    if (signal.side === "SELL" && !stopLoss.gt(entryMax)) return { valid: false, code: "INVALID_STOP_LOSS", reason: "SELL stop loss must be above the complete entry range" };
    if (signal.side === "SELL" && !takeProfit.lt(entryMin)) return { valid: false, code: "INVALID_TAKE_PROFIT", reason: "SELL take profit must be below the complete entry range" };
    if (signal.confidence === null || signal.confidence < this.config.ai.minConfidence) {
      return { valid: false, code: "LOW_CONFIDENCE", reason: `Confidence must be at least ${this.config.ai.minConfidence}` };
    }
    if (signal.requestedLot && signal.riskPercentage) return { valid: false, code: "AMBIGUOUS_RISK", reason: "Specify lot or risk percentage, not both" };
    if (signal.requestedLot && !positive(signal.requestedLot)) return { valid: false, code: "INVALID_LOT", reason: "Lot must be positive" };
    if (signal.riskPercentage && !positive(signal.riskPercentage)) return { valid: false, code: "INVALID_RISK", reason: "Risk percentage must be positive" };
    return { valid: true };
  }
}
