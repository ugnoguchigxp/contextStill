import {
  compileEvalRecordSchema,
  compileEvalToolResultSchema,
} from "../../shared/schemas/context-compile-eval.schema.js";
import type { CompileEvalInput } from "../../shared/schemas/context-compile-eval.schema.js";
import {
  findRunIdForCompileEval,
  getCompileRunSessionId,
  insertCompileEval,
} from "./context-compile-eval.repository.js";

export function resolveSessionIdFromMeta(
  requestMeta?: Record<string, unknown>,
): string | undefined {
  const keys = ["sessionId", "threadId", "conversationId", "codexSessionId"] as const;
  for (const key of keys) {
    const value = requestMeta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export async function recordCompileEval(params: {
  input: CompileEvalInput;
  requestMeta?: Record<string, unknown>;
  source?: "mcp" | "ui" | "system" | "import";
}) {
  const sessionId = resolveSessionIdFromMeta(params.requestMeta);
  let resolvedFrom: "explicit_run_id" | "latest_session_compile_result" | "latest_session_run" =
    "explicit_run_id";
  let runId = params.input.runId;
  if (!runId) {
    if (!sessionId) {
      throw new Error(
        "SESSION_ID_REQUIRED_FOR_RUN_RESOLUTION: sessionId is required when runId is omitted.",
      );
    }
    const resolved = await findRunIdForCompileEval({ sessionId });
    if (!resolved) {
      throw new Error("RUN_ID_REQUIRED_OR_UNRESOLVED: no compile run found for this session.");
    }
    runId = resolved.runId;
    resolvedFrom = resolved.resolvedFrom;
  }

  const compileRun = await getCompileRunSessionId(runId);
  if (!compileRun) {
    throw new Error(`CONTEXT_COMPILE_RUN_NOT_FOUND: run ${runId} does not exist.`);
  }
  if (sessionId && compileRun.sessionId && compileRun.sessionId !== sessionId) {
    throw new Error(
      `RUN_SESSION_MISMATCH: run ${runId} belongs to a different session (${compileRun.sessionId}).`,
    );
  }

  const saved = await insertCompileEval({
    runId,
    sessionId: sessionId ?? compileRun.sessionId ?? null,
    score: params.input.score,
    outcome: params.input.outcome,
    title: params.input.title,
    body: params.input.body,
    source: params.source ?? "mcp",
    metadata: {
      sourceTool: "compile_eval",
      resolvedFrom,
    },
  });

  const evaluation = compileEvalRecordSchema.parse({
    ...saved,
    createdAt: saved.createdAt.toISOString(),
    updatedAt: saved.updatedAt.toISOString(),
  });
  return compileEvalToolResultSchema.parse({ evaluation, resolvedFrom });
}
