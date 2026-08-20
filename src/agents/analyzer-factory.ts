import type { Logger } from "pino";
import type { SignalAnalyzer } from "../application/ports.js";
import type { AppConfig } from "../config/config.js";
import { logEvent } from "../logging/logger.js";
import { ClaudeCliSignalAnalyzer } from "./claude-cli-analyzer.js";
import { CliSignalAnalyzer, DisabledSignalAnalyzer } from "./cli-signal-analyzer.js";
import { CodexCliSignalAnalyzer } from "./codex-cli-analyzer.js";
import { KiroCliSignalAnalyzer } from "./kiro-cli-analyzer.js";
import { detectProvider } from "./provider-detector.js";

type Detector = (candidates: readonly string[], timeoutMs: number) => Promise<string | null>;

/**
 * Resolves which SignalAnalyzer to use, once at startup:
 * 1. AI_AGENT_COMMAND set -> always wins (custom user script, unchanged behavior).
 * 2. AI disabled -> DisabledSignalAnalyzer.
 * 3. Otherwise, probe AI_PROVIDERS in order and use the first CLI that responds.
 *    "claude", "codex" and "kiro-cli" all get dedicated, verified adapters; any other custom
 *    name falls back to the generic CliSignalAnalyzer via stdin with no extra args.
 */
export async function createSignalAnalyzer(config: AppConfig, logger: Logger, detect: Detector = detectProvider): Promise<SignalAnalyzer> {
  if (!config.ai.enabled) {
    logEvent(logger, "AI_DISABLED", { status: "DISABLED" });
    return new DisabledSignalAnalyzer();
  }

  if (config.ai.command) {
    return new CliSignalAnalyzer({ command: config.ai.command, args: config.ai.args, timeoutMs: config.ai.timeoutMs, maxOutputBytes: config.ai.maxOutputBytes });
  }

  const provider = await detect(config.ai.providers, config.ai.providerDetectTimeoutMs);
  if (!provider) {
    logEvent(logger, "AI_PROVIDER_NOT_FOUND", { status: "ERROR", candidates: config.ai.providers.join(",") });
    return new DisabledSignalAnalyzer();
  }
  logEvent(logger, "AI_PROVIDER_DETECTED", { status: "READY", provider });

  if (provider === "claude") {
    return new ClaudeCliSignalAnalyzer({ timeoutMs: config.ai.timeoutMs, maxOutputBytes: config.ai.maxOutputBytes, model: config.ai.claudeModel });
  }
  if (provider === "codex") {
    return new CodexCliSignalAnalyzer({
      timeoutMs: config.ai.timeoutMs, maxOutputBytes: config.ai.maxOutputBytes,
      model: config.ai.codexModel, sandbox: config.ai.codexSandbox, extraArgs: config.ai.codexExtraArgs
    });
  }
  if (provider === "kiro-cli") {
    return new KiroCliSignalAnalyzer({
      timeoutMs: config.ai.kiroTimeoutMs, maxOutputBytes: config.ai.maxOutputBytes,
      model: config.ai.kiroModel, trustAllTools: config.ai.kiroTrustAllTools, extraArgs: config.ai.kiroExtraArgs
    });
  }
  return new CliSignalAnalyzer({ command: provider, args: [], timeoutMs: config.ai.timeoutMs, maxOutputBytes: config.ai.maxOutputBytes });
}
