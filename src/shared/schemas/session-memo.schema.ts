import { z } from "zod";

export const sessionMemoSlotLimit = 20;
export const sessionMemoBodyMaxChars = 4000;

const optionalTrimmedString = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const slotSchema = z
  .number()
  .int()
  .min(0)
  .max(sessionMemoSlotLimit - 1);

export const sessionMemoItemInputSchema = z
  .object({
    slot: slotSchema.optional(),
    label: optionalTrimmedString,
    body: z.string().trim().min(1).max(sessionMemoBodyMaxChars),
    metadata: z.record(z.unknown()).optional().default({}),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const sessionMemoToolInputSchema = z
  .object({
    action: z.enum(["put", "put_many", "list", "get", "delete", "clear"]),
    sessionId: optionalTrimmedString,
    slot: slotSchema.optional(),
    label: optionalTrimmedString,
    body: z.string().trim().min(1).max(sessionMemoBodyMaxChars).optional(),
    metadata: z.record(z.unknown()).optional().default({}),
    expiresAt: z.string().datetime().optional(),
    items: z.array(sessionMemoItemInputSchema).min(1).max(sessionMemoSlotLimit).optional(),
    includeEmpty: z.boolean().optional().default(false),
    previewChars: z.number().int().min(1).max(2000).optional().default(320),
  })
  .strict();

export const sessionMemoListInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    includeEmpty: z.boolean().default(false),
    previewChars: z.number().int().min(1).max(2000).default(320),
  })
  .strict();

export type SessionMemoToolInput = z.infer<typeof sessionMemoToolInputSchema>;
export type SessionMemoItemInput = z.infer<typeof sessionMemoItemInputSchema>;
