import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { SignalAnalyzer } from "../src/application/ports.js";
import { buildServer } from "../src/api/server.js";
import { openDatabase } from "../src/database/database.js";
import { createLogger } from "../src/logging/logger.js";
import { SqliteRepositories } from "../src/repositories/sqlite-repositories.js";
import { SignalPipeline } from "../src/services/signal-pipeline.js";
import { mt5Context, testConfig } from "./helpers.js";

describe("API REST e integración local", () => {
  const config = testConfig();
  const auth = { "x-api-key": config.api.key };
  let db: Database.Database;
  let repo: SqliteRepositories;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let pipeline: SignalPipeline;
  const analyzer: SignalAnalyzer = { async analyze() { return { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "100", stopLoss: "99", takeProfit: "102", lot: "0.1", confidence: 0.99 }; } };

  beforeEach(async () => {
    db = openDatabase(":memory:"); repo = new SqliteRepositories(db);
    const logger = createLogger(config);
    pipeline = new SignalPipeline(config, repo, repo, repo, analyzer, logger, repo);
    app = await buildServer(config, repo, pipeline, logger);
  });
  afterEach(async () => { await app.close(); db.close(); });

  it("protege la API con API key", async () => {
    expect((await app.inject({ method: "GET", url: "/api/signals" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("completa cola, asignación, simulación y cierre sin duplicar", async () => {
    const context = mt5Context();
    const contextResponse = await app.inject({ method: "POST", url: "/api/mt5/context", headers: { ...auth, "x-request-id": "ctx-1", "idempotency-key": "ctx-1" }, payload: context });
    expect(contextResponse.statusCode).toBe(200);
    const created = await pipeline.ingest({ chatId: "-100", messageId: "1", timestamp: new Date().toISOString(), text: "BUY XAUUSD", chatName: "Signals", source: "TELEGRAM" });
    expect(created?.status).toBe("QUEUED");
    const next = await app.inject({ method: "GET", url: "/api/trades/next?clientId=test-ea", headers: auth });
    const assignment = next.json().signal;
    expect(next.json().hasSignal).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/trades/next?clientId=test-ea", headers: auth })).json().hasSignal).toBe(false);
    const mutableHeaders = { ...auth, "x-request-id": "req-1", "idempotency-key": "assigned-1" };
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/assigned`, headers: mutableHeaders,
      payload: { clientId: "test-ea", assignmentToken: assignment.assignmentToken } })).statusCode).toBe(200);
    const executionPayload = { clientId: "test-ea", assignmentToken: assignment.assignmentToken, executionId: "EXE-test-1",
      result: "SIMULATED_EXECUTION", requestedPrice: "100", executionPrice: "100.1", requestedVolume: "0.1", executedVolume: "0.1",
      executedAt: new Date().toISOString() };
    const executionHeaders = { ...auth, "x-request-id": "execution-1", "idempotency-key": "execution-1" };
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/execution`, headers: executionHeaders, payload: executionPayload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/execution`, headers: executionHeaders, payload: executionPayload })).statusCode).toBe(200);
    const closeHeaders = { ...auth, "x-request-id": "close-1", "idempotency-key": "close-1" };
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/closed`, headers: closeHeaders,
      payload: { clientId: "test-ea", assignmentToken: assignment.assignmentToken, closePrice: "102", grossProfit: "20",
        commission: "0", swap: "0", netProfit: "20", closeReason: "SIMULATED_TP", closedAt: new Date().toISOString() } })).statusCode).toBe(200);
    expect(repo.findById(assignment.signalId)?.status).toBe("CLOSED");
  });

  it("impide reportar un fill real en simulación", async () => {
    const context = mt5Context(); repo.upsertContext(context);
    await pipeline.ingest({ chatId: "1", messageId: "2", timestamp: new Date().toISOString(), text: "BUY", chatName: "Signals", source: "TELEGRAM" });
    const assignment = (await app.inject({ method: "GET", url: "/api/trades/next?clientId=test-ea", headers: auth })).json().signal;
    const response = await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/execution`,
      headers: { ...auth, "x-request-id": "live-1", "idempotency-key": "live-1" }, payload: { clientId: "test-ea",
        assignmentToken: assignment.assignmentToken, executionId: "EXE-live-test", result: "FILLED", requestedPrice: "100",
        requestedVolume: "0.1", executedAt: new Date().toISOString() } });
    expect(response.statusCode).toBe(409);
  });
});
