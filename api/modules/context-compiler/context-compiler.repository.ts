import {
  type CompileRunSummary,
  getCompileRunDetail,
  listRecentCompileRuns,
} from "../../../src/modules/context-compiler/context-compiler.repository.js";
import { compileContextPack } from "../../../src/modules/context-compiler/context-compiler.service.js";
import { recordCompileRunKnowledgeFeedback } from "../../../src/modules/knowledge/knowledge-feedback.service.js";
import type {
  CompileRunDetail,
  CompileRunKnowledgeFeedbackResult,
} from "../../../src/shared/schemas/compile-run.schema.js";
import type { CompileInput } from "../../../src/shared/schemas/compile.schema.js";
import type { ContextPack } from "../../../src/shared/schemas/context-pack.schema.js";

export async function compilePack(input: CompileInput): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  return compileContextPack(input, { source: "ui" });
}

export async function listRuns(limit: number): Promise<CompileRunSummary[]> {
  return listRecentCompileRuns(limit);
}

export async function getRunDetail(runId: string): Promise<CompileRunDetail | null> {
  return getCompileRunDetail(runId);
}

export async function saveRunKnowledgeFeedback(params: {
  runId: string;
  items: Array<{
    knowledgeId: string;
    verdict: "used" | "off_topic" | "wrong";
    reason?: string;
  }>;
}): Promise<CompileRunKnowledgeFeedbackResult> {
  return recordCompileRunKnowledgeFeedback({
    runId: params.runId,
    items: params.items,
    actor: "user",
  });
}
