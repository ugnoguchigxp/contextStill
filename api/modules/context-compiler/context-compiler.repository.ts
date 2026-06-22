import {
  type CompileRunSummary,
  getCompileRunDetail,
  getCompileRunRankingTrace,
  listRecentCompileRuns,
  saveRunEpisodeFeedback,
} from "../../../src/modules/context-compiler/context-compiler.repository.js";
import { updateEpisodeCardStatus } from "../../../src/modules/episodic-memory/episode-card.repository.js";
import { compileContextPack } from "../../../src/modules/context-compiler/context-compiler.service.js";
import { recordCompileRunKnowledgeFeedback } from "../../../src/modules/knowledge/knowledge-feedback.service.js";
import type {
  CompileRunDetail,
  CompileRunEpisodeFeedbackResult,
  CompileRunKnowledgeFeedbackResult,
  CompileRunRankingTrace,
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

export async function getRunRankingTrace(runId: string): Promise<CompileRunRankingTrace | null> {
  return getCompileRunRankingTrace(runId);
}

export async function saveRunKnowledgeFeedback(params: {
  runId: string;
  items: Array<{
    knowledgeId: string;
    verdict: "used" | "not_used" | "off_topic" | "wrong";
    reason?: string;
  }>;
}): Promise<CompileRunKnowledgeFeedbackResult> {
  return recordCompileRunKnowledgeFeedback({
    runId: params.runId,
    items: params.items,
    actor: "user",
  });
}

export async function saveRunEpisodeFeedbackForRepository(params: {
  runId: string;
  items: Array<{
    episodeId: string;
    verdict: "used" | "not_used" | "wrong";
    reason?: string;
  }>;
}): Promise<CompileRunEpisodeFeedbackResult> {
  return saveRunEpisodeFeedback(params);
}

export async function deprecateRunEpisodeForRepository(params: {
  runId: string;
  episodeId: string;
}): Promise<void> {
  const detail = await getCompileRunDetail(params.runId);
  if (!detail) {
    throw Object.assign(new Error("Compile run not found."), { statusCode: 404 });
  }
  const selected = detail.episodeSignals.some((item) => item.episodeId === params.episodeId);
  if (!selected) {
    throw Object.assign(
      new Error(`Episode ID is not in selected items for this run: ${params.episodeId}`),
      { statusCode: 400 },
    );
  }
  const updated = await updateEpisodeCardStatus({
    episodeId: params.episodeId,
    status: "deprecated",
  });
  if (!updated) {
    throw Object.assign(new Error("Episode not found."), { statusCode: 404 });
  }
}
