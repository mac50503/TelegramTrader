import type { Logger } from "pino";
import type { SignalAnalyzer } from "../application/ports.js";
import type { SignalAnalysis, TelegramMessage } from "../models/signal.js";
import { logEvent } from "../logging/logger.js";

const SIDE_KEYWORDS = /\b(buy|sell|long|short)\b/i;
const LEVEL_KEYWORDS = /\b(sl|tp|entry|target|stop\s*loss|take\s*profit)\b/i;
const SYMBOL_PATTERNS = /\b([A-Z]{3}(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD)|XAU|XAG|BTC|ETH|US30|US100|NAS100|SPX500|GER40|UK100)\b/i;
const NUMBER_TOKEN = /\d+(\.\d+)?/g;

/**
 * Conservative, deterministic pre-check: only returns false when a message is
 * very unlikely to be a trading signal. Anything ambiguous returns true so the
 * real analyzer (AI CLI) still gets the final call — false negatives here would
 * silently drop real signals, which is worse than an unnecessary AI call.
 */
export function looksLikeTradingSignal(text: string): boolean {
  if (SIDE_KEYWORDS.test(text)) return true;
  if (LEVEL_KEYWORDS.test(text)) return true;
  if (SYMBOL_PATTERNS.test(text)) return true;
  const numbers = text.match(NUMBER_TOKEN);
  return (numbers?.length ?? 0) >= 2;
}

export class PrefilteredSignalAnalyzer implements SignalAnalyzer {
  constructor(private readonly inner: SignalAnalyzer, private readonly logger: Logger) {}

  analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis> {
    if (!looksLikeTradingSignal(message.text)) {
      logEvent(this.logger, "AI_PREFILTER_SKIPPED", { signalId, source: message.source });
      return Promise.resolve({ isSignal: false });
    }
    return this.inner.analyze(message, signalId);
  }
}
