import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/database/database.js";
import { SqliteRepositories } from "../src/repositories/sqlite-repositories.js";

describe("repositorio y cola", () => {
  let db: Database.Database;
  let repo: SqliteRepositories;
  let counter = 0;
  beforeEach(() => { db = openDatabase(":memory:"); repo = new SqliteRepositories(db); counter = 0; });
  afterEach(() => db.close());

  function queueSignal(takeProfit: string): string {
    counter += 1;
    const message = { chatId: "1", messageId: String(counter), timestamp: new Date().toISOString(), text: "BUY", chatName: "test", source: "TELEGRAM" as const };
    const signal = repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())!;
    repo.saveAnalysis(signal.id, { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "100", entryMin: "100", entryMax: "100",
      stopLoss: "99", takeProfits: [takeProfit], lot: "0.1", confidence: 1 });
    repo.saveValidated(signal.id, "0.1", "{}"); repo.setStatus(signal.id, "QUEUED");
    return signal.id;
  }

  it("ignora dos veces el mismo mensaje Telegram", () => {
    const message = { chatId: "-1001", messageId: "77", timestamp: new Date().toISOString(), text: "hello", chatName: "test", source: "TELEGRAM" as const };
    expect(repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())).not.toBeNull();
    expect(repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())).toBeNull();
  });

  it("reserva una señal una sola vez", () => {
    const message = { chatId: "1", messageId: "1", timestamp: new Date().toISOString(), text: "BUY", chatName: "test", source: "TELEGRAM" as const };
    const signal = repo.createFromTelegram(message, new Date(Date.now() + 60_000).toISOString())!;
    repo.saveAnalysis(signal.id, { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "100", entryMin: "100", entryMax: "100",
      stopLoss: "99", takeProfits: ["102"], lot: "0.1", confidence: 1 });
    repo.saveValidated(signal.id, "0.1", "{}"); repo.setStatus(signal.id, "QUEUED");
    expect(repo.assignNext("ea-1", "SIMULATION", 1)).not.toBeNull();
    expect(repo.assignNext("ea-2", "SIMULATION", 1)).toBeNull();
  });

  it("reproduce una respuesta idempotente almacenada", () => {
    repo.put("test", "key", 200, { ok: true });
    repo.put("test", "key", 500, { ok: false });
    expect(repo.get("test", "key")).toEqual({ statusCode: 200, body: { ok: true } });
  });

  it("assignNext respeta el límite de trades simultáneos por clientId, no globalmente", () => {
    queueSignal("101");
    queueSignal("102");
    queueSignal("103");
    expect(repo.assignNext("ea-1", "SIMULATION", 2)).not.toBeNull();
    expect(repo.countActiveTradesForClient("ea-1")).toBe(1);
    expect(repo.assignNext("ea-1", "SIMULATION", 2)).not.toBeNull();
    expect(repo.countActiveTradesForClient("ea-1")).toBe(2);
    // ea-1 llegó a su límite (2); la tercera señal en cola sigue disponible para otro cliente.
    expect(repo.assignNext("ea-1", "SIMULATION", 2)).toBeNull();
    expect(repo.assignNext("ea-2", "SIMULATION", 2)).not.toBeNull();
  });

  it("recordSlUpdate mueve el stop loss de la posición abierta", () => {
    const signalId = queueSignal("102");
    const assignment = repo.assignNext("ea-1", "SIMULATION", 1)!;
    repo.acknowledge(assignment.signalId, "ea-1", assignment.assignmentToken);
    repo.recordExecution({ signalId: assignment.signalId, clientId: "ea-1", assignmentToken: assignment.assignmentToken,
      executionId: "EXE-1", requestId: "req-1", result: "SIMULATED_EXECUTION", requestedPrice: "100", requestedVolume: "0.1",
      executedAt: new Date().toISOString() });
    const updated = repo.recordSlUpdate({ signalId, clientId: "ea-1", assignmentToken: assignment.assignmentToken,
      newStopLoss: "100", reason: "BREAKEVEN_TP1" });
    const position = db.prepare("SELECT stop_loss FROM positions WHERE trade_id=?").get(updated.id) as { stop_loss: string };
    expect(position.stop_loss).toBe("100");
  });
});
