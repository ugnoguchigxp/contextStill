import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { db } from "../../db/index.js";
import { distillationTargetStates, findCandidateResults } from "../../db/schema.js";
import { registerCandidateInputSchema } from "../../shared/schemas/knowledge.schema.js";
import { registerCandidatesBulkInputSchema } from "../../shared/schemas/knowledge.schema.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";
import { parseStorageCandidatesFromLlmOutput } from "../findCandidate/parser.js";
import type { CandidateKnowledgeType } from "../findCandidate/repository.js";
import { enqueueFindingJob } from "../queue/core/index.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../selectDistillationTarget/repository.js";
import { resolveKnowledgeCandidatePriorityGroup } from "../selectDistillationTarget/priority-group.js";

export type RegisterCandidateInput = z.input<typeof registerCandidateInputSchema>;

export type RegisterCandidateWarning =
  | "text_parsed_to_candidate_json"
  | "text_contained_multiple_candidates_registered_first"
  | "procedure_candidate_missing_skill_like_sections";

export type RegisterCandidateResult = {
  targetStateId: string;
  findCandidateResultId: string;
  findingJobId?: string;
  sourceUri: string;
  status: "candidate_registered";
  title: string;
  type: CandidateKnowledgeType;
  warnings: RegisterCandidateWarning[];
  next: "distillation_pipeline";
};

export type RegisterCandidatesBulkItemResult = {
  index: number;
  status: "candidate_registered" | "candidate_failed";
  title?: string;
  type?: CandidateKnowledgeType;
  targetStateId?: string;
  findCandidateResultId?: string;
  findingJobId?: string;
  sourceUri?: string;
  warnings?: RegisterCandidateWarning[];
  error?: string;
};

export type RegisterCandidatesBulkResult = {
  status: "bulk_candidates_registered" | "bulk_candidates_partial" | "bulk_candidates_failed";
  registeredCount: number;
  failedCount: number;
  items: RegisterCandidatesBulkItemResult[];
  next: "distillation_pipeline";
};

function inferTitleFromText(value: string): string {
  const lines = value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const titleLine =
    heading?.replace(/^#{1,6}\s+/, "") ??
    lines.find((line) => /^title\s*:/i.test(line))?.replace(/^title\s*:\s*/i, "") ??
    lines[0] ??
    "Registered candidate";
  return titleLine
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
}

function normalizeInput(input: RegisterCandidateInput): {
  title: string;
  body: string;
  type: CandidateKnowledgeType;
  warnings: RegisterCandidateWarning[];
} {
  const warnings: RegisterCandidateWarning[] = [];
  const textCandidates = input.text ? parseStorageCandidatesFromLlmOutput(input.text) : [];
  const parsedCandidate = textCandidates[0];
  if (parsedCandidate) {
    warnings.push("text_parsed_to_candidate_json");
  }
  if (textCandidates.length > 1) {
    warnings.push("text_contained_multiple_candidates_registered_first");
  }

  const body = input.body ?? parsedCandidate?.content ?? input.text ?? "";
  const title = input.title ?? parsedCandidate?.title ?? inferTitleFromText(body);
  const type = input.type ?? parsedCandidate?.type ?? "rule";
  if (type === "procedure" && !hasSkillLikeProcedureBody(body)) {
    warnings.push("procedure_candidate_missing_skill_like_sections");
  }

  return { title, body, type, warnings };
}

function compactOrigin(
  input: RegisterCandidateInput,
  normalized: { type: CandidateKnowledgeType },
) {
  return {
    source: "mcp_register_candidate",
    registeredAt: new Date().toISOString(),
    candidateType: normalized.type,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.appliesTo ? { appliesTo: input.appliesTo } : {}),
    ...(input.general !== undefined ? { general: input.general } : {}),
    ...(input.technologies ? { technologies: input.technologies } : {}),
    ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
    ...(input.domains ? { domains: input.domains } : {}),
    ...(input.repoPath ? { repoPath: input.repoPath } : {}),
    ...(input.repoKey ? { repoKey: input.repoKey } : {}),
    ...(Object.keys(input.metadata ?? {}).length > 0 ? { metadata: input.metadata } : {}),
  };
}

export async function registerCandidate(
  input: RegisterCandidateInput,
): Promise<RegisterCandidateResult> {
  const parsed = registerCandidateInputSchema.parse(input);
  const normalized = normalizeInput(parsed);
  const candidateId = randomUUID();
  const sourceUri = `agent://candidate/${candidateId}`;
  const now = new Date();
  const targetMetadata = {
    ...(parsed.metadata ?? {}),
    source: "mcp_register_candidate",
    registeredAt: now.toISOString(),
  } satisfies Record<string, unknown>;
  const priorityGroup = resolveKnowledgeCandidatePriorityGroup({
    sourceUri,
    metadata: targetMetadata,
  });

  const legacy = await db.transaction(async (tx) => {
    const [target] = await tx
      .insert(distillationTargetStates)
      .values({
        targetKind: "knowledge_candidate",
        targetKey: candidateId,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        phase: "selected",
        priorityGroup,
        sortKey: now.toISOString(),
        metadata: targetMetadata,
        updatedAt: now,
      })
      .returning();

    if (!target) throw new Error("failed to create candidate target state");

    const [candidate] = await tx
      .insert(findCandidateResults)
      .values({
        targetStateId: target.id,
        candidateIndex: 0,
        title: normalized.title,
        content: normalized.body,
        origin: compactOrigin(parsed, normalized),
        status: "selected",
        updatedAt: now,
      })
      .returning();

    if (!candidate) throw new Error("failed to create candidate result");
    return { target, candidate };
  });

  const findingJob = await enqueueFindingJob({
    inputKind: "provided_candidate",
    sourceKind: "knowledge_candidate",
    sourceKey: candidateId,
    sourceUri,
    distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
    payload: {
      title: normalized.title,
      body: normalized.body,
      type: normalized.type,
      sourceSummary: undefined,
      origin: compactOrigin(parsed, normalized),
      legacyTargetStateId: legacy.target.id,
      legacyFindCandidateResultId: legacy.candidate.id,
    },
    metadata: {
      source: "mcp_register_candidate",
      registeredAt: now.toISOString(),
      legacyTargetStateId: legacy.target.id,
      legacyFindCandidateResultId: legacy.candidate.id,
    },
    priority: 40,
  });

  return {
    targetStateId: legacy.target.id,
    findCandidateResultId: legacy.candidate.id,
    findingJobId: findingJob.id,
    sourceUri,
    status: "candidate_registered",
    title: normalized.title,
    type: normalized.type,
    warnings: normalized.warnings,
    next: "distillation_pipeline",
  };
}

export async function registerCandidatesBulk(
  input: RegisterCandidateInput[],
): Promise<RegisterCandidatesBulkResult> {
  const parsed = registerCandidatesBulkInputSchema.parse(input);
  const bulkBatchId = randomUUID();
  const bulkCount = parsed.length;
  const items: RegisterCandidatesBulkItemResult[] = [];
  let registeredCount = 0;

  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    const metadata = {
      ...(item.metadata ?? {}),
      bulkBatchId,
      bulkIndex: index,
      bulkCount,
      bulkSource: "mcp_register_candidates",
      inputTypeProvided: item.type !== undefined,
    };
    const normalized: RegisterCandidateInput = {
      ...item,
      ...(item.type ? {} : { type: "rule" }),
      metadata,
    };

    try {
      const result = await registerCandidate(normalized);
      registeredCount += 1;
      items.push({
        index,
        status: "candidate_registered",
        title: result.title,
        type: result.type,
        targetStateId: result.targetStateId,
        findCandidateResultId: result.findCandidateResultId,
        findingJobId: result.findingJobId,
        sourceUri: result.sourceUri,
        warnings: result.warnings,
      });
    } catch (error) {
      items.push({
        index,
        status: "candidate_failed",
        title: normalized.title,
        type: normalized.type as CandidateKnowledgeType | undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failedCount = bulkCount - registeredCount;
  const status =
    registeredCount === bulkCount
      ? "bulk_candidates_registered"
      : registeredCount > 0
        ? "bulk_candidates_partial"
        : "bulk_candidates_failed";

  return {
    status,
    registeredCount,
    failedCount,
    items,
    next: "distillation_pipeline",
  };
}
