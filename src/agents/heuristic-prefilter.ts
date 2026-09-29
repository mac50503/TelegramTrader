import type { Logger } from "pino";
import type { SignalAnalyzer } from "../application/ports.js";
import type { SignalAnalysis, TelegramMessage } from "../models/signal.js";
import { logEvent } from "../logging/logger.js";

const SIDE_KEYWORDS = /\b(buy|sell|long|short)\b/i;
const LEVEL_KEYWORDS = /\b(sl|tp|entry|target|stop\s*loss|take\s*profit)\b/i;
const MANAGEMENT_KEYWORDS = /\b(breakeven|be|take\s*partials?|partial\s*profit|move\s+(the\s+)?(sl|stop\s*loss)|set\s+be|close\s+(the\s+)?(trade|position))\b/i;
const SYMBOL_PATTERNS = /\b([A-Z]{3}(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD)|XAU|XAG|BTC|ETH|US30|US100|NAS100|SPX500|GER40|UK100)\b/i;
const NUMBER_TOKEN = /\d+(\.\d+)?/g;
const ALGORITMO_XAU_CHAT_ID = "-1003802258175";
const ALGORITMO_XAU_CLOSE_NOW = /\bvamos\s+encerrar\s+a\s+opera[cç][aã]o\s+agora\b/i;

export function explicitManagementInstruction(text: string): SignalAnalysis | null {
  // A running-trade update with both instructions is unambiguously management,
  // even when a CLI classifies it as ordinary chat. Never infer a new entry here.
  if (/\btrade\s+(?:is\s+)?active\b/i.test(text)
    && /\btake\s+partials?\b/i.test(text)
    && /\b(?:breakeven|set\s+be)\b/i.test(text)
    && !/\bentry\b/i.test(text)) {
    return { intent: "MANAGEMENT", action: "TAKE_PARTIALS_AND_BREAKEVEN", symbolHint: null, explicitStopLoss: null, confidence: 1 };
  }
  return null;
}

/**
 * Conservative, deterministic pre-check: only returns false when a message is
 * very unlikely to be a trading signal. Anything ambiguous returns true so the
 * real analyzer (AI CLI) still gets the final call — false negatives here would
 * silently drop real signals, which is worse than an unnecessary AI call.
 */
export function looksLikeTradingSignal(text: string): boolean {
  if (MANAGEMENT_KEYWORDS.test(text)) return true;
  if (SIDE_KEYWORDS.test(text)) return true;
  if (LEVEL_KEYWORDS.test(text)) return true;
  if (SYMBOL_PATTERNS.test(text)) return true;
  const numbers = text.match(NUMBER_TOKEN);
  return (numbers?.length ?? 0) >= 2;
}

export class PrefilteredSignalAnalyzer implements SignalAnalyzer {
  constructor(private readonly inner: SignalAnalyzer, private readonly logger: Logger) {}

  analyze(message: TelegramMessage, signalId: string): Promise<SignalAnalysis> {
    if (message.chatId === ALGORITMO_XAU_CHAT_ID && ALGORITMO_XAU_CLOSE_NOW.test(message.text)) {
      return Promise.resolve({ intent: "MANAGEMENT", action: "CLOSE_ALL", symbolHint: null, explicitStopLoss: null, confidence: 1 });
    }
    const management = explicitManagementInstruction(message.text);
    if (management) return Promise.resolve(management);
    if (!looksLikeTradingSignal(message.text)) {
      logEvent(this.logger, "AI_PREFILTER_SKIPPED", { signalId, source: message.source });
      return Promise.resolve({ isSignal: false });
    }
    return this.inner.analyze(message, signalId);
  }
}
