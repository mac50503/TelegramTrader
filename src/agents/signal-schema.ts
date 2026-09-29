import { Decimal } from "decimal.js";
import { z } from "zod";
import { managementActions } from "../models/signal.js";

const decimal = z.union([z.string(), z.number()]).transform((value) => String(value));

const detectedSignalSchema = z.object({
    isSignal: z.literal(true),
    symbol: z.string().min(1).max(30),
    side: z.enum(["BUY", "SELL"]),
    entry: decimal.optional(),
    entryMin: decimal.optional(),
    entryMax: decimal.optional(),
    stopLoss: decimal,
    takeProfits: z.array(decimal).min(1),
    lot: decimal.optional(),
    riskPercentage: decimal.optional(),
    confidence: z.number().min(0).max(1)
  }).strict().superRefine((value, context) => {
    if ((!value.entryMin || !value.entryMax) && !value.entry) {
      context.addIssue({ code: "custom", message: "entryMin and entryMax, or legacy entry, are required" });
    }
  }).transform((value) => {
    const first = value.entryMin ?? value.entry!;
    const second = value.entryMax ?? value.entry!;
    let entryMin = first;
    let entryMax = second;
    try {
      if (new Decimal(first).gt(second)) [entryMin, entryMax] = [second, first];
    } catch { /* Price validation reports malformed decimals later. */ }
    return { ...value, entryMin, entryMax, entry: value.entry ?? (value.side === "BUY" ? entryMin : entryMax) };
  });

const legacySignalAnalysisSchema = z.discriminatedUnion("isSignal", [
  z.object({ isSignal: z.literal(false) }).strict(),
  detectedSignalSchema
]);

export const managementAnalysisSchema = z.union([
  z.object({ intent: z.literal("NONE") }).strict(),
  z.object({ intent: z.literal("MANAGEMENT"), action: z.enum(managementActions), symbolHint: z.string().nullable().optional().default(null), explicitStopLoss: decimal.nullable().optional().default(null), confidence: z.number().min(0).max(1) }).passthrough(),
  z.object({ intent: z.literal("NEW_SIGNAL"), symbol: z.string().min(1).max(30), side: z.enum(["BUY", "SELL"]), entry: decimal, entryMin: decimal, entryMax: decimal, stopLoss: decimal, takeProfits: z.array(decimal).min(1), lot: decimal.optional(), riskPercentage: decimal.optional(), confidence: z.number().min(0).max(1) }).passthrough()
]);

export const signalAnalysisSchema = z.union([legacySignalAnalysisSchema, managementAnalysisSchema]);
