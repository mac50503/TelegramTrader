import { describe, expect, it } from "vitest";
import { signalAnalysisSchema } from "../src/agents/signal-schema.js";

describe("respuesta estructurada del agente", () => {
  it("acepta una señal JSON válida", () => {
    expect(signalAnalysisSchema.parse({ isSignal: true, symbol: "XAUUSD", side: "BUY", entry: 3345, stopLoss: 3335, takeProfit: 3370, confidence: 0.98 }))
      .toMatchObject({ isSignal: true, entry: "3345" });
  });
  it("acepta un mensaje que no es señal", () => expect(signalAnalysisSchema.parse({ isSignal: false })).toEqual({ isSignal: false }));
  it("rechaza JSON incompleto o con campos ejecutables", () => {
    expect(() => signalAnalysisSchema.parse({ isSignal: true, symbol: "XAUUSD", execute: "rm -rf" })).toThrow();
  });
});
