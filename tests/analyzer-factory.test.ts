import { describe, expect, it } from "vitest";
import { createSignalAnalyzer } from "../src/agents/analyzer-factory.js";
import { ClaudeCliSignalAnalyzer } from "../src/agents/claude-cli-analyzer.js";
import { CliSignalAnalyzer, DisabledSignalAnalyzer } from "../src/agents/cli-signal-analyzer.js";
import { CodexCliSignalAnalyzer } from "../src/agents/codex-cli-analyzer.js";
import { KiroCliSignalAnalyzer } from "../src/agents/kiro-cli-analyzer.js";
import { createLogger } from "../src/logging/logger.js";
import { testConfig } from "./helpers.js";

const logger = createLogger(testConfig());
const neverCalled = async (): Promise<string | null> => { throw new Error("detector should not be called"); };

describe("createSignalAnalyzer", () => {
  it("usa DisabledSignalAnalyzer cuando AI_AGENT_ENABLED=false", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "false" });
    const analyzer = await createSignalAnalyzer(config, logger, neverCalled);
    expect(analyzer).toBeInstanceOf(DisabledSignalAnalyzer);
  });

  it("AI_AGENT_COMMAND siempre gana sobre la detección de proveedores", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "true", AI_AGENT_COMMAND: "my-custom-script" });
    const analyzer = await createSignalAnalyzer(config, logger, neverCalled);
    expect(analyzer).toBeInstanceOf(CliSignalAnalyzer);
  });

  it("usa ClaudeCliSignalAnalyzer cuando el detector elige claude", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "true" });
    const analyzer = await createSignalAnalyzer(config, logger, async () => "claude");
    expect(analyzer).toBeInstanceOf(ClaudeCliSignalAnalyzer);
  });

  it("usa CodexCliSignalAnalyzer cuando el detector elige codex", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "true" });
    const codexAnalyzer = await createSignalAnalyzer(config, logger, async () => "codex");
    expect(codexAnalyzer).toBeInstanceOf(CodexCliSignalAnalyzer);
  });

  it("usa KiroCliSignalAnalyzer cuando el detector elige kiro-cli", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "true" });
    const kiroAnalyzer = await createSignalAnalyzer(config, logger, async () => "kiro-cli");
    expect(kiroAnalyzer).toBeInstanceOf(KiroCliSignalAnalyzer);
  });

  it("usa CliSignalAnalyzer genérico para un nombre de proveedor custom desconocido", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "true" });
    const analyzer = await createSignalAnalyzer(config, logger, async () => "some-other-cli");
    expect(analyzer).toBeInstanceOf(CliSignalAnalyzer);
  });

  it("usa DisabledSignalAnalyzer cuando ningún proveedor responde", async () => {
    const config = testConfig({ AI_AGENT_ENABLED: "true" });
    const analyzer = await createSignalAnalyzer(config, logger, async () => null);
    expect(analyzer).toBeInstanceOf(DisabledSignalAnalyzer);
  });
});
