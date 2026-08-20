import type { Logger } from "pino";
import { Decimal } from "decimal.js";
import type { AuditRepository, SignalAnalyzer, SignalRepository, TradeRepository, ContextRepository } from "../application/ports.js";
import type { AppConfig } from "../config/config.js";
import type { TelegramMessage, TradeSignal } from "../models/signal.js";
import type { Mt5Context } from "../models/trade.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { SignalValidator } from "../signals/signal-validator.js";
import { AppError } from "../shared/errors.js";
import { truncateForLog } from "../shared/strings.js";
import { logEvent } from "../logging/logger.js";

export class SignalPipeline {
  private readonly validator: SignalValidator;
  private readonly riskEngine: RiskEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly signals: SignalRepository,
    private readonly trades: TradeRepository,
    private readonly contexts: ContextRepository,
    private readonly analyzer: SignalAnalyzer,
    private readonly logger: Logger,
    private readonly audit: AuditRepository
  ) {
    this.validator = new SignalValidator(config);
    this.riskEngine = new RiskEngine(config);
  }

  async ingest(message: TelegramMessage): Promise<TradeSignal | null> {
    const expiresAt = new Date(Date.parse(message.timestamp) + this.config.signal.ttlSeconds * 1_000).toISOString();
    const signal = this.signals.createFromTelegram(message, expiresAt);
    if (!signal) return null;
    logEvent(this.logger, "TELEGRAM_MESSAGE_RECEIVED", { signalId: signal.id, source: message.source, status: "RECEIVED", chatId: message.chatId, chatName: message.chatName, text: truncateForLog(message.text) });
    this.audit.recordEvent("TELEGRAM_MESSAGE_RECEIVED", { signalId: signal.id, source: message.source, status: "RECEIVED", payload: { chatId: message.chatId, chatName: message.chatName } });
    try {
      this.signals.setStatus(signal.id, "ANALYZING");
      logEvent(this.logger, "SIGNAL_ANALYSIS_STARTED", { signalId: signal.id, source: message.source, status: "ANALYZING", chatName: message.chatName });
      this.audit.recordEvent("SIGNAL_ANALYSIS_STARTED", { signalId: signal.id, source: message.source, status: "ANALYZING" });
      const result = await this.analyzer.analyze(message, signal.id);
      const normalized = result.isSignal ? { ...result, symbol: result.symbol.trim().toUpperCase() } : result;
      this.signals.saveAnalysis(signal.id, normalized);
      if (!normalized.isSignal) {
        this.signals.setStatus(signal.id, "IGNORED");
        logEvent(this.logger, "SIGNAL_IGNORED", { signalId: signal.id, source: message.source, status: "IGNORED", chatName: message.chatName });
        this.audit.recordEvent("SIGNAL_IGNORED", { signalId: signal.id, source: message.source, status: "IGNORED" });
        return this.signals.findById(signal.id);
      }
      logEvent(this.logger, "SIGNAL_DETECTED", {
        signalId: signal.id, source: message.source, status: "ANALYZING", chatName: message.chatName,
        symbol: normalized.symbol, side: normalized.side, confidence: normalized.confidence
      });
      this.audit.recordEvent("SIGNAL_DETECTED", {
        signalId: signal.id, source: message.source, status: "ANALYZING",
        payload: { symbol: normalized.symbol, side: normalized.side, confidence: normalized.confidence }
      });
      const analyzed = this.signals.findById(signal.id)!;
      const validation = this.validator.validate(analyzed);
      if (!validation.valid) return this.reject(analyzed, validation.code, validation.reason);
      const since = new Date(Date.parse(analyzed.receivedAt) - this.config.signal.duplicateWindowSeconds * 1_000).toISOString();
      if (this.signals.hasSemanticDuplicate(analyzed, since)) return this.reject(analyzed, "DUPLICATE_SIGNAL", "Equivalent signal already exists within duplicate window");
      this.signals.setStatus(signal.id, "VALIDATED");
      logEvent(this.logger, "SIGNAL_VALIDATED", { signalId: signal.id, source: message.source, status: "VALIDATED", chatName: message.chatName });
      this.audit.recordEvent("SIGNAL_VALIDATED", { signalId: signal.id, source: message.source, status: "VALIDATED" });
      const context = this.contexts.findLatestContext();
      if (context) this.applyRiskAndQueue(signal.id, context);
      return this.signals.findById(signal.id);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("PIPELINE_ERROR", error instanceof Error ? error.message : "Unknown pipeline error", 500);
      this.signals.setStatus(signal.id, "ERROR", { code: appError.code, message: appError.message });
      this.logger.error({ event: "SYSTEM_ERROR", signalId: signal.id, code: appError.code, err: appError }, appError.message);
      this.audit.recordError({ signalId: signal.id, code: appError.code, message: appError.message, details: appError.details });
      this.audit.recordEvent("SYSTEM_ERROR", { signalId: signal.id, source: message.source, status: "ERROR", payload: { code: appError.code } });
      return this.signals.findById(signal.id);
    }
  }

  processValidated(context: Mt5Context): void {
    for (const signal of this.signals.list(100, 0, "VALIDATED")) this.applyRiskAndQueue(signal.id, context);
  }

  private applyRiskAndQueue(signalId: string, context: Mt5Context): void {
    const signal = this.signals.findById(signalId);
    if (!signal || signal.status !== "VALIDATED") return;
    if (Date.now() >= Date.parse(signal.expiresAt)) { this.signals.setStatus(signal.id, "EXPIRED"); return; }
    if (Date.now() - Date.parse(context.capturedAt) > this.config.risk.contextMaxAgeSeconds * 1_000) return;
    const spec = context.symbols.find((item) => item.canonicalSymbol.toUpperCase() === signal.symbol?.toUpperCase());
    if (!spec) { this.reject(signal, "UNSUPPORTED_SYMBOL", "No broker symbol mapping/specification is available"); return; }
    const startOfUtcDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    if (this.trades.countDailyTrades(startOfUtcDay) >= this.config.risk.maxDailyTrades) {
      this.reject(signal, "MAX_DAILY_TRADES", "Daily trade limit reached"); return;
    }
    if (new Decimal(this.trades.realizedDailyLoss(startOfUtcDay)).gte(this.config.risk.maxDailyLoss)) {
      this.reject(signal, "MAX_DAILY_LOSS", "Daily loss limit reached"); return;
    }
    const decision = this.riskEngine.evaluate(signal, context, spec);
    if (!decision.approved) { this.reject(signal, decision.code, decision.reason); return; }
    this.signals.saveValidated(signal.id, decision.volume, JSON.stringify({ valid: true, risk: decision, contextCapturedAt: context.capturedAt, brokerSymbol: spec.brokerSymbol }));
    this.signals.setStatus(signal.id, "QUEUED");
    logEvent(this.logger, "SIGNAL_QUEUED", { signalId: signal.id, source: signal.source, status: "QUEUED", chatName: signal.chatName, symbol: signal.symbol, side: signal.side, volume: decision.volume });
    this.audit.recordEvent("SIGNAL_QUEUED", { signalId: signal.id, source: signal.source, status: "QUEUED", payload: { symbol: signal.symbol, side: signal.side, volume: decision.volume } });
  }

  private reject(signal: TradeSignal, code: string, reason: string): TradeSignal {
    this.signals.setStatus(signal.id, "REJECTED", { code, message: reason });
    logEvent(this.logger, "SIGNAL_REJECTED", { signalId: signal.id, source: signal.source, status: "REJECTED", chatName: signal.chatName, symbol: signal.symbol, code, reason });
    this.audit.recordEvent("SIGNAL_REJECTED", { signalId: signal.id, source: signal.source, status: "REJECTED", payload: { symbol: signal.symbol, code, reason } });
    return this.signals.findById(signal.id)!;
  }
}
