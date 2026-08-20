import { z } from "zod";

const decimal = z.union([z.string(), z.number()]).transform(String);
const timestamp = z.string().datetime({ offset: true });

export const clientQuerySchema = z.object({ clientId: z.string().min(1).max(100) });
export const signalListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["RECEIVED", "ANALYZING", "IGNORED", "VALIDATED", "QUEUED", "ASSIGNED", "EXECUTED", "CLOSED", "REJECTED", "EXPIRED", "ERROR", "RECONCILIATION_REQUIRED"]).optional()
});

export const assignedSchema = z.object({ clientId: z.string().min(1), assignmentToken: z.string().min(20) }).strict();

export const executionSchema = z.object({
  clientId: z.string().min(1), assignmentToken: z.string().min(20), executionId: z.string().min(8),
  result: z.enum(["SIMULATED_EXECUTION", "FILLED", "REJECTED", "UNKNOWN"]),
  requestedPrice: decimal, executionPrice: decimal.optional(), requestedVolume: decimal, executedVolume: decimal.optional(),
  orderTicket: z.string().optional(), dealTicket: z.string().optional(), positionTicket: z.string().optional(),
  retcode: z.string().optional(), errorCode: z.string().optional(), errorDescription: z.string().max(1000).optional(),
  brokerResponse: z.unknown().optional(), executedAt: timestamp
}).strict();

export const closeSchema = z.object({
  clientId: z.string().min(1), assignmentToken: z.string().min(20), closePrice: decimal,
  grossProfit: decimal, commission: decimal.default("0"), swap: decimal.default("0"), netProfit: decimal,
  closeReason: z.string().min(1).max(200), closedAt: timestamp
}).strict();

const symbolSpecSchema = z.object({
  canonicalSymbol: z.string().min(3).max(30).transform((value) => value.toUpperCase()), brokerSymbol: z.string().min(1).max(50),
  digits: z.number().int().min(0).max(12), point: decimal, tickSize: decimal, tickValueProfit: decimal,
  tickValueLoss: decimal, contractSize: decimal, volumeMin: decimal, volumeMax: decimal, volumeStep: decimal
}).strict();

export const contextSchema = z.object({
  clientId: z.string().min(1).max(100), accountId: z.string().min(1).max(100), broker: z.string().min(1).max(200),
  currency: z.string().min(3).max(10), balance: decimal, equity: decimal, capturedAt: timestamp,
  symbols: z.array(symbolSpecSchema).min(1).max(100)
}).strict();

export const settingsUpdateSchema = z.record(z.string(), z.string());
