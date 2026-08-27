import { describe, expect, it } from "vitest";
import { RiskEngine } from "../src/risk/risk-engine.js";
import type { TradeSignal } from "../src/models/signal.js";
import { mt5Context, testConfig } from "./helpers.js";

function baseSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  const timestamp = new Date().toISOString();
  return { id: "SIG-1", telegramChatId: "1", telegramMessageId: "1", source: "TELEGRAM", chatName: "Test", originalMessage: "",
    aiResultJson: null, validationResultJson: null, symbol: "XAUUSD", side: "BUY", entry: "100", entryMin: "100", entryMax: "100",
    stopLoss: "99", takeProfit: "102",
    requestedLot: null, approvedLot: null, riskPercentage: "1", confidence: 1, receivedAt: timestamp,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), status: "VALIDATED", rejectionCode: null, rejectionReason: null,
    createdAt: timestamp, updatedAt: timestamp, version: 1, ...overrides };
}

describe("RiskEngine", () => {
  it("calcula volumen por porcentaje y lo redondea al step", () => {
    const context = mt5Context();
    const decision = new RiskEngine(testConfig()).evaluate(baseSignal(), context, context.symbols[0]!);
    expect(decision).toMatchObject({ approved: true, volume: "1", policy: "RISK_PERCENTAGE", estimatedLoss: "100" });
  });
  it("respeta fixed lot", () => {
    const context = mt5Context();
    const decision = new RiskEngine(testConfig()).evaluate(baseSignal({ requestedLot: "0.25", riskPercentage: null }), context, context.symbols[0]!);
    expect(decision).toMatchObject({ approved: true, volume: "0.25", policy: "FIXED_LOT" });
  });
  it("usa el extremo de mayor perdida del rango", () => {
    const context = mt5Context();
    const decision = new RiskEngine(testConfig()).evaluate(baseSignal({ entryMin: "100", entryMax: "101", riskPercentage: "1" }), context, context.symbols[0]!);
    expect(decision).toMatchObject({ approved: true, volume: "0.5", estimatedLoss: "100" });
  });
  it("rechaza riesgo superior al límite", () => {
    const context = mt5Context();
    const decision = new RiskEngine(testConfig()).evaluate(baseSignal({ riskPercentage: "3" }), context, context.symbols[0]!);
    expect(decision).toMatchObject({ approved: false, code: "RISK_LIMIT_EXCEEDED" });
  });
  it("no asume tick value válido", () => {
    const context = mt5Context();
    const spec = { ...context.symbols[0]!, tickValueLoss: "0" };
    expect(new RiskEngine(testConfig()).evaluate(baseSignal(), context, spec)).toMatchObject({ approved: false, code: "INVALID_SYMBOL_SPEC" });
  });
});
