import { runProcess } from "../shared/process.js";

export type ProcessRunner = typeof runProcess;

/**
 * Tries each candidate command with `--version` in order and returns the first
 * one that exits successfully. Meant to be called once at startup and cached —
 * re-probing on every message would add latency for no benefit.
 */
export async function detectProvider(
  candidates: readonly string[],
  timeoutMs: number,
  runner: ProcessRunner = runProcess
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const result = await runner(candidate, ["--version"], "", { timeoutMs, maxOutputBytes: 4_096 });
      if (result.code === 0 && !result.timedOut) return candidate;
    } catch {
      // Binary not found or failed to spawn: try the next candidate.
    }
  }
  return null;
}
