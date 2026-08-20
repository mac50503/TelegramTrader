import { existsSync, readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import { envSchema, loadConfig } from "./config.js";

export const ENV_KEYS: readonly string[] = envSchema.keyof().options;

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return dotenv.parse(readFileSync(path, "utf8"));
}

/**
 * Rewrites only the given keys in-place (keeps comments, blank lines and ordering of
 * everything else). Validates the resulting env by running the exact same `loadConfig` the
 * app uses on startup (schema + cross-field rules like "LIVE requires confirmation") before
 * touching disk, so a bad combination fails here instead of crashing the app on restart.
 */
export function writeEnvUpdates(path: string, updates: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(updates)) {
    if (!ENV_KEYS.includes(key)) throw new Error(`Unknown environment variable: ${key}`);
  }

  const current = readEnvFile(path);
  const merged = { ...current, ...updates };
  loadConfig(merged);

  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const written = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (!key || !(key in updates)) return line;
    written.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) nextLines.push(`${key}=${value}`);
  }
  writeFileSync(path, nextLines.join("\n"));
  return merged;
}
