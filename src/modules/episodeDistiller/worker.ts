import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import type {
  EpisodeCard,
  EpisodeCardCreateInput,
} from "../../shared/schemas/episode-card.schema.js";
import {
  createEpisodeCard,
  getEpisodeCardBySource,
} from "../episodic-memory/episode-card.repository.js";
import {
  type DistillationMessage,
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveEpisodeDistillerRoute,
} from "../settings/settings.service.js";
import { appendQueueEvent } from "../queue/core/events.js";
import {
  type EpisodeDistillerJob,
  getEpisodeDistillerJobById,
  markEpisodeDistillerCompleted,
  markEpisodeDistillerFailed,
} from "./repository.js";
import {
  canonicalEpisodeToCardInput,
  type EpisodeDistillerCanonical,
  episodeDistillerCanonicalArraySchema,
} from "./schema.js";
import { readEpisodeSourceDocument, type EpisodeSourceDocument } from "./source-reader.js";
import {
  EPISODE_DISTILLATION_VERSION,
  episodeSourceFragmentKey,
  type EpisodeGenerationKind,
} from "./source-key.js";

type Segment = {
  text: string;
  startOffset: number;
  endOffset: number;
  eventStart: string | null;
  eventEnd: string | null;
  eventIds: string[];
};

type EpisodeDistillerProcessResult = {
  generated: number;
  deduped: number;
  skipped: number;
  valueSkipped: number;
  duplicateGenerationKindSkipped: number;
  failedSegments: number;
  episodeIds: string[];
};

type EpisodeValueReview = {
  publish: boolean;
  score: number;
  reasons: string[];
};

type PendingEpisode = {
  input: EpisodeCardCreateInput;
};

const MIN_EPISODE_VALUE_SCORE = 60;
const MIN_EPISODE_IMPORTANCE = 55;
const MIN_EPISODE_CONFIDENCE = 55;
const MIN_EPISODE_REUSABLE_SIGNAL = 50;
const MIN_EPISODE_EVIDENCE_QUALITY = 50;
const MIN_EPISODE_COMPRESSION_QUALITY = 45;

type EpisodeDistillerTestHooks = {
  distillSegment?: (params: {
    segment: Segment;
    document: EpisodeSourceDocument;
    job: EpisodeDistillerJob;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

let testHooks: EpisodeDistillerTestHooks = {};

export function setEpisodeDistillerTestHooksForTests(hooks: EpisodeDistillerTestHooks): void {
  testHooks = hooks;
}

function textForByteRange(content: string, startOffset: number, endOffset: number): string {
  return Buffer.from(content, "utf8").subarray(startOffset, endOffset).toString("utf8");
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function reviewEpisodeValue(canonical: EpisodeDistillerCanonical): EpisodeValueReview {
  const scores = canonical.scores;
  const reusableSignal = Math.max(
    scores.reusability,
    scores.decision_density,
    scores.failure_value,
  );
  const score = Math.round(
    scores.importance * 0.22 +
      scores.confidence * 0.18 +
      scores.reusability * 0.14 +
      scores.decision_density * 0.1 +
      scores.failure_value * 0.1 +
      scores.causal_clarity * 0.1 +
      scores.project_specificity * 0.06 +
      scores.evidence_quality * 0.05 +
      scores.compression_quality * 0.05,
  );
  const reasons: string[] = [];
  if (score < MIN_EPISODE_VALUE_SCORE) reasons.push("value_score_below_60");
  if (scores.importance < MIN_EPISODE_IMPORTANCE) reasons.push("importance_below_55");
  if (scores.confidence < MIN_EPISODE_CONFIDENCE) reasons.push("confidence_below_55");
  if (reusableSignal < MIN_EPISODE_REUSABLE_SIGNAL) {
    reasons.push("reusable_signal_below_50");
  }
  if (scores.evidence_quality < MIN_EPISODE_EVIDENCE_QUALITY) {
    reasons.push("evidence_quality_below_50");
  }
  if (scores.compression_quality < MIN_EPISODE_COMPRESSION_QUALITY) {
    reasons.push("compression_quality_below_45");
  }
  return {
    publish: reasons.length === 0,
    score,
    reasons,
  };
}

function splitLargeSegment(segment: Segment, maxBytes: number): Segment[] {
  if (segment.endOffset - segment.startOffset <= maxBytes) return [segment];
  const chunks: Segment[] = [];
  let start = segment.startOffset;
  const buffer = Buffer.from(segment.text, "utf8");
  while (start < segment.endOffset) {
    const relativeStart = start - segment.startOffset;
    const relativeEnd = Math.min(buffer.byteLength, relativeStart + maxBytes);
    const text = buffer.subarray(relativeStart, relativeEnd).toString("utf8");
    const end = segment.startOffset + relativeEnd;
    chunks.push({
      text,
      startOffset: start,
      endOffset: end,
      eventStart: segment.eventStart,
      eventEnd: segment.eventEnd,
      eventIds: segment.eventIds,
    });
    start = end;
  }
  return chunks;
}

function buildDeterministicSegments(document: EpisodeSourceDocument): Segment[] {
  const maxTokens = 4000;
  const maxBytes = maxTokens * 4;
  const events = document.events;
  if (events.length === 0) {
    return [
      {
        text: document.content,
        startOffset: 0,
        endOffset: Buffer.byteLength(document.content, "utf8"),
        eventStart: null,
        eventEnd: null,
        eventIds: [],
      },
    ];
  }

  const segments: Segment[] = [];
  let current = [events[0]];
  for (const event of events.slice(1)) {
    const previous = current.at(-1);
    const previousAt = previous ? Date.parse(previous.createdAt) : Number.NaN;
    const currentAt = Date.parse(event.createdAt);
    const gapMs =
      Number.isFinite(previousAt) && Number.isFinite(currentAt) ? currentAt - previousAt : 0;
    const currentFiles = new Set(current.map((item) => item.filePath).filter(Boolean));
    const fileBoundary =
      currentFiles.size > 0 && event.filePath ? !currentFiles.has(event.filePath) : false;
    const startOffset = current[0]?.startOffset ?? 0;
    const projectedBytes = event.endOffset - startOffset;
    if (gapMs >= 30 * 60_000 || fileBoundary || projectedBytes > maxBytes) {
      const first = current[0];
      const last = current.at(-1);
      if (first && last) {
        segments.push({
          text: textForByteRange(document.content, first.startOffset, last.endOffset),
          startOffset: first.startOffset,
          endOffset: last.endOffset,
          eventStart: first.id,
          eventEnd: last.id,
          eventIds: current.map((item) => item.id),
        });
      }
      current = [event];
    } else {
      current.push(event);
    }
  }

  const first = current[0];
  const last = current.at(-1);
  if (first && last) {
    segments.push({
      text: textForByteRange(document.content, first.startOffset, last.endOffset),
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      eventStart: first.id,
      eventEnd: last.id,
      eventIds: current.map((item) => item.id),
    });
  }

  return segments.flatMap((segment) => splitLargeSegment(segment, maxBytes));
}

function buildMessages(segment: Segment, document: EpisodeSourceDocument): DistillationMessage[] {
  const metadata = document.metadata;
  const cwd = metadataString(metadata, ["cwd", "repoPath", "workspacePath"]);
  const project = metadataString(metadata, ["project", "projectName", "repoKey"]);
  return [
    {
      role: "system",
      content: [
        "あなたは ContextStill の episodeDistiller です。",
        "source evidence から、将来の作業判断に再利用できる task-oriented EpisodeCard だけを作ります。",
        "出力は JSON array のみ。JSON 以外の説明文や Markdown は返さないでください。",
        "JSON のキー名、enum 値、ファイルパス、コマンド名、API 名、固有名詞は指定どおり保持してください。それ以外の自然文は必ず日本語で書いてください。",
        "差分ファイル単位の細切れ Episode を避け、同じ目的・原因・判断に属する内容は 1 件に統合してください。",
        "原則として 1 segment から 1 件だけ作ります。明確に異なる decision/failure/task が同時にある場合だけ最大 2 件までにしてください。",
        "rules/procedures の昇格はしません。因果関係、判断、失敗、再利用できる教訓、当時の未解決事項だけを記録してください。",
        "openLoops は現在も未解決と断定しないでください。source 時点の未解決事項として、日本語で控えめに書いてください。",
        "scores.importance は将来の作業判断で再利用する価値、scores.confidence はこの EpisodeCard の要約・教訓が source segment から妥当に読める確度として、0-100 の整数で別々に採点してください。",
        "単一 segment 由来で追加検証がない場合、scores.confidence は最大 80 を目安にしてください。複数の独立した根拠が segment 内にある場合だけ 90 以上を使えます。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Vibe memory id: ${document.vibeMemoryId}`,
        `Session id: ${document.sessionId}`,
        cwd ? `cwd: ${cwd}` : undefined,
        project ? `project: ${project}` : undefined,
        `Source byte range: ${segment.startOffset}-${segment.endOffset}`,
        `Source events: ${segment.eventIds.join(", ") || "-"}`,
        "",
        "次の shape の JSON array を返してください。値の自然文は日本語で書いてください:",
        "{",
        '  "title": "...",',
        '  "context": "...",',
        '  "intent": "...",',
        '  "keyDecisions": ["..."],',
        '  "failedApproach": "",',
        '  "reusableLesson": "...",',
        '  "usefulFutureTriggers": ["..."],',
        '  "openLoops": ["..."],',
        '  "generationKind": "task_episode|failure_episode|decision_episode",',
        '  "outcomeKind": "success|failure|mixed|unknown",',
        '  "domains": ["..."],',
        '  "technologies": ["..."],',
        '  "changeTypes": ["..."],',
        '  "tools": ["..."],',
        '  "scores": { "importance": 0, "confidence": 0, "reusability": 0, "decision_density": 0, "failure_value": 0, "causal_clarity": 0, "project_specificity": 0, "evidence_quality": 0, "compression_quality": 0, "staleness_risk": 0 }',
        "}",
        "",
        "Source segment:",
        segment.text,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    },
  ];
}

async function distillSegment(params: {
  segment: Segment;
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (testHooks.distillSegment) {
    return testHooks.distillSegment(params);
  }
  await ensureRuntimeSettingsLoaded();
  const route = resolveEpisodeDistillerRoute();
  const provider = route.provider;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: route.model,
    localLlmModel: route.localLlmModel,
  });
  const completion = await runDistillationCompletion(
    {
      model,
      messages: buildMessages(params.segment, params.document),
      maxTokens: 4000,
    },
    {
      providerSetting: provider,
      fallbackOrder: route.fallback,
      azureDeploymentSlots: route.azureDeploymentSlots,
      localLlmModel: route.localLlmModel,
      enableTools: false,
      maxToolRounds: 0,
      usageSource: "episode-distiller",
      signal: params.signal,
      blankResponseReminder: [
        "空の応答です。Episode canonical form の JSON array だけを返してください。",
      ],
    },
  );
  return parseLlmJsonLike(completion.content)?.value;
}

async function distillSegmentWithRetry(params: {
  segment: Segment;
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}) {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const output = await distillSegment(params);
      return episodeDistillerCanonicalArraySchema.parse(output);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "episode distiller parse failed");
}

async function createEpisodeIdempotently(input: Parameters<typeof createEpisodeCard>[0]): Promise<{
  episode: EpisodeCard;
  deduped: boolean;
}> {
  const existing = await getEpisodeCardBySource({
    sourceKind: input.sourceKind,
    sourceKey: input.sourceKey,
  });
  if (existing) return { episode: existing, deduped: true };
  try {
    return { episode: await createEpisodeCard(input), deduped: false };
  } catch (error) {
    const concurrentExisting = await getEpisodeCardBySource({
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
    });
    if (concurrentExisting) return { episode: concurrentExisting, deduped: true };
    throw error;
  }
}

export async function processEpisodeDistillerJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<EpisodeDistillerProcessResult> {
  const job = await getEpisodeDistillerJobById(jobId);
  if (!job) throw new Error(`episode distiller queue job not found: ${jobId}`);
  if (job.sourceKind !== "vibe_memory") {
    throw new Error(`unsupported episode source kind: ${job.sourceKind}`);
  }
  await appendQueueEvent({
    queueName: "episodeDistiller",
    queueJobId: job.id,
    eventType: "claimed",
    message: "episode distiller claimed",
  });

  const document = await readEpisodeSourceDocument(job.sourceKey);
  const segments = buildDeterministicSegments(document);
  const metadata = document.metadata;
  const cwd = metadataString(metadata, ["cwd", "repoPath", "workspacePath"]);
  const project = metadataString(metadata, ["project", "projectName", "repoKey"]);
  let generated = 0;
  let deduped = 0;
  let skipped = 0;
  let valueSkipped = 0;
  let duplicateGenerationKindSkipped = 0;
  let failedSegments = 0;
  const episodeIds: string[] = [];
  const pendingEpisodes: PendingEpisode[] = [];
  const segmentErrors: Array<{ segment: number; error: string }> = [];
  const skippedDuplicateGenerationKinds: Array<{
    segment: number;
    generationKind: EpisodeGenerationKind;
  }> = [];
  const skippedValueReviews: Array<{
    segment: number;
    generationKind: EpisodeGenerationKind;
    title: string;
    valueReview: EpisodeValueReview;
  }> = [];

  for (const [segmentIndex, segment] of segments.entries()) {
    if (signal?.aborted) throw new Error("episode distiller aborted");
    if (estimateTokenCount(segment.text) <= 10) {
      skipped += 1;
      continue;
    }
    let canonicalEpisodes: EpisodeDistillerCanonical[];
    try {
      canonicalEpisodes = await distillSegmentWithRetry({ segment, document, job, signal });
    } catch (error) {
      failedSegments += 1;
      segmentErrors.push({
        segment: segmentIndex,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (canonicalEpisodes.length === 0) {
      skipped += 1;
      continue;
    }
    const seenGenerationKinds = new Set<EpisodeGenerationKind>();
    for (const canonical of canonicalEpisodes) {
      const generationKind = canonical.generationKind as EpisodeGenerationKind;
      if (seenGenerationKinds.has(generationKind)) {
        skipped += 1;
        duplicateGenerationKindSkipped += 1;
        skippedDuplicateGenerationKinds.push({
          segment: segmentIndex,
          generationKind,
        });
        continue;
      }
      seenGenerationKinds.add(generationKind);
      const valueReview = reviewEpisodeValue(canonical);
      if (!valueReview.publish) {
        skipped += 1;
        valueSkipped += 1;
        skippedValueReviews.push({
          segment: segmentIndex,
          generationKind,
          title: canonical.title,
          valueReview,
        });
        continue;
      }
      const sourceFragmentKey = episodeSourceFragmentKey({
        parentSourceKind: "vibe_memory",
        parentSourceKey: job.sourceKey,
        sourceSpan: {
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
        },
        generationKind,
        distillationVersion: EPISODE_DISTILLATION_VERSION,
      });
      const input = canonicalEpisodeToCardInput({
        canonical,
        sourceKey: sourceFragmentKey,
        parentVibeMemoryId: job.sourceKey,
        sourceFragmentKey,
        sourceStartOffset: segment.startOffset,
        sourceEndOffset: segment.endOffset,
        eventStart: segment.eventStart,
        eventEnd: segment.eventEnd,
        readRanges: [{ from: segment.startOffset, toExclusive: segment.endOffset }],
        sessionId: document.sessionId,
        cwd,
        project,
        distillationVersion: EPISODE_DISTILLATION_VERSION,
      });
      const inputMetadata = recordFromUnknown(input.metadata);
      input.metadata = {
        ...inputMetadata,
        episodeDistillation: {
          ...recordFromUnknown(inputMetadata.episodeDistillation),
          valueReview,
        },
      };
      pendingEpisodes.push({ input });
    }
  }

  if (
    generated === 0 &&
    deduped === 0 &&
    failedSegments > 0 &&
    failedSegments === segments.length
  ) {
    const sampleErrors = segmentErrors
      .slice(0, 3)
      .map((item) => `segment ${item.segment}: ${item.error}`)
      .join(" | ");
    throw new Error(
      `episode distiller failed all segments (${failedSegments}/${segments.length})${
        sampleErrors ? `: ${sampleErrors}` : ""
      }`,
    );
  }

  for (const pending of pendingEpisodes) {
    const saved = await createEpisodeIdempotently(pending.input);
    episodeIds.push(saved.episode.id);
    if (saved.deduped) deduped += 1;
    else generated += 1;
  }

  const outcome =
    generated > 0 || deduped > 0
      ? "episodes_distilled"
      : valueSkipped > 0
        ? "low_value_skipped"
        : "no_episode";
  await markEpisodeDistillerCompleted({
    jobId: job.id,
    status: outcome === "episodes_distilled" ? "completed" : "skipped",
    outcome,
    metadata: {
      episodeDistiller: {
        generated,
        deduped,
        skipped,
        valueSkipped,
        duplicateGenerationKindSkipped,
        failedSegments,
        segmentCount: segments.length,
        episodeIds,
        acceptedCandidateCount: pendingEpisodes.length,
        segmentErrors,
        skippedDuplicateGenerationKinds,
        skippedValueReviews,
        completedAt: new Date().toISOString(),
      },
    },
  });
  await appendQueueEvent({
    queueName: "episodeDistiller",
    queueJobId: job.id,
    eventType: "completed",
    message: "episode distiller completed",
    metadata: {
      generated,
      deduped,
      skipped,
      valueSkipped,
      duplicateGenerationKindSkipped,
      failedSegments,
      episodeIds,
      acceptedCandidateCount: pendingEpisodes.length,
    },
  });
  return {
    generated,
    deduped,
    skipped,
    valueSkipped,
    duplicateGenerationKindSkipped,
    failedSegments,
    episodeIds,
  };
}

export async function failEpisodeDistillerJob(jobId: string, error: string): Promise<void> {
  await markEpisodeDistillerFailed({
    jobId,
    error,
    outcome: "failed",
    metadata: {
      episodeDistiller: {
        failedAt: new Date().toISOString(),
        error,
      },
    },
  });
}
