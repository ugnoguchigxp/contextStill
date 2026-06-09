import { execFile } from "node:child_process";
import {
  getContextDecisionDetail,
  hasDiscardedPrFeedback,
  insertDecisionFeedbackEffects,
  insertDecisionSystemFeedback,
  listContextDecisionPrScanCandidates,
  listSelectedSupportKnowledgeIds,
} from "./context-decision.repository.js";

export type ContextDecisionPrDiscardScanInput = {
  apply?: boolean;
  since?: string;
  limit?: number;
};

export type ContextDecisionPrDiscardScanItem = {
  decisionId: string;
  pr: string | null;
  branch: string | null;
  detectedState: string | null;
  detectionSource: "gh" | "metadata" | "skipped";
  action: "planned_feedback" | "created_feedback" | "already_recorded" | "skipped";
  reason: string;
};

export type ContextDecisionPrDiscardScanResult = {
  status: "ok" | "degraded";
  mode: "dry-run" | "apply";
  since: string | null;
  decisionsScanned: number;
  feedbackCreated: number;
  items: ContextDecisionPrDiscardScanItem[];
  message?: string;
};

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function prNumberFromUrl(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\/pull\/(\d+)/);
  return match?.[1] ?? null;
}

function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function runGhPrView(params: {
  prNumber: string | null;
  prUrl: string | null;
  branch: string | null;
}): Promise<{ state: string; url: string | null; headRefName: string | null } | null> {
  const target = params.prNumber ?? params.prUrl ?? params.branch;
  if (!target) return null;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "gh",
        ["pr", "view", target, "--json", "number,state,closedAt,headRefName,headRefOid,url"],
        { timeout: 10_000 },
        (error, commandStdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(String(commandStdout));
        },
      );
    });
    const parsed = JSON.parse(stdout) as {
      state?: unknown;
      url?: unknown;
      headRefName?: unknown;
    };
    return {
      state: typeof parsed.state === "string" ? parsed.state : "UNKNOWN",
      url: typeof parsed.url === "string" ? parsed.url : null,
      headRefName: typeof parsed.headRefName === "string" ? parsed.headRefName : null,
    };
  } catch {
    return null;
  }
}

function isDiscardedPrState(state: string | null): boolean {
  return state === "CLOSED";
}

function isMissingRelationError(error: unknown): boolean {
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (typeof current === "string") {
      if (current.includes('relation "context_decision_runs" does not exist')) return true;
      continue;
    }
    if (current instanceof Error) {
      if (current.message.includes('relation "context_decision_runs" does not exist')) {
        return true;
      }
      const shaped = current as Error & { cause?: unknown };
      if (shaped.cause) queue.push(shaped.cause);
      continue;
    }
    if (typeof current === "object") {
      const shaped = current as { message?: unknown; cause?: unknown };
      if (
        typeof shaped.message === "string" &&
        shaped.message.includes('relation "context_decision_runs" does not exist')
      ) {
        return true;
      }
      if (shaped.cause) queue.push(shaped.cause);
    }
  }
  return false;
}

function buildDiscardFeedbackEffects(params: {
  affectedKnowledgeIds: string[];
  pr: string | null;
  branch: string | null;
}) {
  if (params.affectedKnowledgeIds.length === 0) {
    return [
      {
        knowledgeId: null,
        effect: "neutral" as const,
        amount: 0,
        reason: "Closed linked PR was detected, but no selected support knowledge was attached.",
        confidence: 60,
        status: "skipped" as const,
        metadata: {
          detectionSource: "gh",
          pr: params.pr,
          branch: params.branch,
          reason: "no_selected_support_knowledge",
        },
      },
    ];
  }
  return params.affectedKnowledgeIds.map((knowledgeId) => ({
    knowledgeId,
    effect: "penalize" as const,
    amount: -4,
    reason: "Closed linked PR suggests the selected direction may have been discarded.",
    confidence: 70,
    status: "applied" as const,
    metadata: { detectionSource: "gh", pr: params.pr, branch: params.branch },
  }));
}

export async function scanContextDecisionPrDiscards(
  input: ContextDecisionPrDiscardScanInput = {},
): Promise<ContextDecisionPrDiscardScanResult> {
  const apply = input.apply === true;
  const since = parseSince(input.since);
  let candidates: Awaited<ReturnType<typeof listContextDecisionPrScanCandidates>>;
  try {
    candidates = await listContextDecisionPrScanCandidates({ since, limit: input.limit });
  } catch (error) {
    if (!isMissingRelationError(error)) throw error;
    return {
      status: "degraded",
      mode: apply ? "apply" : "dry-run",
      since: since?.toISOString() ?? null,
      decisionsScanned: 0,
      feedbackCreated: 0,
      items: [],
      message: "context_decision tables are not migrated; PR discard scan skipped.",
    };
  }
  const items: ContextDecisionPrDiscardScanItem[] = [];
  let feedbackCreated = 0;
  let ghUnavailable = false;

  for (const candidate of candidates) {
    const metadata = candidate.metadata;
    const prUrl = stringMetadata(metadata, "prUrl");
    const prNumber = String(metadata.prNumber ?? "").trim() || prNumberFromUrl(prUrl) || null;
    const branch = stringMetadata(metadata, "branch");
    const ghPr = await runGhPrView({ prNumber, prUrl, branch });
    if (!ghPr && (prUrl || prNumber || branch)) ghUnavailable = true;

    const detectedState = ghPr?.state ?? null;
    const pr = ghPr?.url ?? prUrl ?? (prNumber ? `#${prNumber}` : null);
    if (!isDiscardedPrState(detectedState)) {
      items.push({
        decisionId: candidate.id,
        pr,
        branch,
        detectedState,
        detectionSource: ghPr ? "gh" : "skipped",
        action: "skipped",
        reason: ghPr
          ? "PR is not closed/discarded."
          : "PR state could not be confirmed with gh; no feedback created.",
      });
      continue;
    }

    const alreadyRecorded = await hasDiscardedPrFeedback(candidate.id);
    if (alreadyRecorded) {
      items.push({
        decisionId: candidate.id,
        pr,
        branch,
        detectedState,
        detectionSource: "gh",
        action: "already_recorded",
        reason: "discarded_pr feedback already exists.",
      });
      continue;
    }

    if (!apply) {
      items.push({
        decisionId: candidate.id,
        pr,
        branch,
        detectedState,
        detectionSource: "gh",
        action: "planned_feedback",
        reason: "Closed PR is strongly linked to the decision metadata.",
      });
      continue;
    }

    const detail = await getContextDecisionDetail(candidate.id);
    const affectedKnowledgeIds = await listSelectedSupportKnowledgeIds(candidate.id);
    const feedback = await insertDecisionSystemFeedback({
      decisionId: candidate.id,
      source: "system",
      outcome: "discarded_pr",
      inferredReason: "Linked PR was closed without merge according to gh.",
      affectedKnowledgeIds,
      suggestedAdjustment: { effect: "penalize", amount: -4 },
      metadata: {
        detectionSource: "gh",
        pr,
        branch,
        detectedState,
        decisionCreatedAt: detail?.run.createdAt ?? candidate.createdAt,
      },
    });
    await insertDecisionFeedbackEffects({
      feedbackId: feedback.id,
      decisionId: candidate.id,
      effects: buildDiscardFeedbackEffects({ affectedKnowledgeIds, pr, branch }),
    });
    feedbackCreated += 1;
    items.push({
      decisionId: candidate.id,
      pr,
      branch,
      detectedState,
      detectionSource: "gh",
      action: "created_feedback",
      reason: "discarded_pr feedback created.",
    });
  }

  return {
    status: ghUnavailable ? "degraded" : "ok",
    mode: apply ? "apply" : "dry-run",
    since: since?.toISOString() ?? null,
    decisionsScanned: candidates.length,
    feedbackCreated,
    items,
    message: ghUnavailable ? "Some PR states could not be confirmed with gh." : undefined,
  };
}
