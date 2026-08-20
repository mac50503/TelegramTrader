import type { SignalAnalyzer } from "../application/ports.js";
import type { SignalAnalysis, TelegramMessage } from "../models/signal.js";
import { AppError } from "../shared/errors.js";
import { runProcess } from "../shared/process.js";
import { buildAnalysisPayload } from "./prompt-builder.js";
import { signalAnalysisSchema } from "./signal-schema.js";

export interface CliAnalyzerOptions {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export class CliSignalAnalyzer implements SignalAnalyzer {
  constructor(private readonly options: CliAnalyzerOptions) {}

  async analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis> {
    const input = buildAnalysisPayload(message, signalId);
    let result;
    try {
      result = await runProcess(this.options.command, this.options.args, input, {
        timeoutMs: this.options.timeoutMs,
        maxOutputBytes: this.options.maxOutputBytes
      });
    } catch (error) {
      throw new AppError("AI_PROCESS_ERROR", `Unable to start AI analyzer: ${error instanceof Error ? error.message : String(error)}`, 503);
    }
    if (result.timedOut) throw new AppError("AI_TIMEOUT", "AI analyzer timed out", 503);
    if (result.outputExceeded) throw new AppError("AI_OUTPUT_TOO_LARGE", "AI output exceeded configured limit");
    if (result.code !== 0) throw new AppError("AI_PROCESS_FAILED", `AI analyzer exited with code ${String(result.code)}: ${result.stderr.slice(0, 500)}`, 503);
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      return signalAnalysisSchema.parse(parsed);
    } catch (error) {
      throw new AppError("AI_INVALID_JSON", "AI analyzer returned invalid structured JSON", 422, error);
    }
  }
}

export class DisabledSignalAnalyzer implements SignalAnalyzer {
  async analyze(): Promise<SignalAnalysis> { return { isSignal: false }; }
}
