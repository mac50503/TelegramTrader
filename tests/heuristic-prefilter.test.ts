import { describe, expect, it } from "vitest";
import { looksLikeTradingSignal, PrefilteredSignalAnalyzer } from "../src/agents/heuristic-prefilter.js";
import type { SignalAnalyzer } from "../src/application/ports.js";
import { createLogger } from "../src/logging/logger.js";
import { testConfig } from "./helpers.js";

const logger = createLogger(testConfig());

describe("looksLikeTradingSignal", () => {
  it.each([
    "Good morning everyone",
    "gm guys",
    "thanks for the update",
    "😂😂😂",
    "how is everyone doing today"
  ])("rechaza charla obvia sin relación a trading: %s", (text) => {
    expect(looksLikeTradingSignal(text)).toBe(false);
  });

  it.each([
    "BUY XAUUSD ENTRY=3345 SL=3335 TP=3370",
    "sell eurusd now sl 1.2050 tp 1.1980",
    "Long US30 target 39500",
    "3345 3335"
  ])("deja pasar mensajes con posible señal: %s", (text) => {
    expect(looksLikeTradingSignal(text)).toBe(true);
  });
});

describe("PrefilteredSignalAnalyzer", () => {
  const message = { chatId: "1", messageId: "1", timestamp: new Date().toISOString(), chatName: "Signals", source: "TELEGRAM" as const };

  it("no llama al analizador interno cuando el mensaje es obviamente charla", async () => {
    const inner: SignalAnalyzer = { analyze: () => { throw new Error("no debería llamarse"); } };
    const prefilter = new PrefilteredSignalAnalyzer(inner, logger);
    const result = await prefilter.analyze({ ...message, text: "Good morning everyone" }, "SIG-1");
    expect(result).toEqual({ isSignal: false });
  });

  it("delega al analizador interno cuando el mensaje parece una señal", async () => {
    const expected = { isSignal: true as const, symbol: "XAUUSD", side: "BUY" as const, entry: "3345",
      entryMin: "3345", entryMax: "3345", stopLoss: "3335", takeProfit: "3370", confidence: 0.98 };
    const inner: SignalAnalyzer = { analyze: async () => expected };
    const prefilter = new PrefilteredSignalAnalyzer(inner, logger);
    const result = await prefilter.analyze({ ...message, text: "BUY XAUUSD ENTRY=3345 SL=3335 TP=3370" }, "SIG-2");
    expect(result).toEqual(expected);
  });
});
