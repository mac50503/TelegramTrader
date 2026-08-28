import { describe, expect, it } from "vitest";
import { SignalValidator } from "../src/signals/signal-validator.js";
import type { TradeSignal } from "../src/models/signal.js";
import { testConfig } from "./helpers.js";

function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  const now = new Date();
  return {
    id: "SIG-TEST", telegramChatId: "1", telegramMessageId: "1", source: "TELEGRAM", chatName: "Test",
    originalMessage: "BUY XAUUSD", aiResultJson: null, validationResultJson: null, symbol: "XAUUSD", side: "BUY",
    entry: "3345", entryMin: "3345", entryMax: "3345", stopLoss: "3335", takeProfit: "3370", requestedLot: "0.1", approvedLot: null,
    riskPercentage: null, confidence: 0.98, receivedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    status: "ANALYZING", rejectionCode: null, rejectionReason: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), version: 1,
    signalGroupId: "SIG-TEST", legIndex: 0, legCount: 1,
    ...overrides
  };
}

describe("SignalValidator", () => {
  const validator = new SignalValidator(testConfig());
  it("acepta un rango BUY completo", () => expect(validator.validate(signal({ entryMin: "3345", entryMax: "3350" }))).toEqual({ valid: true }));
  it("rechaza un TP dentro del rango BUY", () => expect(validator.validate(signal({ entryMin: "3345", entryMax: "3375" }))).toMatchObject({ valid: false, code: "INVALID_TAKE_PROFIT" }));
  it("acepta una señal BUY válida", () => expect(validator.validate(signal())).toEqual({ valid: true }));
  it("acepta una señal SELL válida", () => expect(validator.validate(signal({ side: "SELL", stopLoss: "3355", takeProfit: "3300" }))).toEqual({ valid: true }));
  it("rechaza SL incorrecto para BUY", () => expect(validator.validate(signal({ stopLoss: "3350" }))).toMatchObject({ valid: false, code: "INVALID_STOP_LOSS" }));
  it("rechaza TP incorrecto para SELL", () => expect(validator.validate(signal({ side: "SELL", stopLoss: "3355", takeProfit: "3400" }))).toMatchObject({ valid: false, code: "INVALID_TAKE_PROFIT" }));
  it("rechaza símbolo inválido", () => expect(validator.validate(signal({ symbol: "<script>" }))).toMatchObject({ valid: false, code: "INVALID_SYMBOL" }));
  it("rechaza una señal expirada", () => expect(validator.validate(signal({ expiresAt: "2020-01-01T00:00:00.000Z" }))).toMatchObject({ valid: false, code: "SIGNAL_EXPIRED" }));
  it("rechaza lot y riesgo simultáneos", () => expect(validator.validate(signal({ riskPercentage: "1" }))).toMatchObject({ valid: false, code: "AMBIGUOUS_RISK" }));
});
