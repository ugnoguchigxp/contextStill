import { z } from "zod";
import type { EpisodeCardCreateInput } from "../../shared/schemas/episode-card.schema.js";
import type { EpisodeGenerationKind } from "./source-key.js";

export const episodeDistillerScoreSchema = z.object({
  reusability: z.number().int().min(0).max(100).default(50),
  decision_density: z.number().int().min(0).max(100).default(50),
  failure_value: z.number().int().min(0).max(100).default(50),
  causal_clarity: z.number().int().min(0).max(100).default(50),
  project_specificity: z.number().int().min(0).max(100).default(50),
  evidence_quality: z.number().int().min(0).max(100).default(50),
  compression_quality: z.number().int().min(0).max(100).default(50),
  staleness_risk: z.number().int().min(0).max(100).default(50),
});

export const episodeDistillerCanonicalSchema = z.object({
  title: z.string().trim().min(1),
  context: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  keyDecisions: z.array(z.string().trim().min(1)).default([]),
  failedApproach: z.string().trim().default(""),
  reusableLesson: z.string().trim().min(1),
  usefulFutureTriggers: z.array(z.string().trim().min(1)).default([]),
  openLoops: z.array(z.string().trim().min(1)).default([]),
  generationKind: z
    .enum(["task_episode", "failure_episode", "decision_episode"])
    .default("task_episode"),
  outcomeKind: z.enum(["success", "failure", "mixed", "unknown"]).default("unknown"),
  domains: z.array(z.string().trim().min(1)).default([]),
  technologies: z.array(z.string().trim().min(1)).default([]),
  changeTypes: z.array(z.string().trim().min(1)).default([]),
  tools: z.array(z.string().trim().min(1)).default([]),
  scores: episodeDistillerScoreSchema.default({}),
});

export const episodeDistillerCanonicalArraySchema = z.array(episodeDistillerCanonicalSchema);

export type EpisodeDistillerCanonical = z.infer<typeof episodeDistillerCanonicalSchema>;

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function joinList(values: string[], fallback = ""): string {
  const items = values.map((value) => value.trim()).filter(Boolean);
  if (items.length === 0) return fallback;
  return items.map((value) => `- ${value}`).join("\n");
}

export function canonicalEpisodeToCardInput(params: {
  canonical: EpisodeDistillerCanonical;
  sourceKey: string;
  parentVibeMemoryId: string;
  sourceFragmentKey: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventStart: string | null;
  eventEnd: string | null;
  readRanges: Array<{ from: number; toExclusive: number }>;
  sessionId?: string;
  cwd?: string;
  project?: string;
  distillationVersion: string;
}): EpisodeCardCreateInput {
  const canonical = params.canonical;
  const metadata = {
    source: "episodeDistiller",
    episodeDistillation: {
      version: params.distillationVersion,
      canonical,
      scores: canonical.scores,
      sourceFragmentKey: params.sourceFragmentKey,
      sourceStartOffset: params.sourceStartOffset,
      sourceEndOffset: params.sourceEndOffset,
      sourceEventStart: params.eventStart,
      sourceEventEnd: params.eventEnd,
      readRanges: params.readRanges,
      parentVibeMemoryId: params.parentVibeMemoryId,
      generatingQueueName: "episodeDistiller",
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.project ? { project: params.project } : {}),
    },
    triggers: canonical.usefulFutureTriggers,
  };

  return {
    title: canonical.title,
    situation: [canonical.context, canonical.intent].filter(Boolean).join("\n\nIntent:\n"),
    observations: joinList(canonical.keyDecisions, "No key decisions were identified."),
    action: [
      canonical.failedApproach ? `Failed approach:\n${canonical.failedApproach}` : "",
      canonical.openLoops.length > 0 ? `Open loops:\n${joinList(canonical.openLoops)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    outcome: `Episode distilled from vibe memory segment ${params.sourceFragmentKey}.`,
    lesson: canonical.reusableLesson,
    applicability: {
      sourceFragmentKey: params.sourceFragmentKey,
      generationKind: canonical.generationKind,
    },
    antiApplicability: {
      requiresRawEvidenceCheck: true,
      stalenessRisk: canonical.scores.staleness_risk,
    },
    domains: uniqueStrings(canonical.domains),
    technologies: uniqueStrings(canonical.technologies),
    changeTypes: uniqueStrings(canonical.changeTypes),
    tools: uniqueStrings(canonical.tools),
    repoPath: params.cwd,
    repoKey: params.project,
    sourceKind: "vibe_memory",
    sourceKey: params.sourceKey,
    outcomeKind: canonical.outcomeKind,
    confidence: Math.max(30, Math.min(95, canonical.scores.evidence_quality)),
    evidenceStatus: canonical.scores.evidence_quality >= 75 ? "partial" : "unverified",
    status: "active",
    metadata,
    refs: [
      {
        refKind: "vibe_memory",
        refValue: params.parentVibeMemoryId,
        locator: `bytes:${params.sourceStartOffset}-${params.sourceEndOffset}`,
        queryHint: canonical.title,
        metadata: {
          sourceFragmentKey: params.sourceFragmentKey,
          sourceStartOffset: params.sourceStartOffset,
          sourceEndOffset: params.sourceEndOffset,
          sourceEventStart: params.eventStart,
          sourceEventEnd: params.eventEnd,
          readRanges: params.readRanges,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.project ? { project: params.project } : {}),
        },
      },
    ],
  };
}

export function normalizeGenerationKind(value: unknown): EpisodeGenerationKind {
  return value === "failure_episode" || value === "decision_episode" ? value : "task_episode";
}
