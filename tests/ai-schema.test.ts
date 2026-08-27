import { describe, expect, it } from "vitest";
import { signalAnalysisSchema } from "../src/agents/signal-schema.js";

describe("respuesta estructurada del agente", () => {
  it("conserva y ordena ambos extremos del rango", () => {
    expect(signalAnalysisSchema.parse({ isSignal: true, symbol: "XAUUSD", side: "BUY", entryMin: 4654, entryMax: 4650,
      stopLoss: 4645, takeProfit: 4660, confidence: 0.98 })).toMatchObject({ entry: "4650", entryMin: "4650", entryMax: "4654" });
  });
  it("acepta una señal JSON válida", () => {
    expect(signalAnalysisSchema.parse({ isSignal: true, symbol: "XAUUSD", side: "BUY", entry: 3345, stopLoss: 3335, takeProfit: 3370, confidence: 0.98 }))
      .toMatchObject({ isSignal: true, entry: "3345" });
  });
  it("acepta un mensaje que no es señal", () => expect(signalAnalysisSchema.parse({ isSignal: false })).toEqual({ isSignal: false }));
  it("rechaza JSON incompleto o con campos ejecutables", () => {
    expect(() => signalAnalysisSchema.parse({ isSignal: true, symbol: "XAUUSD", execute: "rm -rf" })).toThrow();
  });
});
