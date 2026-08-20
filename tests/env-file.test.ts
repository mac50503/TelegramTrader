import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEnvFile, writeEnvUpdates } from "../src/config/env-file.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-env-file-"));
  envPath = join(dir, ".env");
  writeFileSync(envPath, [
    "# comentario",
    "NODE_ENV=development",
    "",
    "API_KEY=test-api-key-at-least-16",
    "AI_CLAUDE_MODEL=haiku",
    "TRADING_MODE=SIMULATION"
  ].join("\n"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readEnvFile", () => {
  it("parsea el archivo a un objeto plano", () => {
    expect(readEnvFile(envPath)).toMatchObject({ NODE_ENV: "development", AI_CLAUDE_MODEL: "haiku" });
  });

  it("devuelve un objeto vacío si el archivo no existe", () => {
    expect(readEnvFile(join(dir, "no-existe.env"))).toEqual({});
  });
});

describe("writeEnvUpdates", () => {
  it("actualiza una clave existente conservando comentarios, orden y líneas en blanco", () => {
    writeEnvUpdates(envPath, { AI_CLAUDE_MODEL: "opus" });
    const raw = readFileSync(envPath, "utf8");
    expect(raw).toContain("# comentario");
    expect(raw).toContain("AI_CLAUDE_MODEL=opus");
    expect(raw.split("\n")[2]).toBe("");
  });

  it("agrega una clave nueva al final si no existía en el archivo", () => {
    writeEnvUpdates(envPath, { AI_CODEX_SANDBOX: "read-only" });
    expect(readEnvFile(envPath).AI_CODEX_SANDBOX).toBe("read-only");
  });

  it("rechaza una clave que no es una variable real del proyecto", () => {
    expect(() => writeEnvUpdates(envPath, { NOT_A_REAL_VAR: "x" })).toThrow(/Unknown environment variable/);
  });

  it("rechaza una combinación que no pasaría loadConfig (LIVE sin confirmación)", () => {
    expect(() => writeEnvUpdates(envPath, { TRADING_MODE: "LIVE" })).toThrow();
    expect(readEnvFile(envPath).TRADING_MODE).toBe("SIMULATION");
  });

  it("acepta LIVE cuando también se manda la confirmación", () => {
    writeEnvUpdates(envPath, { TRADING_MODE: "LIVE", LIVE_TRADING_CONFIRM: "I_UNDERSTAND_LIVE_TRADING" });
    expect(readEnvFile(envPath).TRADING_MODE).toBe("LIVE");
  });
});
