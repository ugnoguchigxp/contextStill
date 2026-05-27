import { z } from "zod";

export const sessionMemoSlotLimit = 40;
export const sessionMemoBodyMaxChars = 10000;
export const sessionMemoKindMaxChars = 64;
export const sessionMemoTitleMaxChars = 160;

const optionalTrimmedString = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const optionalKindString = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().max(sessionMemoKindMaxChars).optional());

const optionalTitleString = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().max(sessionMemoTitleMaxChars).optional());

const slotSchema = z
  .number()
  .int()
  .min(0)
  .max(sessionMemoSlotLimit - 1);

export const sessionMemoItemInputSchema = z
  .object({
    slot: slotSchema.optional(),
    kind: optionalKindString,
    title: optionalTitleString,
    label: optionalTrimmedString,
    body: z.string().trim().min(1).max(sessionMemoBodyMaxChars),
    metadata: z.record(z.unknown()).optional().default({}),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "compile_eval") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "compile_eval kind is no longer supported in session_memo",
      });
    }
  });

export const sessionMemoToolInputSchema = z
  .object({
    action: z.enum(["put", "put_many", "list", "get"]),
    sessionId: optionalTrimmedString,
    slot: slotSchema.optional(),
    kind: optionalKindString,
    title: optionalTitleString,
    label: optionalTrimmedString,
    body: z.string().trim().min(1).max(sessionMemoBodyMaxChars).optional(),
    metadata: z.record(z.unknown()).optional().default({}),
    expiresAt: z.string().datetime().optional(),
    items: z.array(sessionMemoItemInputSchema).min(1).max(sessionMemoSlotLimit).optional(),
    includeEmpty: z.boolean().optional().default(false),
    previewChars: z.number().int().min(1).max(2000).optional().default(320),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "put" && value.kind === "compile_eval") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "compile_eval kind is no longer supported in session_memo",
      });
    }
    if (value.action === "get" && value.slot === undefined && !value.label) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slot"],
        message: "slot or label is required for get",
      });
    }
  });

export const sessionMemoListInputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    includeEmpty: z.boolean().default(false),
    previewChars: z.number().int().min(1).max(2000).default(320),
  })
  .strict();

export type SessionMemoToolInput = z.infer<typeof sessionMemoToolInputSchema>;
export type SessionMemoItemInput = z.infer<typeof sessionMemoItemInputSchema>;
