import { describe, expect, it } from "vitest";
import { detectProvider } from "../src/agents/provider-detector.js";
import { runProcess } from "../src/shared/process.js";

const fakeRunner: typeof runProcess = async (command) => {
  if (command === "available-cli") return { stdout: "1.0.0", stderr: "", code: 0, timedOut: false, outputExceeded: false };
  if (command === "broken-cli") return { stdout: "", stderr: "boom", code: 1, timedOut: false, outputExceeded: false };
  throw new Error("command not found");
};

describe("detectProvider", () => {
  it("devuelve el primer candidato que responde, respetando el orden", async () => {
    const result = await detectProvider(["missing-cli", "available-cli", "broken-cli"], 1_000, fakeRunner);
    expect(result).toBe("available-cli");
  });

  it("salta candidatos que no existen o fallan", async () => {
    const result = await detectProvider(["missing-cli", "broken-cli"], 1_000, fakeRunner);
    expect(result).toBeNull();
  });

  it("devuelve null cuando la lista está vacía", async () => {
    expect(await detectProvider([], 1_000, fakeRunner)).toBeNull();
  });

  it("funciona con un runner real contra un binario que sí existe", async () => {
    const result = await detectProvider([process.execPath], 5_000);
    expect(result).toBe(process.execPath);
  });
});
