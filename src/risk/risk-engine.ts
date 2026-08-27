import { Decimal } from "decimal.js";
import type { AppConfig } from "../config/config.js";
import type { TradeSignal } from "../models/signal.js";
import type { Mt5Context, SymbolSpecification } from "../models/trade.js";
import { floorToStep } from "../shared/decimal.js";

export type RiskDecision =
  | { approved: true; volume: string; riskAmount: string; estimatedLoss: string; policy: "FIXED_LOT" | "RISK_PERCENTAGE" }
  | { approved: false; code: string; reason: string };

export class RiskEngine {
  constructor(private readonly config: AppConfig) {}

  evaluate(signal: TradeSignal, context: Mt5Context, spec: SymbolSpecification): RiskDecision {
    if (!signal.entryMin || !signal.entryMax || !signal.stopLoss) return { approved: false, code: "MISSING_PRICE", reason: "Entry range and stop loss are required" };
    try {
      const entry = new Decimal(signal.side === "BUY" ? signal.entryMax : signal.entryMin);
      const stop = new Decimal(signal.stopLoss);
      const tickSize = new Decimal(spec.tickSize);
      const tickValueLoss = new Decimal(spec.tickValueLoss);
      const min = new Decimal(spec.volumeMin);
      const brokerMax = new Decimal(spec.volumeMax);
      const step = new Decimal(spec.volumeStep);
      const configuredMax = new Decimal(this.config.risk.maxLot);
      if (!tickSize.gt(0) || !tickValueLoss.gt(0) || !step.gt(0)) {
        return { approved: false, code: "INVALID_SYMBOL_SPEC", reason: "Tick size, loss tick value and volume step must be positive" };
      }
      const lossPerLot = entry.minus(stop).abs().div(tickSize).mul(tickValueLoss);
      if (!lossPerLot.gt(0)) return { approved: false, code: "INVALID_STOP_DISTANCE", reason: "Stop distance cannot be zero" };
      let rawVolume: Decimal;
      let riskAmount: Decimal;
      let policy: "FIXED_LOT" | "RISK_PERCENTAGE";
      if (signal.requestedLot) {
        policy = "FIXED_LOT";
        rawVolume = new Decimal(signal.requestedLot);
        riskAmount = rawVolume.mul(lossPerLot);
      } else if (signal.riskPercentage) {
        policy = "RISK_PERCENTAGE";
        const percent = new Decimal(signal.riskPercentage);
        if (percent.gt(this.config.risk.maxRiskPercentage)) return { approved: false, code: "RISK_LIMIT_EXCEEDED", reason: "Risk percentage exceeds configured maximum" };
        riskAmount = new Decimal(context.balance).mul(percent).div(100);
        rawVolume = riskAmount.div(lossPerLot);
      } else {
        policy = "FIXED_LOT";
        rawVolume = new Decimal(this.config.risk.defaultFixedLot);
        riskAmount = rawVolume.mul(lossPerLot);
      }
      const volume = floorToStep(rawVolume, step);
      if (volume.lt(min)) return { approved: false, code: "VOLUME_BELOW_MINIMUM", reason: "Risk-based volume is below broker minimum" };
      if (volume.gt(brokerMax) || volume.gt(configuredMax)) return { approved: false, code: "MAX_LOT_EXCEEDED", reason: "Volume exceeds broker or configured maximum" };
      const estimatedLoss = volume.mul(lossPerLot);
      const actualPercent = estimatedLoss.div(context.balance).mul(100);
      if (actualPercent.gt(this.config.risk.maxRiskPercentage)) return { approved: false, code: "RISK_LIMIT_EXCEEDED", reason: "Estimated loss exceeds maximum risk percentage" };
      return { approved: true, volume: volume.toString(), riskAmount: riskAmount.toString(), estimatedLoss: estimatedLoss.toString(), policy };
    } catch {
      return { approved: false, code: "RISK_CALCULATION_ERROR", reason: "Risk inputs are not valid decimals" };
    }
  }
}
