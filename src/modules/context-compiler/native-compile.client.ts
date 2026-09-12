import { NativeCompileError } from "./native-compile.errors.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { resolveWriterEndpoint } from "../../db/sqlite/writer-client.js";
import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import {
  type CompileInput,
  deriveRetrievalModeFromChangeTypes,
  retrievalModeSchema,
} from "../../shared/schemas/compile.schema.js";
import {
  type ContextPackItem,
  contextPackSchema,
} from "../../shared/schemas/context-pack.schema.js";

const nativeKnowledge = z.object({
  id: z.string().min(1),
  type: z.enum(["rule", "procedure"]),
  title: z.string(),
  body: z.string(),
  score: z.number(),
  sourceRefs: z.array(z.string()).default([]),
  polarity: z.string().optional(),
  scopeSnapshot: z.record(z.unknown()).optional(),
});
const nativeEpisode = z.object({
  id: z.string().min(1),
  title: z.string(),
  situation: z.string(),
  lesson: z.string(),
  score: z.number(),
});
export const nativeCompileEnvelopeSchema = z.object({
  contractVersion: z.literal(1),
  databaseFingerprint: z.string(),
  runId: z.string().uuid(),
  status: z.enum(["ok", "degraded", "failed"]),
  contentStatus: z.enum(["empty", "partial", "content"]),
  markdown: z.string(),
  retrievalMode: retrievalModeSchema,
  tokenBudget: z.number().nullable(),
  pack: z.object({
    runId: z.string().uuid(),
    goal: z.string(),
    rules: z.array(nativeKnowledge),
    procedures: z.array(nativeKnowledge),
    episodes: z.array(nativeEpisode),
    outputMarkdown: z.string(),
    diagnostics: z.object({ degradedReasons: z.array(z.string()) }).passthrough(),
  }),
});
export { NativeCompileError } from "./native-compile.errors.js";

export function adaptNativeCompile(raw: unknown, expectedFingerprint: string) {
  const envelope = nativeCompileEnvelopeSchema.parse(raw);
  if (
    envelope.databaseFingerprint !== expectedFingerprint ||
    envelope.runId !== envelope.pack.runId ||
    envelope.markdown !== envelope.pack.outputMarkdown
  )
    throw new NativeCompileError("compile_response_binding_mismatch");
  if ((envelope.contentStatus === "empty") !== (envelope.markdown === "No Content"))
    throw new NativeCompileError("compile_content_status_mismatch");
  const convert = (
    item: z.infer<typeof nativeKnowledge>,
    section: "rules" | "procedures",
  ): ContextPackItem => ({
    id: item.id,
    itemKind: "knowledge",
    itemId: item.id,
    section,
    title: item.title,
    content: item.body,
    score: item.score,
    rankingReason: "rust-native",
    sourceRefs: item.sourceRefs,
    scopeSnapshot: item.scopeSnapshot,
  });
  const rules = envelope.pack.rules.map((item) => convert(item, "rules"));
  const procedures = envelope.pack.procedures.map((item) => convert(item, "procedures"));
  const episodes = envelope.pack.episodes.map((item) => ({
    id: item.id,
    itemKind: "episode",
    itemId: item.id,
    section: "procedures" as const,
    title: item.title,
    content: `${item.situation}\n${item.lesson}`.trim(),
    score: item.score,
    rankingReason: "rust-native",
    sourceRefs: [],
  }));
  const pack = contextPackSchema.parse({
    runId: envelope.runId,
    goal: envelope.pack.goal,
    retrievalMode: envelope.retrievalMode,
    status: envelope.status,
    minimalTasks: [],
    rules,
    procedures,
    episodes,
    guardrails: [],
    warnings: envelope.pack.diagnostics.degradedReasons,
    sourceRefs: [...new Set([...rules, ...procedures].flatMap((item) => item.sourceRefs))],
    diagnostics: {
      degradedReasons: envelope.pack.diagnostics.degradedReasons,
      retrievalStats: {
        engine: "rust-native",
        native: envelope.pack.diagnostics,
        contentStatus: envelope.contentStatus,
      },
    },
  });
  return { pack, markdown: envelope.markdown };
}

export async function compileNativeContext(
  input: CompileInput,
  options?: { source?: CompileRunSource; sessionId?: string },
) {
  if (
    input.includeDraft === true ||
    input.files !== undefined ||
    input.queryEmbedding !== undefined
  )
    throw new NativeCompileError(
      "compile_unsupported_legacy_argument: includeDraft=true, files and queryEmbedding require the explicit legacy adapter",
    );
  if (input.tokenBudget !== undefined && (input.tokenBudget < 128 || input.tokenBudget > 8192))
    throw new NativeCompileError("compile_token_budget_must_be_128_to_8192");
  const db = resolveDatabaseBackendConfig();
  if (db.kind !== "sqlite" || !db.sqlitePath)
    throw new NativeCompileError("compile_requires_sqlite");
  const fingerprint = createHash("sha256")
    .update(`context-stilld-effective-db-v1\n${path.resolve(db.sqlitePath)}`)
    .digest("hex");
  let endpoint: ReturnType<typeof resolveWriterEndpoint>;
  try {
    endpoint = resolveWriterEndpoint();
  } catch {
    throw new NativeCompileError("compile_resident_unavailable");
  }
  if (
    endpoint.effectiveDatabaseFingerprint &&
    endpoint.effectiveDatabaseFingerprint !== fingerprint
  )
    throw new NativeCompileError("compile_database_mismatch");
  if (endpoint.compileContractVersion !== undefined && endpoint.compileContractVersion !== 1)
    throw new NativeCompileError("compile_contract_mismatch");
  const url = new URL(endpoint.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new NativeCompileError("compile_requires_loopback");
  url.pathname = "/internal/context-compile";
  const { goal, changeTypes, technologies, domains, projectRef, repoKey, repoPath } = input;
  const payload = {
    contractVersion: 1,
    databaseFingerprint: fingerprint,
    input: { goal, changeTypes, technologies, domains, projectRef, repoKey, repoPath },
    options: {
      source: options?.source ?? "unknown",
      sessionId: options?.sessionId,
      retrievalMode: input.retrievalMode ?? deriveRetrievalModeFromChangeTypes(input.changeTypes),
      intent: input.intent,
      tokenBudget: input.tokenBudget,
    },
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new NativeCompileError("compile_transport_unavailable_or_timed_out");
  }
  const result = (await response.json().catch(() => {
    throw new NativeCompileError("compile_protocol_mismatch");
  })) as { ok?: boolean; error?: string; envelope?: unknown };
  if (!response.ok || !result.ok)
    throw new NativeCompileError(
      /^compile_[a-z_]+$/.test(result.error ?? "") ? result.error : "compile_engine_unavailable",
    );
  try {
    return adaptNativeCompile(result.envelope, fingerprint);
  } catch (error) {
    if (error instanceof NativeCompileError) throw error;
    throw new NativeCompileError("compile_protocol_mismatch");
  }
}
