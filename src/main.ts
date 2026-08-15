import { CliSignalAnalyzer, DisabledSignalAnalyzer } from "./agents/cli-signal-analyzer.js";
import { buildServer } from "./api/server.js";
import { loadConfig } from "./config/config.js";
import { openDatabase } from "./database/database.js";
import { createLogger } from "./logging/logger.js";
import { SqliteRepositories } from "./repositories/sqlite-repositories.js";
import { SignalPipeline } from "./services/signal-pipeline.js";
import { MtcuteTelegramAdapter } from "./telegram/mtcute-telegram-adapter.js";

const config = loadConfig();
const logger = createLogger(config);
const database = openDatabase(config.databaseUrl);
const repositories = new SqliteRepositories(database);
const analyzer = config.ai.enabled && config.ai.command
  ? new CliSignalAnalyzer({ command: config.ai.command, args: config.ai.args, timeoutMs: config.ai.timeoutMs, maxOutputBytes: config.ai.maxOutputBytes })
  : new DisabledSignalAnalyzer();
const pipeline = new SignalPipeline(config, repositories, repositories, repositories, analyzer, logger, repositories);
const server = await buildServer(config, repositories, pipeline, logger);

let telegram: MtcuteTelegramAdapter | undefined;
if (config.telegram.enabled && config.telegram.apiId && config.telegram.apiHash) {
  telegram = new MtcuteTelegramAdapter({ apiId: config.telegram.apiId, apiHash: config.telegram.apiHash,
    sessionPath: config.telegram.sessionPath, allowedChats: config.telegram.allowedChats });
  await telegram.start((message) => pipeline.ingest(message).then(() => undefined));
}

await server.listen({ host: config.api.host, port: config.api.port });
logger.info({ event: "SERVER_STARTED", host: config.api.host, port: config.api.port, mode: config.tradingMode }, "Server started");

let shuttingDown = false;
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
