import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config.js";
import { readEnvFile, writeEnvUpdates } from "../config/env-file.js";
import type { SqliteRepositories } from "../repositories/sqlite-repositories.js";
import type { SignalPipeline } from "../services/signal-pipeline.js";
import type { MtcuteTelegramAdapter } from "../telegram/mtcute-telegram-adapter.js";
import { AppError, NotFoundError } from "../shared/errors.js";
import { secureEqual } from "../shared/security.js";
import { logEvent } from "../logging/logger.js";
import { SETTINGS_PAGE_HTML } from "./settings-page.js";
import { assignedSchema, clientQuerySchema, closeSchema, contextSchema, executionSchema, settingsUpdateSchema, signalListQuerySchema, slUpdateSchema } from "./schemas.js";

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (typeof value !== "string" || !value) throw new AppError("MISSING_HEADER", `${name} header is required`, 400);
  return value;
}

async function idempotent(
  request: FastifyRequest, reply: FastifyReply, repositories: SqliteRepositories, scope: string,
  operation: () => unknown
): Promise<unknown> {
  const key = header(request, "idempotency-key");
  const existing = repositories.get(scope, key);
  if (existing) return reply.code(existing.statusCode).send(existing.body);
  const body = operation();
  repositories.put(scope, key, 200, body);
  return reply.code(200).send(body);
}

export async function buildServer(
  config: AppConfig, repositories: SqliteRepositories, pipeline: SignalPipeline, logger: Logger,
  telegram?: MtcuteTelegramAdapter, envPath = ".env"
) {
  const app = Fastify({ loggerInstance: logger });
  await app.register(rateLimit, { max: config.api.rateLimitMax, timeWindow: config.api.rateLimitWindowMs });

  app.addHook("onRequest", async (request) => {
    // The settings page is static HTML/JS with no secrets of its own; every actual
    // read/write of config still goes through /api/settings/* behind the same API key.
    if (request.url === "/api/health" || request.url === "/settings") return;
    const apiKey = request.headers["x-api-key"];
    if (typeof apiKey !== "string" || !secureEqual(apiKey, config.api.key)) throw new AppError("UNAUTHORIZED", "Invalid API key", 401);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof Error && error.name === "ZodError") return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "Request validation failed" } });
    logger.error({ event: "SYSTEM_ERROR", err: error }, "Unhandled API error");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  app.get("/api/health", async () => ({ status: "ok", mode: config.tradingMode, database: "ready", timestamp: new Date().toISOString() }));

  app.get("/settings", async (_request, reply) => reply.type("text/html").send(SETTINGS_PAGE_HTML));

  app.get("/api/settings", async () => readEnvFile(envPath));

  app.post("/api/settings", async (request) => {
    const updates = settingsUpdateSchema.parse(request.body);
    try {
      return { saved: writeEnvUpdates(envPath, updates) };
    } catch (error) {
      throw new AppError("INVALID_SETTINGS", error instanceof Error ? error.message : "Invalid settings", 400);
    }
  });

  app.get("/api/settings/telegram-chats", async () => {
    if (!telegram) return { connected: false, chats: [] };
    return { connected: true, chats: await telegram.listDialogs() };
  });

  app.post("/api/mt5/context", async (request, reply) => idempotent(request, reply, repositories, "mt5-context", () => {
    const context = contextSchema.parse(request.body);
    if (config.allowedAccountIds.size > 0 && !config.allowedAccountIds.has(context.accountId)) throw new AppError("ACCOUNT_NOT_ALLOWED", "MT5 account is not allowed", 403);
    repositories.upsertContext(context);
    pipeline.processValidated(context);
    return { accepted: true, capturedAt: context.capturedAt };
  }));

  app.get("/api/trades/next", async (request) => {
    const { clientId } = clientQuerySchema.parse(request.query);
    const context = repositories.findContext(clientId);
    if (!context || Date.now() - Date.parse(context.capturedAt) > config.risk.contextMaxAgeSeconds * 1_000) {
      return { hasSignal: false, reason: "MT5_CONTEXT_REQUIRED" };
    }
    pipeline.processValidated(context);
    if (repositories.countActiveTradesForClient(clientId) >= config.risk.maxSimultaneousTrades) return { hasSignal: false, reason: "ACTIVE_TRADE_EXISTS" };
    const signal = repositories.assignNext(clientId, config.tradingMode, config.risk.maxSimultaneousTrades);
    if (signal) {
      logEvent(logger, "SIGNAL_ASSIGNED", { signalId: signal.signalId, tradeId: signal.tradeId, source: "REST", status: "ASSIGNED", clientId });
      repositories.recordEvent("SIGNAL_ASSIGNED", { signalId: signal.signalId, tradeId: signal.tradeId, source: "REST", status: "ASSIGNED", payload: { clientId } });
    }
    return signal ? { hasSignal: true, signal } : { hasSignal: false };
  });

  app.get("/api/trades/current", async (request) => {
    const { clientId } = clientQuerySchema.parse(request.query);
    const signals = repositories.currentAssignments(clientId);
    const trades = signals.map((signal) => ({ signal, trade: repositories.findTradeBySignalId(signal.signalId) }));
    return { hasTrade: trades.length > 0, trades };
  });

  app.post<{ Params: { signalId: string } }>("/api/trades/:signalId/assigned", async (request, reply) =>
    idempotent(request, reply, repositories, `assigned:${request.params.signalId}`, () => {
      const body = assignedSchema.parse(request.body);
      const trade = repositories.acknowledge(request.params.signalId, body.clientId, body.assignmentToken);
      logEvent(logger, "ORDER_REQUESTED", { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: trade.status });
      repositories.recordEvent("ORDER_REQUESTED", { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: trade.status });
      return { trade };
    }));

  app.post<{ Params: { signalId: string } }>("/api/trades/:signalId/execution", async (request, reply) =>
    idempotent(request, reply, repositories, `execution:${request.params.signalId}`, () => {
      const body = executionSchema.parse(request.body);
      if (config.tradingMode === "SIMULATION" && body.result === "FILLED") throw new AppError("MODE_MISMATCH", "Real fill is forbidden in simulation mode", 409);
      if (config.tradingMode === "LIVE" && body.result === "SIMULATED_EXECUTION") throw new AppError("MODE_MISMATCH", "Simulation result is forbidden in live mode", 409);
      const trade = repositories.recordExecution({ ...body, signalId: request.params.signalId, requestId: header(request, "x-request-id") });
      const event = body.result === "REJECTED" ? "ORDER_REJECTED" : body.result === "UNKNOWN" ? "SYSTEM_ERROR" : "ORDER_FILLED";
      logEvent(logger, event, { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: trade.status, result: body.result });
      repositories.recordEvent(event, { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: trade.status, payload: { result: body.result, retcode: body.retcode } });
      return { trade };
    }));

  app.post<{ Params: { signalId: string } }>("/api/trades/:signalId/closed", async (request, reply) =>
    idempotent(request, reply, repositories, `closed:${request.params.signalId}`, () => {
      const body = closeSchema.parse(request.body);
      const trade = repositories.recordClose({ ...body, signalId: request.params.signalId });
      logEvent(logger, "POSITION_CLOSED", { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: "CLOSED" });
      repositories.recordEvent("POSITION_CLOSED", { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: "CLOSED", payload: { netProfit: body.netProfit, reason: body.closeReason } });
      return { trade };
    }));

  app.post<{ Params: { signalId: string } }>("/api/trades/:signalId/sl-updated", async (request, reply) =>
    idempotent(request, reply, repositories, `sl-updated:${request.params.signalId}`, () => {
      const body = slUpdateSchema.parse(request.body);
      const trade = repositories.recordSlUpdate({ ...body, signalId: request.params.signalId });
      logEvent(logger, "SL_UPDATED", { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: trade.status });
      repositories.recordEvent("SL_UPDATED", { signalId: request.params.signalId, tradeId: trade.id, source: "MT5", status: trade.status, payload: { newStopLoss: body.newStopLoss, reason: body.reason } });
      return { trade };
    }));

  app.get<{ Params: { signalId: string } }>("/api/trades/:signalId", async (request) => {
    const trade = repositories.findTradeBySignalId(request.params.signalId);
    if (!trade) throw new NotFoundError("Trade");
    return { trade };
  });

  app.get("/api/signals", async (request) => {
    const query = signalListQuerySchema.parse(request.query);
    return { signals: repositories.list(query.limit, query.offset, query.status), limit: query.limit, offset: query.offset };
  });

  app.get<{ Params: { signalId: string } }>("/api/signals/:signalId", async (request) => {
    const signal = repositories.findById(request.params.signalId);
    if (!signal) throw new NotFoundError("Signal");
    return { signal };
  });

  return app;
}
