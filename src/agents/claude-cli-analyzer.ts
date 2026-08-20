import type { SignalAnalyzer } from "../application/ports.js";
import type { SignalAnalysis, TelegramMessage } from "../models/signal.js";
import { AppError } from "../shared/errors.js";
import { runProcess } from "../shared/process.js";
import { ANALYSIS_JSON_SCHEMA, ANALYSIS_SYSTEM_PROMPT, buildAnalysisPayload } from "./prompt-builder.js";
import { signalAnalysisSchema } from "./signal-schema.js";

export interface ClaudeCliAnalyzerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  model?: string | undefined;
}

interface ClaudeResultEnvelope {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

/**
 * Pure parser, kept separate from the spawn so it can be unit-tested against
 * real captured `claude -p --output-format json` fixtures without spawning claude.
 */
export function parseClaudeEnvelope(stdout: string): SignalAnalysis {
  let envelope: ClaudeResultEnvelope;
  try {
    envelope = JSON.parse(stdout.trim()) as ClaudeResultEnvelope;
  } catch (error) {
    throw new AppError("AI_INVALID_JSON", "claude did not return a JSON result envelope", 422, error);
  }
  if (envelope.is_error) throw new AppError("AI_PROCESS_FAILED", "claude reported an error result", 503);
  const candidate: unknown = envelope.structured_output ?? safeParse(envelope.result);
  try {
    return signalAnalysisSchema.parse(candidate);
  } catch (error) {
    throw new AppError("AI_INVALID_JSON", "claude result did not match the expected signal schema", 422, error);
  }
}

function safeParse(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export class ClaudeCliSignalAnalyzer implements SignalAnalyzer {
  constructor(private readonly options: ClaudeCliAnalyzerOptions) {}

  async analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis> {
    const input = buildAnalysisPayload(message, signalId);
    const args = [
      "-p", "--output-format", "json",
      "--tools", "",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--system-prompt", ANALYSIS_SYSTEM_PROMPT,
      "--json-schema", JSON.stringify(ANALYSIS_JSON_SCHEMA)
    ];
    if (this.options.model) args.push("--model", this.options.model);

    let result;
    try {
      result = await runProcess("claude", args, input, { timeoutMs: this.options.timeoutMs, maxOutputBytes: this.options.maxOutputBytes });
    } catch (error) {
      throw new AppError("AI_PROCESS_ERROR", `Unable to start claude: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    if (result.timedOut) throw new AppError("AI_TIMEOUT", "claude timed out", 503);
    if (result.outputExceeded) throw new AppError("AI_OUTPUT_TOO_LARGE", "claude output exceeded configured limit");
    if (result.code !== 0) throw new AppError("AI_PROCESS_FAILED", `claude exited with code ${String(result.code)}: ${result.stderr.slice(0, 500)}`, 503);
    return parseClaudeEnvelope(result.stdout);
  }
}
