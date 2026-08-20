import { describe, expect, it } from "vitest";
import { extractJsonFromKiroOutput, parseKiroOutput } from "../src/agents/kiro-cli-analyzer.js";
import { AppError } from "../src/shared/errors.js";

const ANSI_GREEN = "\x1b[32m";
const ANSI_RESET = "\x1b[0m";

describe("extractJsonFromKiroOutput", () => {
  it("extrae el JSON ignorando colores ANSI y líneas de progreso", () => {
    const raw = `${ANSI_GREEN}▸ Thinking...${ANSI_RESET}\n▸ Reading context\nHere is the result:\n{"isSignal":true,"symbol":"XAUUSD","side":"BUY","entry":3345,"stopLoss":3335,"takeProfit":3370,"confidence":0.9}\nDone.`;
    expect(extractJsonFromKiroOutput(raw)).toEqual({ isSignal: true, symbol: "XAUUSD", side: "BUY", entry: 3345, stopLoss: 3335, takeProfit: 3370, confidence: 0.9 });
  });

  it("ignora texto conversacional antes y después del JSON", () => {
    const raw = "Sure, here you go:\n{\"isSignal\":false}\nLet me know if you need anything else!";
    expect(extractJsonFromKiroOutput(raw)).toEqual({ isSignal: false });
  });

  it("lanza AI_INVALID_JSON si no hay ningún objeto JSON", () => {
    expect(() => extractJsonFromKiroOutput("no json here at all")).toThrow(AppError);
  });

  it("lanza AI_INVALID_JSON si el contenido entre llaves no es JSON válido", () => {
    expect(() => extractJsonFromKiroOutput("{not valid json}")).toThrow(AppError);
  });
});

describe("parseKiroOutput", () => {
  it("valida contra el schema de señal cuando el JSON es correcto", () => {
    const raw = '{"isSignal":true,"symbol":"XAUUSD","side":"BUY","entry":3345,"stopLoss":3335,"takeProfit":3370,"confidence":0.9}';
    expect(parseKiroOutput(raw)).toMatchObject({ isSignal: true, symbol: "XAUUSD", entry: "3345" });
  });

  it("acepta isSignal:false", () => {
    expect(parseKiroOutput('{"isSignal":false}')).toEqual({ isSignal: false });
  });

  it("lanza AI_INVALID_JSON si el JSON no cumple el schema", () => {
    expect(() => parseKiroOutput('{"isSignal":true}')).toThrow(AppError);
  });
});
