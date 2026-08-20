import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignalAnalyzer } from "../application/ports.js";
import type { SignalAnalysis, TelegramMessage } from "../models/signal.js";
import { AppError } from "../shared/errors.js";
import { extractOutermostJson } from "../shared/json-extract.js";
import { runProcess } from "../shared/process.js";
import { buildAnalysisPayload } from "./prompt-builder.js";
import { signalAnalysisSchema } from "./signal-schema.js";

export interface KiroCliAnalyzerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  model: string;
  trustAllTools: boolean;
  extraArgs: readonly string[];
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** kiro-cli prints ANSI colors and "▸ ..." progress lines around the JSON it was asked for. */
export function extractJsonFromKiroOutput(raw: string): unknown {
  const cleaned = raw.replace(ANSI_PATTERN, "").split("\n").filter((line) => !line.includes("▸")).join("\n");
  try {
    return extractOutermostJson(cleaned);
  } catch (error) {
    throw new AppError("AI_INVALID_JSON", "kiro-cli did not return a valid JSON object", 422, error);
  }
}

/** Pure parse+validate step, kept separate from the spawn so it is unit-testable without kiro-cli installed. */
export function parseKiroOutput(raw: string): SignalAnalysis {
  const candidate = extractJsonFromKiroOutput(raw);
  try {
    return signalAnalysisSchema.parse(candidate);
  } catch (error) {
    throw new AppError("AI_INVALID_JSON", "kiro-cli result did not match the expected signal schema", 422, error);
  }
}

export class KiroCliSignalAnalyzer implements SignalAnalyzer {
  constructor(private readonly options: KiroCliAnalyzerOptions) {}

  async analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis> {
    // kiro-cli truncates large prompts passed as direct CLI args on Windows, so the
    // payload goes through a temp file referenced with `@path` instead of stdin/argv.
    const tempFile = join(tmpdir(), `telegram-trader-kiro-${signalId}-${randomUUID()}.txt`);
    await writeFile(tempFile, buildAnalysisPayload(message, signalId), "utf8");
    try {
      const args = ["chat", "--no-interactive", "--model", this.options.model];
      if (this.options.trustAllTools) args.push("--trust-all-tools");
      args.push(...this.options.extraArgs, `@${tempFile}`);

      let result;
      try {
        result = await runProcess("kiro-cli", args, "", {
          timeoutMs: this.options.timeoutMs,
          maxOutputBytes: this.options.maxOutputBytes,
          extraEnv: { KIRO_SKIP_UPDATE_CHECK: "1", KIRO_NO_AUTO_UPDATE: "1", KIRO_TELEMETRY_DISABLED: "1", PYTHONUTF8: "1" }
        });
      } catch (error) {
        throw new AppError("AI_PROCESS_ERROR", `Unable to start kiro-cli: ${error instanceof Error ? error.message : String(error)}`, 503);
      }
      if (result.timedOut) throw new AppError("AI_TIMEOUT", "kiro-cli timed out", 503);
      if (result.outputExceeded) throw new AppError("AI_OUTPUT_TOO_LARGE", "kiro-cli output exceeded configured limit");
      if (result.code !== 0) throw new AppError("AI_PROCESS_FAILED", `kiro-cli exited with code ${String(result.code)}: ${result.stderr.slice(0, 500)}`, 503);
      return parseKiroOutput(result.stdout);
    } finally {
      await rm(tempFile, { force: true });
    }
  }
}
