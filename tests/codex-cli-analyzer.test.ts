import { describe, expect, it } from "vitest";
import { parseCodexOutput } from "../src/agents/codex-cli-analyzer.js";
import { AppError } from "../src/shared/errors.js";

describe("parseCodexOutput", () => {
  it("acepta JSON limpio (caso esperado con --output-schema)", () => {
    const raw = '{"isSignal":true,"symbol":"XAUUSD","side":"BUY","entry":3345,"stopLoss":3335,"takeProfit":3370,"confidence":0.9}';
    expect(parseCodexOutput(raw)).toMatchObject({ isSignal: true, symbol: "XAUUSD", entry: "3345" });
  });

  it("acepta JSON limpio con espacios/saltos de línea alrededor", () => {
    expect(parseCodexOutput("\n  {\"isSignal\":false}  \n")).toEqual({ isSignal: false });
  });

  it("recurre a extraer el objeto si hay texto adicional (fallback)", () => {
    const raw = "Here is the result:\n{\"isSignal\":false}\nHope that helps!";
    expect(parseCodexOutput(raw)).toEqual({ isSignal: false });
  });

  it("lanza AI_INVALID_JSON si no hay ningún JSON", () => {
    expect(() => parseCodexOutput("no json at all")).toThrow(AppError);
  });

  it("lanza AI_INVALID_JSON si el JSON no cumple el schema de señal", () => {
    expect(() => parseCodexOutput('{"isSignal":true}')).toThrow(AppError);
  });
});
