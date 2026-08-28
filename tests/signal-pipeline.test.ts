import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { SignalAnalyzer } from "../src/application/ports.js";
import { openDatabase } from "../src/database/database.js";
import { createLogger } from "../src/logging/logger.js";
import { SqliteRepositories } from "../src/repositories/sqlite-repositories.js";
import { SignalPipeline } from "../src/services/signal-pipeline.js";
import { mt5Context, testConfig } from "./helpers.js";

describe("SignalPipeline: expansión multi-TP", () => {
  const config = testConfig();
  let db: Database.Database;
  let repo: SqliteRepositories;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repo = new SqliteRepositories(db);
    repo.upsertContext(mt5Context());
  });
  afterEach(() => db.close());

  function buildPipeline(takeProfits: string[]): SignalPipeline {
    const analyzer: SignalAnalyzer = { async analyze() {
      return { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "100", entryMin: "100", entryMax: "100",
        stopLoss: "99", takeProfits, lot: "0.1", confidence: 0.9 };
    } };
    return new SignalPipeline(config, repo, repo, repo, analyzer, createLogger(config), repo);
  }

  it("genera una señal hermana por cada TP adicional y las encola de forma independiente", async () => {
    const pipeline = buildPipeline(["101", "102", "103"]);
    const original = await pipeline.ingest({
      chatId: "1", messageId: "1", timestamp: new Date().toISOString(),
      text: "BUY XAUUSD TP1 101 TP2 102 TP3 103", chatName: "Signals", source: "TELEGRAM"
    });
    expect(original?.status).toBe("QUEUED");
    expect(original?.legIndex).toBe(0);
    expect(original?.legCount).toBe(3);
    expect(original?.takeProfit).toBe("101");

    const siblings = repo.list(100, 0)
      .filter((signal) => signal.signalGroupId === original?.id && signal.id !== original?.id)
      .sort((a, b) => a.legIndex - b.legIndex);
    expect(siblings).toHaveLength(2);
    expect(siblings.map((signal) => signal.legIndex)).toEqual([1, 2]);
    expect(siblings.map((signal) => signal.takeProfit)).toEqual(["102", "103"]);
    expect(siblings.every((signal) => signal.status === "QUEUED")).toBe(true);
    expect(siblings.every((signal) => signal.entry === "100" && signal.stopLoss === "99")).toBe(true);
  });

  it("no genera hermanas cuando la señal trae un solo TP", async () => {
    const pipeline = buildPipeline(["101"]);
    const original = await pipeline.ingest({
      chatId: "1", messageId: "1", timestamp: new Date().toISOString(),
      text: "BUY XAUUSD", chatName: "Signals", source: "TELEGRAM"
    });
    expect(original?.legCount).toBe(1);
    expect(repo.list(100, 0)).toHaveLength(1);
  });

  describe("mensaje real de Telegram: GOLD SELL con TP1-TP3 y TP4=Hold", () => {
    // Extracción capturada de una corrida real contra `claude -p` (modelo haiku) usando el
    // system prompt/json-schema actuales de prompt-builder.ts para este mensaje exacto:
    //
    // 7. GOLD SELL SETUP
    // Gold Sell Zone 4402 - 4407
    // SL: 4413
    // TP1 : 4397
    // TP2: 4392
    // TP3:4387
    // TP4 : Hold
    // & Use suitable lot sizes based on your capital. Money management is key to long term success
    //
    // El modelo normalizó GOLD->XAUUSD, ordenó los TPs de más cercano a más lejano para SELL
    // (descendente) e ignoró TP4 ("Hold" no es un precio).
    const MESSAGE_TEXT = "7. GOLD SELL SETUP\nGold Sell Zone 4402 - 4407\nSL: 4413\nTP1 : 4397\nTP2: 4392\nTP3:4387\n"
      + "TP4 : Hold\n& Use suitable lot sizes based on your capital. Money management is key to long term success";

    function buildRealFixturePipeline(): SignalPipeline {
      const analyzer: SignalAnalyzer = { async analyze() {
        return { isSignal: true, symbol: "XAUUSD", side: "SELL", entry: "4407", entryMin: "4402", entryMax: "4407",
          stopLoss: "4413", takeProfits: ["4397", "4392", "4387"], confidence: 0.75 };
      } };
      return new SignalPipeline(config, repo, repo, repo, analyzer, createLogger(config), repo);
    }

    it("genera 3 entradas SELL independientes (TP1/TP2/TP3), cada una encolada con lote completo", async () => {
      const pipeline = buildRealFixturePipeline();
      const original = await pipeline.ingest({
        chatId: "1", messageId: "1", timestamp: new Date().toISOString(),
        text: MESSAGE_TEXT, chatName: "Signals", source: "TELEGRAM"
      });
      expect(original).toMatchObject({ status: "QUEUED", symbol: "XAUUSD", side: "SELL", legIndex: 0, legCount: 3, takeProfit: "4397" });
      expect(original?.approvedLot).toBe("0.1"); // DEFAULT_FIXED_LOT de testConfig(), sin requestedLot/riskPercentage en el mensaje

      const siblings = repo.list(100, 0)
        .filter((signal) => signal.signalGroupId === original?.id && signal.id !== original?.id)
        .sort((a, b) => a.legIndex - b.legIndex);
      expect(siblings).toHaveLength(2);
      expect(siblings.map((signal) => ({ legIndex: signal.legIndex, takeProfit: signal.takeProfit, status: signal.status, approvedLot: signal.approvedLot })))
        .toEqual([
          { legIndex: 1, takeProfit: "4392", status: "QUEUED", approvedLot: "0.1" },
          { legIndex: 2, takeProfit: "4387", status: "QUEUED", approvedLot: "0.1" }
        ]);
      expect(siblings.every((signal) => signal.entryMin === "4402" && signal.entryMax === "4407" && signal.stopLoss === "4413")).toBe(true);
    });
  });
});
