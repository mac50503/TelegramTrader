import pino, { type Logger } from "pino";
import type { AppConfig } from "../config/config.js";

export type EventName =
  | "TELEGRAM_MESSAGE_RECEIVED"
  | "SIGNAL_ANALYSIS_STARTED"
  | "SIGNAL_DETECTED"
  | "SIGNAL_IGNORED"
  | "SIGNAL_REJECTED"
  | "SIGNAL_VALIDATED"
  | "SIGNAL_QUEUED"
  | "SIGNAL_ASSIGNED"
  | "AI_PREFILTER_SKIPPED"
  | "AI_DISABLED"
  | "AI_PROVIDER_DETECTED"
  | "AI_PROVIDER_NOT_FOUND"
  | "ORDER_REQUESTED"
  | "ORDER_FILLED"
  | "ORDER_REJECTED"
  | "POSITION_CLOSED"
  | "SL_UPDATED"
  | "SYSTEM_ERROR";

export function createLogger(config: Pick<AppConfig, "logLevel">): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ["apiKey", "headers.x-api-key", "telegram.apiHash", "telegram.session", "password", "token"],
      censor: "[REDACTED]"
    },
    base: { service: "telegram-trader" },
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

export function logEvent(
  logger: Logger,
  event: EventName,
  fields: { signalId?: string; tradeId?: string; source?: string; status?: string; [key: string]: unknown }
): void {
  logger.info({ event, ...fields }, event);
}
