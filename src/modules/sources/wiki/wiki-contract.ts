import { z } from "zod";
export type WikiErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 412
  | 413
  | 422
  | 428
  | 429
  | 500
  | 502
  | 503
  | 504;
export class WikiError extends Error {
  constructor(
    readonly code: string,
    readonly status: WikiErrorStatus,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export const BODY_LIMIT = 8 * 1024 * 1024;
export function strictWikiSlug(slug: string): string {
  if (
    !slug ||
    slug !== slug.normalize("NFC") ||
    Buffer.byteLength(slug) > 1024 ||
    slug.split("/").some((segment) => Buffer.byteLength(segment) > 255) ||
    /\p{Cc}/u.test(slug) ||
    /[\\%]/u.test(slug) ||
    [...slug].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    slug.split("/").some((s) => !s || s === "." || s === "..") ||
    slug.endsWith(".md") ||
    slug.split("/").at(-1) === "index"
  ) {
    throw new WikiError("INVALID_SLUG", 400);
  }
  return slug;
}
export function validateWikiBody(body: string): void {
  if (
    !body.isWellFormed() ||
    Buffer.byteLength(body) > BODY_LIMIT ||
    /^\uFEFF?---(?:\r?\n|$)/u.test(body)
  )
    throw new WikiError("INVALID_BODY", 400);
}
export function validateRequestId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new WikiError("INVALID_REQUEST_ID", 400);
}
export function wikiExitCode(status: number): number {
  if (status === 207) return 7;
  if ([400, 413, 422, 428].includes(status)) return 2;
  if ([401, 403].includes(status)) return 3;
  if (status === 404) return 4;
  if ([409, 412].includes(status)) return 5;
  if ([429, 502, 503, 504].includes(status)) return 6;
  return 1;
}

const wikiVersionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const wikiSlugSchema = z.string().refine((value) => {
  try {
    strictWikiSlug(value);
    return true;
  } catch {
    return false;
  }
});
const pageIdentitySchema = z.object({ slug: wikiSlugSchema, version: wikiVersionSchema });
export const wikiWriteSuccessSchema = z
  .object({
    ok: z.literal(true),
    command: z.enum(["create", "update"]),
    page: pageIdentitySchema,
    operationId: z.string().uuid(),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sourceId: z.string().min(1),
    fileState: z.literal("saved"),
    indexState: z.literal("ready"),
    extractionState: z.literal("not_requested"),
    knowledgeState: z.literal("not_requested"),
  })
  .strict();
export const wikiReadSuccessSchema = z.object({
  ok: z.literal(true),
  command: z.literal("get"),
  page: pageIdentitySchema.extend({
    title: z.string(),
    body: z.string(),
    path: z.string(),
    meta: z.record(z.string(), z.unknown()),
  }),
});
export const wikiListSuccessSchema = z.object({
  ok: z.literal(true),
  command: z.literal("list"),
  items: z.array(pageIdentitySchema.extend({ title: z.string() })).max(1000),
});
export const wikiFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    message: z.string(),
    retryable: z.boolean(),
  }),
  slug: wikiSlugSchema.optional(),
  currentVersion: wikiVersionSchema.optional(),
  operationId: z.string().uuid().optional(),
  version: wikiVersionSchema.optional(),
  phase: z.enum(["prepared", "saved", "committed", "complete"]).optional(),
  fileState: z.enum(["unknown", "saved"]).optional(),
  indexState: z.enum(["pending", "ready", "failed"]).optional(),
  extractionState: z.literal("not_requested").optional(),
  knowledgeState: z.literal("not_requested").optional(),
});
