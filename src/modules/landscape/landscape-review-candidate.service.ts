import { createHash } from "node:crypto";
import {
  type LandscapeReviewCandidateCreateInput,
  type LandscapeReviewCandidateCreateResult,
  landscapeReviewCandidateCreateInputSchema,
  landscapeReviewCandidateCreateResultSchema,
} from "../../shared/schemas/landscape-review-candidate.schema.js";
import type { LandscapeReviewItemProposedAction } from "../../shared/schemas/landscape-review.schema.js";
import {
  type LandscapeReviewItemCandidateSourceRow,
  listLandscapeReviewItemsForCandidateDraft,
  upsertLandscapeReviewItemCandidateDraft,
} from "./landscape-review-candidate.repository.js";
import type {
  CreateLandscapeReviewCandidatesResult,
  LandscapeReviewCandidateDraft,
} from "./landscape-review-candidate.types.js";

const PROCEDURE_ACTIONS = new Set<LandscapeReviewItemProposedAction>([
  "refine_applies_to",
  "repair_reachability",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown, lower = false): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    deduped.add(lower ? trimmed.toLowerCase() : trimmed);
  }
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function normalizeAppliesToForKey(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
    const entry = source[key];
    if (Array.isArray(entry)) {
      const values = normalizeStringArray(entry, true);
      if (values.length > 0) normalized[key] = values;
      continue;
    }
    if (entry && typeof entry === "object") {
      const nested = normalizeAppliesToForKey(entry);
      if (Object.keys(nested).length > 0) normalized[key] = nested;
      continue;
    }
    const text = normalizeText(entry);
    if (text) {
      normalized[key] = text;
      continue;
    }
    if (typeof entry === "number" || typeof entry === "boolean") {
      normalized[key] = entry;
    }
  }
  return normalized;
}

function normalizeAppliesToForOrigin(value: unknown): Record<string, unknown> {
  const source = asRecord(value);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const entry = source[key];
    if (Array.isArray(entry)) {
      const values = normalizeStringArray(entry);
      if (values.length > 0) normalized[key] = values;
      continue;
    }
    if (entry && typeof entry === "object") {
      const nested = normalizeAppliesToForOrigin(entry);
      if (Object.keys(nested).length > 0) normalized[key] = nested;
      continue;
    }
    const text = normalizeText(entry);
    if (text) {
      normalized[key] = text;
      continue;
    }
    if (typeof entry === "number" || typeof entry === "boolean") {
      normalized[key] = entry;
    }
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function buildCandidateKey(row: LandscapeReviewItemCandidateSourceRow): string {
  const evidence = normalizeStringArray(row.evidence, false);
  const hashInput = {
    reason: row.reason,
    proposedAction: row.proposedAction,
    communityKey: row.communityKey ?? null,
    knowledgeId: row.knowledgeId ?? null,
    suggestedAppliesTo: normalizeAppliesToForKey(row.suggestedAppliesTo),
    evidence,
  };
  const digest = createHash("sha1").update(stableStringify(hashInput)).digest("hex");
  return `landscape-review-item:${row.id}:${row.reason}:${digest}`;
}

function reviewItemScopeLabel(row: LandscapeReviewItemCandidateSourceRow): string {
  return row.knowledgeId ?? row.communityLabel ?? row.runId ?? row.id;
}

function reviewItemReasonSummary(row: LandscapeReviewItemCandidateSourceRow): string {
  const evidence = normalizeStringArray(row.evidence, false).slice(0, 2).join(" / ");
  if (evidence) return evidence;
  return `reason=${row.reason}`;
}

function buildProcedureBody(row: LandscapeReviewItemCandidateSourceRow): string {
  return [
    "Use when:",
    `- Landscape review item ${row.id} (${row.reason}) requires applicability or reachability correction.`,
    `- Scope ${reviewItemScopeLabel(row)} is still under review and should be reflected in candidate metadata.`,
    "",
    "Workflow:",
    "1. Inspect the linked review item evidence and suggestedAppliesTo fields, then identify missing or incorrect applicability facets.",
    "2. Update the candidate draft so appliesTo and rationale are consistent with the review reason and evidence context.",
    "3. Re-run the candidate through distillation pipeline and keep review traceability keys unchanged.",
    "",
    "Verification:",
    `- Confirm the updated candidate includes actionable appliesTo fields and references the originating review item id ${row.id}.`,
    "- Confirm the resulting candidate can pass coverEvidence/finalize without losing the review traceability metadata.",
    "",
    "Avoid:",
    "- Do not remove evidence context from the review item when rewriting appliesTo.",
    "- Do not create additional random target keys for the same review item unless the deterministic candidate key changes.",
  ].join("\n");
}

function buildRuleBody(row: LandscapeReviewItemCandidateSourceRow): string {
  const summary = reviewItemReasonSummary(row);
  return [
    `Landscape-origin candidates must keep manual review traceability for reason ${row.reason}.`,
    `Always record reviewItemId=${row.id} and candidateKey in origin metadata, and avoid finalizing until the review concern is resolved.`,
    `When evidence indicates promotion risk or wrong classification (${summary}), reviewers should verify the warning before promotion decisions.`,
  ].join("\n");
}

function buildDraftFromReviewItem(
  row: LandscapeReviewItemCandidateSourceRow,
): LandscapeReviewCandidateDraft {
  const candidateType = PROCEDURE_ACTIONS.has(
    row.proposedAction as LandscapeReviewItemProposedAction,
  )
    ? "procedure"
    : "rule";
  const candidateKey = buildCandidateKey(row);
  const targetKey = candidateKey;
  const suffix = row.id.slice(0, 8);
  const titlePrefix =
    candidateType === "procedure" ? "Landscape Review Procedure" : "Landscape Review Rule";
  const title = `${titlePrefix}: ${row.reason} (${suffix})`;
  const body = candidateType === "procedure" ? buildProcedureBody(row) : buildRuleBody(row);

  return {
    candidateType,
    title,
    body,
    candidateKey,
    targetKey,
  };
}

export async function createLandscapeReviewCandidates(
  input: LandscapeReviewCandidateCreateInput,
): Promise<CreateLandscapeReviewCandidatesResult> {
  const parsed = landscapeReviewCandidateCreateInputSchema.parse(input);
  const reviewRows = await listLandscapeReviewItemsForCandidateDraft({
    ids: parsed.ids,
    status: parsed.status,
    limit: parsed.limit,
  });

  const missingIds =
    parsed.ids && parsed.ids.length > 0
      ? parsed.ids.filter((id) => !reviewRows.some((row) => row.id === id))
      : [];

  const generatedAt = new Date().toISOString();
  const resultItems: LandscapeReviewCandidateCreateResult["items"] = [];
  let createdCount = 0;
  let existingCount = 0;

  for (const row of reviewRows) {
    const draft = buildDraftFromReviewItem(row);
    if (parsed.dryRun) {
      resultItems.push({
        reviewItemId: row.id,
        reason: row.reason as LandscapeReviewCandidateCreateResult["items"][number]["reason"],
        proposedAction:
          row.proposedAction as LandscapeReviewCandidateCreateResult["items"][number]["proposedAction"],
        candidateType: draft.candidateType,
        candidateKey: draft.candidateKey,
        targetKey: draft.targetKey,
        targetStateId: null,
        findCandidateResultId: null,
        linkId: null,
        linkStatus: null,
        draftLinked: false,
      });
      continue;
    }

    const upserted = await upsertLandscapeReviewItemCandidateDraft({
      reviewItem: {
        ...row,
        suggestedAppliesTo: normalizeAppliesToForOrigin(row.suggestedAppliesTo),
      },
      draft,
      generatedAt,
    });

    if (upserted.created) {
      createdCount += 1;
    } else {
      existingCount += 1;
    }

    resultItems.push({
      reviewItemId: row.id,
      reason: row.reason as LandscapeReviewCandidateCreateResult["items"][number]["reason"],
      proposedAction:
        row.proposedAction as LandscapeReviewCandidateCreateResult["items"][number]["proposedAction"],
      candidateType: draft.candidateType,
      candidateKey: draft.candidateKey,
      targetKey: draft.targetKey,
      targetStateId: upserted.targetStateId,
      findCandidateResultId: upserted.findCandidateResultId,
      linkId: upserted.link.id,
      linkStatus: upserted.link
        .status as LandscapeReviewCandidateCreateResult["items"][number]["linkStatus"],
      draftLinked: true,
    });
  }

  return landscapeReviewCandidateCreateResultSchema.parse({
    dryRun: parsed.dryRun,
    processedCount: reviewRows.length,
    createdCount,
    existingCount,
    missingIds,
    items: resultItems,
  });
}
