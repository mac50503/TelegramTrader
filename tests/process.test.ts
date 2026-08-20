import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/shared/process.js";

describe("runProcess", () => {
  it("captura stdout y exit code de un proceso exitoso", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdin.resume(); process.stdout.write('ok')"], "hello", { timeoutMs: 5_000, maxOutputBytes: 1_024 });
    expect(result.stdout).toBe("ok");
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputExceeded).toBe(false);
  });

  it("marca timedOut cuando el proceso no termina a tiempo", async () => {
    const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], "", { timeoutMs: 200, maxOutputBytes: 1_024 });
    expect(result.timedOut).toBe(true);
  });

  it("marca outputExceeded cuando la salida supera el límite", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], "", { timeoutMs: 5_000, maxOutputBytes: 100 });
    expect(result.outputExceeded).toBe(true);
  });

  it("propaga el exit code distinto de cero", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.exit(7)"], "", { timeoutMs: 5_000, maxOutputBytes: 1_024 });
    expect(result.code).toBe(7);
  });

  it.skipIf(process.platform !== "win32")("puede ejecutar un shim .cmd de Windows (regresión: cross-spawn)", async () => {
    const cmdPath = join(tmpdir(), `runprocess-test-${randomUUID()}.cmd`);
    writeFileSync(cmdPath, "@echo off\r\necho ok\r\n");
    try {
      const result = await runProcess(cmdPath, [], "", { timeoutMs: 5_000, maxOutputBytes: 1_024 });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    } finally {
      rmSync(cmdPath, { force: true });
    }
  });

  it("pasa variables de entorno extra al proceso hijo", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.env.TT_TEST_VAR || '')"], "", {
      timeoutMs: 5_000, maxOutputBytes: 1_024, extraEnv: { TT_TEST_VAR: "hello" }
    });
    expect(result.stdout).toBe("hello");
  });
});
