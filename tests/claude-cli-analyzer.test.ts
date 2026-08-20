import { describe, expect, it } from "vitest";
import { parseClaudeEnvelope } from "../src/agents/claude-cli-analyzer.js";
import { AppError } from "../src/shared/errors.js";

// Fixtures captured from a real `claude -p --output-format json --json-schema ...` run.
const SIGNAL_ENVELOPE = JSON.stringify({
  is_error: false, subtype: "success", type: "result",
  result: "{\"isSignal\":true,\"symbol\":\"XAUUSD\",\"side\":\"BUY\",\"entry\":3345,\"stopLoss\":3335,\"takeProfit\":3370,\"confidence\":0.95}",
  structured_output: { isSignal: true, symbol: "XAUUSD", side: "BUY", entry: 3345, stopLoss: 3335, takeProfit: 3370, confidence: 0.95 }
});

const NO_SIGNAL_ENVELOPE = JSON.stringify({
  is_error: false, subtype: "success", type: "result",
  result: "{\"isSignal\":false}",
  structured_output: { isSignal: false }
});

describe("parseClaudeEnvelope", () => {
  it("usa structured_output cuando hay una señal", () => {
    expect(parseClaudeEnvelope(SIGNAL_ENVELOPE)).toMatchObject({ isSignal: true, symbol: "XAUUSD", entry: "3345" });
  });

  it("usa structured_output cuando no hay señal", () => {
    expect(parseClaudeEnvelope(NO_SIGNAL_ENVELOPE)).toEqual({ isSignal: false });
  });

  it("recurre a parsear result si structured_output falta", () => {
    const envelope = JSON.stringify({ is_error: false, result: "{\"isSignal\":false}" });
    expect(parseClaudeEnvelope(envelope)).toEqual({ isSignal: false });
  });

  it("lanza AI_PROCESS_FAILED cuando is_error es true", () => {
    const envelope = JSON.stringify({ is_error: true, result: "" });
    expect(() => parseClaudeEnvelope(envelope)).toThrow(AppError);
    try {
      parseClaudeEnvelope(envelope);
    } catch (error) {
      expect((error as AppError).code).toBe("AI_PROCESS_FAILED");
    }
  });

  it("lanza AI_INVALID_JSON si el envelope no es JSON", () => {
    expect(() => parseClaudeEnvelope("not json at all")).toThrow(AppError);
  });

  it("lanza AI_INVALID_JSON si structured_output no cumple el schema", () => {
    const envelope = JSON.stringify({ is_error: false, structured_output: { isSignal: true } });
    expect(() => parseClaudeEnvelope(envelope)).toThrow(AppError);
  });
});
