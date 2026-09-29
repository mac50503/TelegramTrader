import type { Logger } from "pino";
import { Decimal } from "decimal.js";
import type { AuditRepository, ManagementRepository, SignalAnalyzer, SignalRepository, TradeRepository, ContextRepository } from "../application/ports.js";
import type { AppConfig } from "../config/config.js";
import type { SignalAnalysis, TelegramMessage, TradeSignal } from "../models/signal.js";
import type { Mt5Context } from "../models/trade.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { SignalValidator } from "../signals/signal-validator.js";
import { AppError } from "../shared/errors.js";
import { truncateForLog } from "../shared/strings.js";
import { logEvent } from "../logging/logger.js";

// FX KINGS - PULSE publishes several target legs for one setup. The requested
// channel policy keeps every leg, but closes the complete group at TP1.
const TP1_FOR_ALL_LEGS_CHAT_IDS = new Set(["-1003915755639"]);

export class SignalPipeline {
  private readonly validator: SignalValidator;
  private readonly riskEngine: RiskEngine;
  private readonly management: ManagementRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly signals: SignalRepository,
    private readonly trades: TradeRepository,
    private readonly contexts: ContextRepository,
    private readonly analyzer: SignalAnalyzer,
    private readonly logger: Logger,
    private readonly audit: AuditRepository,
    management?: ManagementRepository
  ) {
    this.validator = new SignalValidator(config);
    this.riskEngine = new RiskEngine(config);
    this.management = management ?? (signals as unknown as ManagementRepository);
  }

  async ingest(message: TelegramMessage): Promise<TradeSignal | null> {
    // Enforce the Telegram allow-list at the trading boundary as a defense in
    // depth. The adapter filters incoming messages, but queued/replayed or
    // alternate ingestion paths must never be able to execute a disabled chat.
    if (message.source === "TELEGRAM" && this.config.telegram.allowedChats.size > 0 && !this.config.telegram.allowedChats.has(message.chatId)) {
      this.logger.warn({ event: "SIGNAL_IGNORED", source: message.source, status: "IGNORED", chatId: message.chatId, chatName: message.chatName }, "Telegram chat is not authorized");
      return null;
    }
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
      if ("intent" in result && result.intent === "MANAGEMENT") {
        const instruction = this.management.createManagementFromTelegram(message, result.action, result.symbolHint, result.explicitStopLoss);
        this.signals.setStatus(signal.id, "IGNORED", { code: "MANAGEMENT_INSTRUCTION", message: "Telegram message stored as management instruction" });
        if (instruction) {
          const groups = this.management.findOpenGroupsForChat(message.chatId);
          if (groups.length === 0) {
            this.management.markRejected(instruction.id, "NO_OPEN_TRADE", "No open FILLED trade group for this chat");
            this.audit.recordEvent("MANAGEMENT_REJECTED", { source: message.source, status: "REJECTED", payload: { instructionId: instruction.id, code: "NO_OPEN_TRADE" } });
          } else if (groups.length > 1) {
            this.management.markAmbiguous(instruction.id, groups);
            this.audit.recordEvent("MANAGEMENT_AMBIGUOUS", { source: message.source, status: "AMBIGUOUS", payload: { instructionId: instruction.id, groups } });
          } else if (result.action === "CLOSE_PARTIAL" && this.management.countOpenTradesForGroup(groups[0]!) < 2) {
            this.management.markRejected(instruction.id, "PARTIAL_VOLUME_REQUIRED", "A single open position needs an explicit partial-close volume");
            this.audit.recordEvent("MANAGEMENT_REJECTED", { source: message.source, status: "REJECTED", payload: { instructionId: instruction.id, code: "PARTIAL_VOLUME_REQUIRED" } });
          } else {
            this.management.resolve(instruction.id, groups[0]!);
            const commands = this.management.createCommandsForGroup(instruction.id, groups[0]!, result.action);
            this.audit.recordEvent("MANAGEMENT_RESOLVED", { source: message.source, status: "RESOLVED", payload: { instructionId: instruction.id, groupId: groups[0] } });
            for (const command of commands) this.audit.recordEvent("MANAGEMENT_COMMAND_CREATED", { tradeId: command.tradeId, source: message.source, status: "PENDING", payload: { instructionId: instruction.id, commandId: command.id, type: command.type } });
          }
        }
        return this.signals.findById(signal.id);
      }
      const isNewSignal = ("isSignal" in result && result.isSignal) || ("intent" in result && result.intent === "NEW_SIGNAL");
      const normalized = isNewSignal ? ({ ...result, symbol: result.symbol.trim().toUpperCase() } as Extract<SignalAnalysis, { isSignal: true }> | Extract<SignalAnalysis, { intent: "NEW_SIGNAL" }>) : result;
      this.signals.saveAnalysis(signal.id, normalized);
      if (!isNewSignal) {
        this.signals.setStatus(signal.id, "IGNORED");
        logEvent(this.logger, "SIGNAL_IGNORED", { signalId: signal.id, source: message.source, status: "IGNORED", chatName: message.chatName });
        this.audit.recordEvent("SIGNAL_IGNORED", { signalId: signal.id, source: message.source, status: "IGNORED" });
        return this.signals.findById(signal.id);
      }
      const legCount = (normalized as Extract<SignalAnalysis, { isSignal: true }>).takeProfits.length;
      const takeProfits = (normalized as Extract<SignalAnalysis, { isSignal: true }>).takeProfits;
      const siblingTakeProfits = TP1_FOR_ALL_LEGS_CHAT_IDS.has(message.chatId)
        ? takeProfits.map(() => takeProfits[0]!)
        : takeProfits;
      for (let legIndex = 1; legIndex < legCount; legIndex++) {
        const parent = this.signals.findById(signal.id)!;
        const sibling = this.signals.createSiblingLeg(parent, legIndex, legCount, siblingTakeProfits[legIndex]!, signal.id);
        this.processLeg(sibling.id);
      }
      return this.processLeg(signal.id);
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

  private processLeg(signalId: string): TradeSignal {
    const analyzed = this.signals.findById(signalId)!;
    try {
      logEvent(this.logger, "SIGNAL_DETECTED", {
        signalId, source: analyzed.source, status: "ANALYZING", chatName: analyzed.chatName,
        symbol: analyzed.symbol, side: analyzed.side, confidence: analyzed.confidence
      });
      this.audit.recordEvent("SIGNAL_DETECTED", {
        signalId, source: analyzed.source, status: "ANALYZING",
        payload: { symbol: analyzed.symbol, side: analyzed.side, confidence: analyzed.confidence, legIndex: analyzed.legIndex, legCount: analyzed.legCount }
      });
      const validation = this.validator.validate(analyzed);
      if (!validation.valid) return this.reject(analyzed, validation.code, validation.reason);
      const since = new Date(Date.parse(analyzed.receivedAt) - this.config.signal.duplicateWindowSeconds * 1_000).toISOString();
      if (this.signals.hasSemanticDuplicate(analyzed, since)) return this.reject(analyzed, "DUPLICATE_SIGNAL", "Equivalent signal already exists within duplicate window");
      this.signals.setStatus(signalId, "VALIDATED");
      logEvent(this.logger, "SIGNAL_VALIDATED", { signalId, source: analyzed.source, status: "VALIDATED", chatName: analyzed.chatName });
      this.audit.recordEvent("SIGNAL_VALIDATED", { signalId, source: analyzed.source, status: "VALIDATED" });
      const context = this.contexts.findLatestContext();
      if (context) this.applyRiskAndQueue(signalId, context);
      return this.signals.findById(signalId)!;
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("PIPELINE_ERROR", error instanceof Error ? error.message : "Unknown pipeline error", 500);
      this.signals.setStatus(signalId, "ERROR", { code: appError.code, message: appError.message });
      this.logger.error({ event: "SYSTEM_ERROR", signalId, code: appError.code, err: appError }, appError.message);
      this.audit.recordError({ signalId, code: appError.code, message: appError.message, details: appError.details });
      this.audit.recordEvent("SYSTEM_ERROR", { signalId, source: analyzed.source, status: "ERROR", payload: { code: appError.code } });
      return this.signals.findById(signalId)!;
    }
  }

  private applyRiskAndQueue(signalId: string, context: Mt5Context): void {
    const signal = this.signals.findById(signalId);
    if (!signal || signal.status !== "VALIDATED") return;
    if (Date.now() >= Date.parse(signal.expiresAt)) { this.signals.setStatus(signal.id, "EXPIRED"); return; }
    if (Date.now() - Date.parse(context.capturedAt) > this.config.risk.contextMaxAgeSeconds * 1_000) return;
    const spec = context.symbols.find((item) => item.canonicalSymbol.toUpperCase() === signal.symbol?.toUpperCase());
    if (!spec) { this.reject(signal, "UNSUPPORTED_SYMBOL", "No broker symbol mapping/specification is available"); return; }
    const startOfUtcDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    if (this.trades.countDailyTrades(startOfUtcDay, this.config.tradingMode) >= this.config.risk.maxDailyTrades) {
      this.reject(signal, "MAX_DAILY_TRADES", "Daily trade limit reached"); return;
    }
    if (new Decimal(this.trades.realizedDailyLoss(startOfUtcDay, this.config.tradingMode)).gte(this.config.risk.maxDailyLoss)) {
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
