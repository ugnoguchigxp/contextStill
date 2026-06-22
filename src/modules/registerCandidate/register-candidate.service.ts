import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  coveringEvidenceQueue,
  distillationTargetStates,
  findCandidateResults,
  findingCandidateQueue,
  foundCandidates,
} from "../../db/schema.js";
import { registerCandidateInputSchema } from "../../shared/schemas/knowledge.schema.js";
import { registerCandidatesBulkInputSchema } from "../../shared/schemas/knowledge.schema.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";
import { resolveKnowledgeCandidatePriorityGroup } from "../distillationTarget/priority-group.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../distillationTarget/repository.js";
import { embedOne } from "../embedding/embedding.service.js";
import { parseStorageCandidatesFromLlmOutput } from "../findCandidate/parser.js";
import type {
  CandidateKnowledgePolarity,
  CandidateKnowledgeType,
} from "../findCandidate/repository.js";
import { type KnowledgeApplicability, normalizeApplicability } from "../knowledge/applicability.js";
import { upsertKnowledgeFromSource } from "../knowledge/knowledge.repository.js";
import { appendQueueEvent } from "../queue/core/events.js";

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

type RegisterCandidateOptions = {
  strictProcedureSections?: boolean;
};

const PROCEDURE_SECTION_WARNING: RegisterCandidateWarning =
  "procedure_candidate_missing_skill_like_sections";
const PROCEDURE_SECTION_VALIDATION_ERROR = "PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS";

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
  originalType?: CandidateKnowledgeType;
  polarity: CandidateKnowledgePolarity;
  intentTags: string[];
  applicability: KnowledgeApplicability;
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

  const originalType = input.type ?? parsedCandidate?.type ?? "rule";
  const rawPolarity = input.polarity ?? parsedCandidate?.polarity ?? "positive";
  const polarity: CandidateKnowledgePolarity = rawPolarity === "negative" ? "negative" : "positive";
  const body =
    input.body ??
    parsedCandidate?.content ??
    input.text ??
    (polarity === "negative" && input.avoid && input.prefer
      ? `避けること: ${input.avoid}\n推奨: ${input.prefer}`
      : "");
  const title = input.title ?? parsedCandidate?.title ?? inferTitleFromText(body);
  const type = polarity === "negative" && originalType === "procedure" ? "rule" : originalType;
  const intentTags = input.intentTags ?? [];
  const applicability = normalizeApplicability(input) ?? {};
  if (type === "procedure" && !hasSkillLikeProcedureBody(body)) {
    warnings.push("procedure_candidate_missing_skill_like_sections");
  }

  return {
    title,
    body,
    type,
    ...(originalType !== type ? { originalType } : {}),
    polarity,
    intentTags,
    applicability,
    warnings,
  };
}

function compactOrigin(
  input: RegisterCandidateInput,
  normalized: {
    type: CandidateKnowledgeType;
    originalType?: CandidateKnowledgeType;
    polarity: CandidateKnowledgePolarity;
    intentTags: string[];
    applicability: KnowledgeApplicability;
  },
) {
  const applicability = normalized.applicability;
  return {
    source: "mcp_register_candidate",
    registeredAt: new Date().toISOString(),
    candidateType: normalized.type,
    ...(normalized.originalType ? { originalCandidateType: normalized.originalType } : {}),
    polarity: normalized.polarity,
    ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(Object.keys(applicability).length > 0 ? { appliesTo: applicability } : {}),
    ...(applicability.general !== undefined ? { general: applicability.general } : {}),
    ...(applicability.technologies ? { technologies: applicability.technologies } : {}),
    ...(applicability.changeTypes ? { changeTypes: applicability.changeTypes } : {}),
    ...(applicability.domains ? { domains: applicability.domains } : {}),
    ...(applicability.repoPath ? { repoPath: applicability.repoPath } : {}),
    ...(applicability.repoKey ? { repoKey: applicability.repoKey } : {}),
    ...(Object.keys(input.metadata ?? {}).length > 0 ? { metadata: input.metadata } : {}),
  };
}

export async function registerCandidate(
  input: RegisterCandidateInput,
  options: RegisterCandidateOptions = {},
): Promise<RegisterCandidateResult> {
  const parsed = registerCandidateInputSchema.parse(input);
  const normalized = normalizeInput(parsed);
  if (options.strictProcedureSections && normalized.warnings.includes(PROCEDURE_SECTION_WARNING)) {
    throw new Error(PROCEDURE_SECTION_VALIDATION_ERROR);
  }
  const candidateId = randomUUID();
  const sourceUri = `agent://candidate/${candidateId}`;
  const now = new Date();
  const hasApplicability = Object.keys(normalized.applicability).length > 0;
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const embedding = await embedOne(`${normalized.title}\n${normalized.body}`, "passage");
    const knowledgeId = await upsertKnowledgeFromSource({
      sourceUri,
      type: normalized.type,
      status: "active",
      scope: normalized.applicability.general ? "global" : "repo",
      polarity: normalized.polarity,
      intentTags: normalized.intentTags,
      title: normalized.title,
      body: normalized.body,
      confidence: parsed.confidence ?? 70,
      importance: parsed.importance ?? 70,
      metadata: {
        ...(parsed.metadata ?? {}),
        source: "mcp_register_candidate",
        registeredAt: now.toISOString(),
        sqliteDirectRegistration: true,
        candidateId,
        polarity: normalized.polarity,
        ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
        ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
      },
      embedding,
      appliesTo: normalized.applicability,
    });
    return {
      targetStateId: knowledgeId,
      findCandidateResultId: candidateId,
      sourceUri,
      status: "candidate_registered",
      title: normalized.title,
      type: normalized.type,
      warnings: normalized.warnings,
      next: "distillation_pipeline",
    };
  }

  const targetMetadata = {
    ...(parsed.metadata ?? {}),
    source: "mcp_register_candidate",
    registeredAt: now.toISOString(),
    polarity: normalized.polarity,
    ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
  } satisfies Record<string, unknown>;
  const priorityGroup = resolveKnowledgeCandidatePriorityGroup({
    sourceUri,
    metadata: targetMetadata,
  });

  const result = await db.transaction(async (tx) => {
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

    const payload = {
      title: normalized.title,
      body: normalized.body,
      type: normalized.type,
      polarity: normalized.polarity,
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
      origin: compactOrigin(parsed, normalized),
      legacyTargetStateId: target.id,
      legacyFindCandidateResultId: candidate.id,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    };

    const metadata = {
      source: "mcp_register_candidate",
      registeredAt: now.toISOString(),
      legacyTargetStateId: target.id,
      legacyFindCandidateResultId: candidate.id,
      polarity: normalized.polarity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    };

    const [findingJob] = await tx
      .insert(findingCandidateQueue)
      .values({
        inputKind: "provided_candidate",
        sourceKind: "knowledge_candidate",
        sourceKey: candidateId,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        payload,
        metadata,
        priority: 90,
        status: "completed",
        completedAt: now,
        lastOutcomeKind: "provided_candidate_registered",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          findingCandidateQueue.inputKind,
          findingCandidateQueue.sourceKind,
          findingCandidateQueue.sourceKey,
          findingCandidateQueue.distillationVersion,
        ],
        set: {
          sourceUri,
          payload,
          metadata,
          priority: 90,
          status: "completed",
          completedAt: now,
          lastOutcomeKind: "provided_candidate_registered",
          updatedAt: now,
        },
      })
      .returning();

    if (!findingJob) throw new Error("failed to create V2 finding job");

    const origin = compactOrigin(parsed, normalized);
    const candidateMetadata = {
      sourceKind: "knowledge_candidate",
      sourceKey: candidateId,
      sourceUri,
      polarity: normalized.polarity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    };

    const [foundCandidate] = await tx
      .insert(foundCandidates)
      .values({
        findingJobId: findingJob.id,
        candidateIndex: 0,
        type: normalized.type,
        title: normalized.title,
        content: normalized.body,
        origin,
        metadata: candidateMetadata,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [foundCandidates.findingJobId, foundCandidates.candidateIndex],
        set: {
          type: normalized.type,
          title: normalized.title,
          content: normalized.body,
          origin,
          metadata: candidateMetadata,
          updatedAt: now,
        },
      })
      .returning();

    if (!foundCandidate) throw new Error("failed to create V2 found candidate");

    const [coveringJob] = await tx
      .insert(coveringEvidenceQueue)
      .values({
        foundCandidateId: foundCandidate.id,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        priority: 90,
        providerPolicy: "default",
        payload: {},
        metadata: {},
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: coveringEvidenceQueue.foundCandidateId,
        set: {
          status: "pending",
          priority: 90,
          completedAt: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          lastError: null,
          lastOutcomeKind: null,
          updatedAt: now,
        },
      })
      .returning();

    if (!coveringJob) throw new Error("failed to create V2 covering job");

    return { target, candidate, findingJob, foundCandidate, coveringJob };
  });

  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: result.findingJob.id,
    eventType: "completed",
    message: "provided candidate registered synchronously (finding skipped)",
    metadata: {
      sourceKind: "knowledge_candidate",
      sourceKey: candidateId,
      inputKind: "provided_candidate",
      foundCandidateId: result.foundCandidate.id,
    },
  });

  await appendQueueEvent({
    queueName: "coveringEvidence",
    queueJobId: result.coveringJob.id,
    eventType: "enqueued",
    message: "covering job enqueued from synchronous register-candidate",
    metadata: {
      foundCandidateId: result.foundCandidate.id,
      findingJobId: result.findingJob.id,
    },
  });

  return {
    targetStateId: result.target.id,
    findCandidateResultId: result.candidate.id,
    findingJobId: result.findingJob.id,
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
  options: RegisterCandidateOptions = {},
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
      const result = await registerCandidate(normalized, options);
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
