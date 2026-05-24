import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { db } from "../../db/index.js";
import { distillationTargetStates, findCandidateResults } from "../../db/schema.js";
import { registerCandidateInputSchema } from "../../shared/schemas/knowledge.schema.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";
import { parseStorageCandidatesFromLlmOutput } from "../findCandidate/parser.js";
import type { CandidateKnowledgeType } from "../findCandidate/repository.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../selectDistillationTarget/repository.js";
import { resolveKnowledgeCandidatePriorityGroup } from "../selectDistillationTarget/priority-group.js";

export type RegisterCandidateInput = z.infer<typeof registerCandidateInputSchema>;

export type RegisterCandidateWarning =
  | "text_parsed_to_candidate_json"
  | "text_contained_multiple_candidates_registered_first"
  | "procedure_candidate_missing_skill_like_sections";

export type RegisterCandidateResult = {
  targetStateId: string;
  findCandidateResultId: string;
  sourceUri: string;
  status: "candidate_registered";
  title: string;
  type: CandidateKnowledgeType;
  warnings: RegisterCandidateWarning[];
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

  return db.transaction(async (tx) => {
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

    return {
      targetStateId: target.id,
      findCandidateResultId: candidate.id,
      sourceUri,
      status: "candidate_registered",
      title: normalized.title,
      type: normalized.type,
      warnings: normalized.warnings,
      next: "distillation_pipeline",
    };
  });
}
