import { spawn } from "node:child_process";
import { createSignalAnalyzer } from "./agents/analyzer-factory.js";
import { PrefilteredSignalAnalyzer } from "./agents/heuristic-prefilter.js";
import { buildServer } from "./api/server.js";
import { loadConfig } from "./config/config.js";
import { readEnvFile } from "./config/env-file.js";
import { openDatabase } from "./database/database.js";
import { createLogger } from "./logging/logger.js";
import { SqliteRepositories } from "./repositories/sqlite-repositories.js";
import { SignalPipeline } from "./services/signal-pipeline.js";
import { MtcuteTelegramAdapter } from "./telegram/mtcute-telegram-adapter.js";

const config = loadConfig();
const logger = createLogger(config);
const database = openDatabase(config.databaseUrl);
const repositories = new SqliteRepositories(database);
const baseAnalyzer = await createSignalAnalyzer(config, logger);
const analyzer = config.ai.prefilterEnabled ? new PrefilteredSignalAnalyzer(baseAnalyzer, logger) : baseAnalyzer;
const pipeline = new SignalPipeline(config, repositories, repositories, repositories, analyzer, logger, repositories, repositories);

let telegram: MtcuteTelegramAdapter | undefined;
if (config.telegram.enabled && config.telegram.apiId && config.telegram.apiHash) {
  telegram = new MtcuteTelegramAdapter({ apiId: config.telegram.apiId, apiHash: config.telegram.apiHash,
    sessionPath: config.telegram.sessionPath, allowedChats: config.telegram.allowedChats });
  await telegram.start((message) => pipeline.ingest(message).then(() => undefined));
}

const server = await buildServer(config, repositories, pipeline, logger, telegram, ".env", requestRestart);

await server.listen({ host: config.api.host, port: config.api.port });
logger.info({ event: "SERVER_STARTED", host: config.api.host, port: config.api.port, mode: config.tradingMode }, "Server started");

let shuttingDown = false;
let restartRequested = false;

function requestRestart(): void {
  if (restartRequested) return;
  restartRequested = true;
  setTimeout(() => {
    void shutdown("SETTINGS_RESTART").then(() => {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(), env: { ...process.env, ...readEnvFile(".env") }, detached: true, stdio: "ignore", windowsHide: true
      });
      child.unref();
      process.exit(0);
    }).catch((error) => {
      restartRequested = false;
      logger.error({ event: "SERVER_RESTART_FAILED", err: error }, "Failed to restart server after settings update");
    });
  }, 100);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "SERVER_STOPPING", signal }, "Stopping server");
  await telegram?.stop();
  await server.close();
  database.close();
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
