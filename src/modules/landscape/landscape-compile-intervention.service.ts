import type { Rankable } from "../context-compiler/ranking.service.js";
import type { KnowledgeCandidateEvidence } from "../knowledge/knowledge.service.js";
import { readProjectEnv } from "../../project-identity.js";

export type LandscapeCompileInterventionRuntimeStrategy = "observe_only" | "diversity_exploration";

export type LandscapeCompileInterventionDiagnostics = {
  enabled: boolean;
  strategy: LandscapeCompileInterventionRuntimeStrategy;
  applied: boolean;
  candidateKnowledgeId?: string;
  reason: string;
};

type CandidateWithEvidence = Rankable & {
  candidateEvidence?: KnowledgeCandidateEvidence;
};

const enabledValues = new Set(["1", "true", "yes", "on", "diversity_exploration"]);

export function isLandscapeCompileInterventionEnabled(): boolean {
  const raw = readProjectEnv("LANDSCAPE_COMPILE_INTERVENTION")?.trim().toLowerCase();
  return raw ? enabledValues.has(raw) : false;
}

function isDiversityCandidate(item: CandidateWithEvidence): boolean {
  return Boolean(item.candidateEvidence?.vectorMatched && item.candidateEvidence.facetMatched);
}

export function applyLandscapeCompileIntervention<T extends CandidateWithEvidence>(
  items: T[],
  params: {
    limit: number;
    enabled?: boolean;
  },
): { items: T[]; diagnostics: LandscapeCompileInterventionDiagnostics } {
  const enabled = params.enabled ?? isLandscapeCompileInterventionEnabled();
  const limit = Math.max(1, params.limit);
  const selected = items.slice(0, limit);

  if (!enabled) {
    return {
      items: selected,
      diagnostics: {
        enabled: false,
        strategy: "observe_only",
        applied: false,
        reason: "Landscape compile intervention is disabled.",
      },
    };
  }

  const selectedIds = new Set(selected.map((item) => item.id));
  const candidate = items.slice(limit).find((item) => {
    return !selectedIds.has(item.id) && isDiversityCandidate(item);
  });

  if (!candidate) {
    return {
      items: selected,
      diagnostics: {
        enabled: true,
        strategy: "diversity_exploration",
        applied: false,
        reason: "No eligible diversity candidate was found beyond the normal ranking window.",
      },
    };
  }

  const nextItems =
    selected.length >= limit
      ? [...selected.slice(0, limit - 1), candidate]
      : [...selected, candidate];

  return {
    items: nextItems,
    diagnostics: {
      enabled: true,
      strategy: "diversity_exploration",
      applied: true,
      candidateKnowledgeId: candidate.id,
      reason:
        "Inserted one vector-and-facet matched candidate from beyond the normal ranking window.",
    },
  };
}
