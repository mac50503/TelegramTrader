import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignalAnalyzer } from "../application/ports.js";
import type { SignalAnalysis, TelegramMessage } from "../models/signal.js";
import { AppError } from "../shared/errors.js";
import { extractOutermostJson } from "../shared/json-extract.js";
import { runProcess } from "../shared/process.js";
import { ANALYSIS_JSON_SCHEMA, buildAnalysisPayload } from "./prompt-builder.js";
import { signalAnalysisSchema } from "./signal-schema.js";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexCliAnalyzerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  model?: string | undefined;
  sandbox: CodexSandbox;
  extraArgs: readonly string[];
}

/** Pure parse+validate step: codex's --output-schema should already yield clean JSON, but we never trust that blindly. */
export function parseCodexOutput(raw: string): SignalAnalysis {
  const trimmed = raw.trim();
  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    try {
      candidate = extractOutermostJson(trimmed);
    } catch (error) {
      throw new AppError("AI_INVALID_JSON", "codex did not return a valid JSON object", 422, error);
    }
  }
  try {
    if (candidate && typeof candidate === "object" && "isSignal" in candidate) {
      const output = candidate as Record<string, unknown>;
      if (output.isSignal === false) return { isSignal: false };
      candidate = Object.fromEntries(Object.entries(output).filter(([, value]) => value !== null));
    }
    return signalAnalysisSchema.parse(candidate);
  } catch (error) {
    throw new AppError("AI_INVALID_JSON", "codex result did not match the expected signal schema", 422, error);
  }
}

export class CodexCliSignalAnalyzer implements SignalAnalyzer {
  constructor(private readonly options: CodexCliAnalyzerOptions) {}

  async analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis> {
    const runId = `${signalId}-${randomUUID()}`;
    const schemaFile = join(tmpdir(), `telegram-trader-codex-schema-${runId}.json`);
    const outputFile = join(tmpdir(), `telegram-trader-codex-output-${runId}.json`);
    await writeFile(schemaFile, JSON.stringify(ANALYSIS_JSON_SCHEMA), "utf8");
    try {
      const args = [
        // Global Codex options must precede the `exec` subcommand.
        "--ask-for-approval", "never",
        "exec", "-",
        "--output-schema", schemaFile,
        "--output-last-message", outputFile,
        // Safe-by-default: no writes, no network/system changes, never pauses for approval.
        // This must never be relaxed for this pipeline — it classifies untrusted Telegram text.
        "--sandbox", this.options.sandbox,
        "--ephemeral",
        "--skip-git-repo-check"
      ];
      if (this.options.model) args.push("--model", this.options.model);
      args.push(...this.options.extraArgs);

      let result;
      try {
        result = await runProcess("codex", args, buildAnalysisPayload(message, signalId), {
          timeoutMs: this.options.timeoutMs,
          maxOutputBytes: this.options.maxOutputBytes
        });
      } catch (error) {
        throw new AppError("AI_PROCESS_ERROR", `Unable to start codex: ${error instanceof Error ? error.message : String(error)}`, 503);
      }
      if (result.timedOut) throw new AppError("AI_TIMEOUT", "codex timed out", 503);
      if (result.outputExceeded) throw new AppError("AI_OUTPUT_TOO_LARGE", "codex output exceeded configured limit");
      if (result.code !== 0) throw new AppError("AI_PROCESS_FAILED", `codex exited with code ${String(result.code)}: ${result.stderr.slice(-2_000)}`, 503);

      let finalMessage: string;
      try {
        finalMessage = await readFile(outputFile, "utf8");
      } catch (error) {
        throw new AppError("AI_PROCESS_FAILED", "codex did not write an output-last-message file", 503, error);
      }
      return parseCodexOutput(finalMessage);
    } finally {
      await rm(schemaFile, { force: true });
      await rm(outputFile, { force: true });
    }
  }
}
