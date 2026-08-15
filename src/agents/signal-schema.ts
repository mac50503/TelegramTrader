import { z } from "zod";

const decimal = z.union([z.string(), z.number()]).transform((value) => String(value));

export const signalAnalysisSchema = z.discriminatedUnion("isSignal", [
  z.object({ isSignal: z.literal(false) }).strict(),
  z.object({
    isSignal: z.literal(true),
    symbol: z.string().min(1).max(30),
    side: z.enum(["BUY", "SELL"]),
    entry: decimal,
    stopLoss: decimal,
    takeProfit: decimal,
    lot: decimal.optional(),
    riskPercentage: decimal.optional(),
    confidence: z.number().min(0).max(1)
  }).strict()
]);
