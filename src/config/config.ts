import "dotenv/config";
import { z } from "zod";
import { csv } from "../shared/strings.js";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const positiveInt = z.coerce.number().int().positive();
const nonNegative = z.coerce.number().nonnegative();
// Env vars are always strings when present; an empty value (e.g. "TELEGRAM_API_ID=" with
// nothing after it) must be treated as absent, not as "" coerced into a failing number/string check.
const optionalNonEmpty = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TELEGRAM_ENABLED: booleanString.default(false),
  TELEGRAM_API_ID: optionalNonEmpty(z.coerce.number().int().positive()),
  TELEGRAM_API_HASH: optionalNonEmpty(z.string().min(1)),
  TELEGRAM_SESSION_PATH: z.string().default("./data/telegram/session"),
  TELEGRAM_ALLOWED_CHATS: z.string().default(""),
  AI_AGENT_ENABLED: booleanString.default(false),
  AI_AGENT_COMMAND: z.string().optional(),
  AI_AGENT_ARGS_JSON: z.string().default("[]"),
  AI_AGENT_TIMEOUT_MS: positiveInt.default(45_000),
  AI_AGENT_MAX_OUTPUT_BYTES: positiveInt.default(65_536),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  AI_PREFILTER_ENABLED: booleanString.default(true),
  // Priority order of agent CLIs to auto-detect when AI_AGENT_COMMAND is not set.
  AI_PROVIDERS: z.string().default("claude,codex,kiro-cli"),
  AI_PROVIDER_DETECT_TIMEOUT_MS: positiveInt.default(5_000),
  // Cheap model for a simple classification task; empty means use the claude CLI's own default.
  AI_CLAUDE_MODEL: z.string().default("haiku"),
  // codex invocation verified against official docs (see README). Empty model means codex's own default.
  AI_CODEX_MODEL: z.string().default(""),
  // Sandbox level passed to `codex exec --sandbox`. Keep "read-only" for this pipeline: it
  // classifies untrusted Telegram text and must never be allowed to write files or run commands.
  AI_CODEX_SANDBOX: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  AI_CODEX_EXTRA_ARGS_JSON: z.string().default("[]"),
  // kiro-cli invocation verified against a real reference project (see README). Prompt goes through a temp file, not stdin.
  AI_KIRO_MODEL: z.string().default("claude-haiku-4.5"),
  AI_KIRO_TIMEOUT_MS: positiveInt.default(120_000),
  // Grants kiro-cli full tool access (Bash, files, ...). Off by default: the pipeline processes
  // untrusted Telegram text and must never let the analyzer execute anything. Enable only if you
  // understand and accept that risk, and kiro-cli hangs/times out without it.
  AI_KIRO_TRUST_ALL_TOOLS: booleanString.default(false),
  AI_KIRO_EXTRA_ARGS_JSON: z.string().default("[]"),
  DATABASE_URL: z.string().default("./data/telegram-trader.sqlite"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  API_KEY: z.string().min(16).default("development-key-change-me"),
  API_RATE_LIMIT_MAX: positiveInt.default(120),
  API_RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
  SIGNAL_TTL_SECONDS: positiveInt.default(900),
  DUPLICATE_WINDOW_SECONDS: nonNegative.default(3_600),
  DEFAULT_FIXED_LOT: z.coerce.number().positive().default(0.01),
  DEFAULT_RISK_PERCENT: z.coerce.number().positive().default(1),
  MAX_LOT: z.coerce.number().positive().default(1),
  MAX_RISK_PERCENT: z.coerce.number().positive().max(100).default(2),
  MAX_DAILY_TRADES: positiveInt.default(5),
  MAX_DAILY_LOSS: nonNegative.default(500),
  MAX_SIMULTANEOUS_TRADES: positiveInt.default(1),
  MT5_CONTEXT_MAX_AGE_SECONDS: positiveInt.default(300),
  TRADING_MODE: z.enum(["SIMULATION", "LIVE"]).default("SIMULATION"),
  LIVE_TRADING_CONFIRM: z.string().default(""),
  MT5_ALLOWED_ACCOUNT_IDS: z.string().default("")
});

export type AppConfig = ReturnType<typeof loadConfig>;

function parseJsonStringArray(value: string, varName: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${varName} must be a JSON array of strings`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const aiAgentArgs = parseJsonStringArray(parsed.AI_AGENT_ARGS_JSON, "AI_AGENT_ARGS_JSON");
  const codexExtraArgs = parseJsonStringArray(parsed.AI_CODEX_EXTRA_ARGS_JSON, "AI_CODEX_EXTRA_ARGS_JSON");
  const kiroExtraArgs = parseJsonStringArray(parsed.AI_KIRO_EXTRA_ARGS_JSON, "AI_KIRO_EXTRA_ARGS_JSON");

  if (parsed.TELEGRAM_ENABLED && (!parsed.TELEGRAM_API_ID || !parsed.TELEGRAM_API_HASH)) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required when Telegram is enabled");
  }
  if (parsed.TRADING_MODE === "LIVE" && parsed.LIVE_TRADING_CONFIRM !== "I_UNDERSTAND_LIVE_TRADING") {
    throw new Error("LIVE mode requires LIVE_TRADING_CONFIRM=I_UNDERSTAND_LIVE_TRADING");
  }
  if (parsed.NODE_ENV === "production" && parsed.API_KEY === "development-key-change-me") {
    throw new Error("A unique API_KEY is required in production");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    telegram: {
      enabled: parsed.TELEGRAM_ENABLED,
      apiId: parsed.TELEGRAM_API_ID,
      apiHash: parsed.TELEGRAM_API_HASH,
      sessionPath: parsed.TELEGRAM_SESSION_PATH,
      allowedChats: new Set(csv(parsed.TELEGRAM_ALLOWED_CHATS))
    },
    ai: {
      enabled: parsed.AI_AGENT_ENABLED,
      command: parsed.AI_AGENT_COMMAND,
      args: aiAgentArgs,
      timeoutMs: parsed.AI_AGENT_TIMEOUT_MS,
      maxOutputBytes: parsed.AI_AGENT_MAX_OUTPUT_BYTES,
      minConfidence: parsed.AI_MIN_CONFIDENCE,
      prefilterEnabled: parsed.AI_PREFILTER_ENABLED,
      providers: csv(parsed.AI_PROVIDERS),
      providerDetectTimeoutMs: parsed.AI_PROVIDER_DETECT_TIMEOUT_MS,
      claudeModel: parsed.AI_CLAUDE_MODEL || undefined,
      codexModel: parsed.AI_CODEX_MODEL || undefined,
      codexSandbox: parsed.AI_CODEX_SANDBOX,
      codexExtraArgs,
      kiroModel: parsed.AI_KIRO_MODEL,
      kiroTimeoutMs: parsed.AI_KIRO_TIMEOUT_MS,
      kiroTrustAllTools: parsed.AI_KIRO_TRUST_ALL_TOOLS,
      kiroExtraArgs
    },
    databaseUrl: parsed.DATABASE_URL,
    api: {
      host: parsed.API_HOST,
      port: parsed.API_PORT,
      key: parsed.API_KEY,
      rateLimitMax: parsed.API_RATE_LIMIT_MAX,
      rateLimitWindowMs: parsed.API_RATE_LIMIT_WINDOW_MS
    },
    signal: {
      ttlSeconds: parsed.SIGNAL_TTL_SECONDS,
      duplicateWindowSeconds: parsed.DUPLICATE_WINDOW_SECONDS
    },
    risk: {
      defaultFixedLot: parsed.DEFAULT_FIXED_LOT.toString(),
      defaultRiskPercentage: parsed.DEFAULT_RISK_PERCENT.toString(),
      maxLot: parsed.MAX_LOT.toString(),
      maxRiskPercentage: parsed.MAX_RISK_PERCENT.toString(),
      maxDailyTrades: parsed.MAX_DAILY_TRADES,
      maxDailyLoss: parsed.MAX_DAILY_LOSS.toString(),
      maxSimultaneousTrades: parsed.MAX_SIMULTANEOUS_TRADES,
      contextMaxAgeSeconds: parsed.MT5_CONTEXT_MAX_AGE_SECONDS
    },
    tradingMode: parsed.TRADING_MODE,
    allowedAccountIds: new Set(csv(parsed.MT5_ALLOWED_ACCOUNT_IDS))
  } as const;
}
