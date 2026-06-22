import { z } from "zod";
import type { EpisodeCardCreateInput } from "../../shared/schemas/episode-card.schema.js";
import type { EpisodeGenerationKind } from "./source-key.js";

const episodeDistillerScoreValueSchema = z.coerce
  .number()
  .finite()
  .transform((value) => {
    const scaled = value > 0 && value <= 1 ? value * 100 : value;
    return Math.round(Math.max(0, Math.min(100, scaled)));
  })
  .pipe(z.number().int().min(0).max(100))
  .default(50);

export const episodeDistillerScoreSchema = z.object({
  importance: episodeDistillerScoreValueSchema,
  confidence: episodeDistillerScoreValueSchema,
  reusability: episodeDistillerScoreValueSchema,
  decision_density: episodeDistillerScoreValueSchema,
  failure_value: episodeDistillerScoreValueSchema,
  causal_clarity: episodeDistillerScoreValueSchema,
  project_specificity: episodeDistillerScoreValueSchema,
  evidence_quality: episodeDistillerScoreValueSchema,
  compression_quality: episodeDistillerScoreValueSchema,
  staleness_risk: episodeDistillerScoreValueSchema,
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
    situation: [canonical.context, canonical.intent].filter(Boolean).join("\n\n意図:\n"),
    observations: joinList(canonical.keyDecisions, "主要な判断は特定されませんでした。"),
    action: [
      canonical.failedApproach
        ? `失敗した、または避けたアプローチ:\n${canonical.failedApproach}`
        : "",
      canonical.openLoops.length > 0
        ? `source 時点の未解決事項:\n${joinList(canonical.openLoops)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    outcome: `vibe memory segment ${params.sourceFragmentKey} から蒸留された Episode。`,
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
    importance: canonical.scores.importance,
    confidence: canonical.scores.confidence,
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
