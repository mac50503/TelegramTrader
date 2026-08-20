import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";

describe("loadConfig", () => {
  it("trata TELEGRAM_API_ID/HASH vacíos como ausentes, no como un valor inválido", () => {
    const config = testConfig({ TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" });
    expect(config.telegram.apiId).toBeUndefined();
    expect(config.telegram.apiHash).toBeUndefined();
  });

  it("sigue aceptando valores reales de TELEGRAM_API_ID/HASH", () => {
    const config = testConfig({ TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "abc123" });
    expect(config.telegram.apiId).toBe(12345);
    expect(config.telegram.apiHash).toBe("abc123");
  });

  it("rechaza un TELEGRAM_API_ID con un valor no numérico", () => {
    expect(() => testConfig({ TELEGRAM_API_ID: "not-a-number" })).toThrow();
  });
});
