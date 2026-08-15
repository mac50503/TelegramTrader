import { loadConfig } from "../src/config/config.js";
import type { Mt5Context } from "../src/models/trade.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: ":memory:",
    API_KEY: "test-api-key-at-least-16",
    TRADING_MODE: "SIMULATION",
    AI_MIN_CONFIDENCE: "0.7",
    MAX_LOT: "10",
    MAX_RISK_PERCENT: "2",
    MAX_DAILY_TRADES: "5",
    MAX_DAILY_LOSS: "500",
    MAX_SIMULTANEOUS_TRADES: "1",
    DEFAULT_FIXED_LOT: "0.1",
    ...overrides
  });
}

export function mt5Context(clientId = "test-ea"): Mt5Context {
  return {
    clientId, accountId: "123456", broker: "Test Broker", currency: "USD", balance: "10000", equity: "10000",
    capturedAt: new Date().toISOString(),
    symbols: [{
      canonicalSymbol: "XAUUSD", brokerSymbol: "XAUUSD.a", digits: 2, point: "0.01", tickSize: "0.01",
      tickValueProfit: "1", tickValueLoss: "1", contractSize: "100", volumeMin: "0.01", volumeMax: "100", volumeStep: "0.01"
    }]
  };
}
