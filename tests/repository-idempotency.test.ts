import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/database.js";
import { SqliteRepositories } from "../src/repositories/sqlite-repositories.js";

describe("repositorio y cola", () => {
  let db: Database.Database;
  let repo: SqliteRepositories;
  beforeEach(() => { db = openDatabase(":memory:"); repo = new SqliteRepositories(db); });
  afterEach(() => db.close());

  it("ignora dos veces el mismo mensaje Telegram", () => {
    const message = { chatId: "-1001", messageId: "77", timestamp: new Date().toISOString(), text: "hello", chatName: "test", source: "TELEGRAM" as const };
    expect(repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())).not.toBeNull();
    expect(repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())).toBeNull();
  });

  it("reserva una señal una sola vez", () => {
    const message = { chatId: "1", messageId: "1", timestamp: new Date().toISOString(), text: "BUY", chatName: "test", source: "TELEGRAM" as const };
    const signal = repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())!;
    repo.saveAnalysis(signal.id, { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "100", entryMin: "100", entryMax: "100",
      stopLoss: "99", takeProfit: "102", lot: "0.1", confidence: 1 });
    repo.saveValidated(signal.id, "0.1", "{}"); repo.setStatus(signal.id, "QUEUED");
    expect(repo.assignNext("ea-1", "SIMULATION")).not.toBeNull();
    expect(repo.assignNext("ea-2", "SIMULATION")).toBeNull();
  });

  it("reproduce una respuesta idempotente almacenada", () => {
    repo.put("test", "key", 200, { ok: true });
    repo.put("test", "key", 500, { ok: false });
    expect(repo.get("test", "key")).toEqual({ statusCode: 200, body: { ok: true } });
  });
});
