import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const analyzer: SignalAnalyzer = { async analyze() { return { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "100",
    entryMin: "100", entryMax: "101", stopLoss: "99", takeProfit: "102", lot: "0.1", confidence: 0.99 }; } };

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
    expect(assignment).toMatchObject({ entry: "100", entryMin: "100", entryMax: "101" });
    expect((await app.inject({ method: "GET", url: "/api/trades/next?clientId=test-ea", headers: auth })).json().hasSignal).toBe(false);
    const mutableHeaders = { ...auth, "x-request-id": "req-1", "idempotency-key": "assigned-1" };
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/assigned`, headers: mutableHeaders,
      payload: { clientId: "test-ea", assignmentToken: assignment.assignmentToken } })).statusCode).toBe(200);
    const executionPayload = { clientId: "test-ea", assignmentToken: assignment.assignmentToken, executionId: "EXE-test-1",
      result: "SIMULATED_EXECUTION", requestedPrice: "100", executionPrice: "100.1", requestedVolume: "0.1", executedVolume: "0.1",
      orderTicket: "0", dealTicket: "0", positionTicket: "0", executedAt: new Date().toISOString() };
    const executionHeaders = { ...auth, "x-request-id": "execution-1", "idempotency-key": "execution-1" };
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/execution`, headers: executionHeaders, payload: executionPayload })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/execution`, headers: executionHeaders, payload: executionPayload })).statusCode).toBe(200);
    const closeHeaders = { ...auth, "x-request-id": "close-1", "idempotency-key": "close-1" };
    expect((await app.inject({ method: "POST", url: `/api/trades/${assignment.signalId}/closed`, headers: closeHeaders,
      payload: { clientId: "test-ea", assignmentToken: assignment.assignmentToken, closePrice: "102", grossProfit: "20",
        commission: "0", swap: "0", netProfit: "20", closeReason: "SIMULATED_TP", closedAt: new Date().toISOString() } })).statusCode).toBe(200);
    expect(repo.findById(assignment.signalId)?.status).toBe("CLOSED");

    const second = repo.createFromTelegram({ chatId: "-100", messageId: "2", timestamp: new Date().toISOString(),
      text: "BUY XAUUSD 101", chatName: "Signals", source: "TELEGRAM" }, new Date(Date.now() + 60_000).toISOString())!;
    repo.saveAnalysis(second.id, { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: "101", entryMin: "101", entryMax: "101", stopLoss: "100",
      takeProfit: "103", lot: "0.1", confidence: 0.99 });
    repo.setStatus(second.id, "ANALYZING");
    repo.saveValidated(second.id, "0.1", "{}");
    repo.setStatus(second.id, "VALIDATED");
    repo.setStatus(second.id, "QUEUED");
    const secondAssignment = (await app.inject({ method: "GET", url: "/api/trades/next?clientId=test-ea", headers: auth })).json().signal;
    const secondExecution = await app.inject({ method: "POST", url: `/api/trades/${second.id}/execution`,
      headers: { ...auth, "x-request-id": "execution-2", "idempotency-key": "execution-2" },
      payload: { ...executionPayload, assignmentToken: secondAssignment.assignmentToken, executionId: "EXE-test-2" } });
    expect(secondExecution.statusCode).toBe(200);
    const tickets = db.prepare("SELECT mt5_order_ticket,mt5_deal_ticket,mt5_position_ticket FROM executions ORDER BY created_at").all() as
      Array<{ mt5_order_ticket: string | null; mt5_deal_ticket: string | null; mt5_position_ticket: string | null }>;
    expect(tickets).toHaveLength(2);
    expect(tickets.every((row) => row.mt5_order_ticket === null && row.mt5_deal_ticket === null && row.mt5_position_ticket === null)).toBe(true);
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

describe("Página de configuración (/settings)", () => {
  const config = testConfig();
  const auth = { "x-api-key": config.api.key };
  let db: Database.Database;
  let repo: SqliteRepositories;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    db = openDatabase(":memory:"); repo = new SqliteRepositories(db);
    const logger = createLogger(config);
    const pipeline = new SignalPipeline(config, repo, repo, repo, { async analyze() { return { isSignal: false }; } }, logger, repo);
    dir = mkdtempSync(join(tmpdir(), "tt-settings-"));
    envPath = join(dir, ".env");
    writeFileSync(envPath, "API_KEY=test-api-key-at-least-16\nAI_CLAUDE_MODEL=haiku\nTRADING_MODE=SIMULATION\n");
    app = await buildServer(config, repo, pipeline, logger, undefined, envPath);
  });
  afterEach(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("sirve la página sin exigir API key", async () => {
    const response = await app.inject({ method: "GET", url: "/settings" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });

  it("exige API key para leer y escribir los datos de configuración", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/settings", payload: {} })).statusCode).toBe(401);
  });

  it("lee los valores actuales del .env", async () => {
    const response = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(response.json()).toMatchObject({ AI_CLAUDE_MODEL: "haiku", TRADING_MODE: "SIMULATION" });
  });

  it("guarda un cambio válido y lo refleja en /api/settings", async () => {
    const post = await app.inject({ method: "POST", url: "/api/settings", headers: auth, payload: { AI_CLAUDE_MODEL: "opus" } });
    expect(post.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(get.json().AI_CLAUDE_MODEL).toBe("opus");
  });

  it("rechaza una combinación inválida (LIVE sin confirmación) con 400 y no modifica el archivo", async () => {
    const response = await app.inject({ method: "POST", url: "/api/settings", headers: auth, payload: { TRADING_MODE: "LIVE" } });
    expect(response.statusCode).toBe(400);
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(get.json().TRADING_MODE).toBe("SIMULATION");
  });

  it("responde connected:false para los chats de Telegram cuando no hay adaptador", async () => {
    const response = await app.inject({ method: "GET", url: "/api/settings/telegram-chats", headers: auth });
    expect(response.json()).toEqual({ connected: false, chats: [] });
  });
});
