import { groupedConfig } from "../../config.js";
import type { SourceFragmentForDistillation } from "../sources/distillation.repository.js";
import type {
  AgentDiffEntryForDistillation,
  VibeMemoryForDistillation,
} from "../vibe-memory/distillation.repository.js";
import type { DistillationCandidateSourceRef } from "./distillation-candidate.repository.js";
import { recordDistillationReadEvent } from "./distillation-read-event.repository.js";
import { prepareMemoryReaderContent, type MemoryReaderMode } from "../memoryReader/domain.js";

export const distillationReaderAuditContextKey = "distillationReaderContext";

export type DistillationReadableSegment = {
  locator: string;
  label: string;
  content: string;
  charCount: number;
  metadata?: Record<string, unknown>;
};

export type DistillationReaderContext = {
  enabled: boolean;
  apply: boolean;
  jobId?: string;
  source: DistillationCandidateSourceRef;
  segments: DistillationReadableSegment[];
  maxReads: number;
  maxCharsPerRead: number;
  readCount: number;
  readLocators: string[];
};

export type DistillationReadResult =
  | {
      ok: true;
      locator: string;
      label: string;
      content: string;
      charCount: number;
      truncated: boolean;
      readCount: number;
      maxReads: number;
    }
  | {
      ok: false;
      error: string;
      readCount: number;
      maxReads: number;
    };

function truncate(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return {
    content: `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`,
    truncated: true,
  };
}

function splitTextIntoSegments(params: {
  text: string;
  locatorPrefix: string;
  labelPrefix: string;
  maxSegmentChars: number;
  metadata?: Record<string, unknown>;
}): DistillationReadableSegment[] {
  const normalized = params.text.trim();
  if (!normalized) return [];

  const segments: DistillationReadableSegment[] = [];
  let offset = 0;
  let index = 1;
  while (offset < normalized.length) {
    const nextOffset = Math.min(normalized.length, offset + params.maxSegmentChars);
    const content = normalized.slice(offset, nextOffset).trim();
    if (content) {
      segments.push({
        locator: `${params.locatorPrefix}:chunk-${index}`,
        label: `${params.labelPrefix} ${index}`,
        content,
        charCount: content.length,
        metadata: {
          ...(params.metadata ?? {}),
          offsetStart: offset,
          offsetEnd: nextOffset,
        },
      });
      index += 1;
    }
    offset = nextOffset;
  }
  return segments;
}

export function buildSourceReaderContext(params: {
  fragment: SourceFragmentForDistillation;
  apply: boolean;
  jobId?: string;
}): DistillationReaderContext {
  const source: DistillationCandidateSourceRef = {
    sourceKind: "source_fragment",
    sourceFragmentId: params.fragment.id,
  };
  const locatorPrefix = params.fragment.locator.trim() || "fragment";
  return {
    enabled: true,
    apply: params.apply,
    jobId: params.jobId,
    source,
    segments: splitTextIntoSegments({
      text: params.fragment.content,
      locatorPrefix,
      labelPrefix: params.fragment.heading ?? params.fragment.sourceTitle ?? "source fragment",
      maxSegmentChars: groupedConfig.distillationTools.readerMaxCharsPerRead * 2,
      metadata: {
        sourceUri: params.fragment.sourceUri,
        sourceId: params.fragment.sourceId,
        fragmentId: params.fragment.id,
        heading: params.fragment.heading,
      },
    }),
    maxReads: groupedConfig.distillationTools.readerMaxReads,
    maxCharsPerRead: groupedConfig.distillationTools.readerMaxCharsPerRead,
    readCount: 0,
    readLocators: [],
  };
}

export function buildVibeReaderContext(params: {
  memory: VibeMemoryForDistillation;
  diffEntries: AgentDiffEntryForDistillation[];
  apply: boolean;
  jobId?: string;
  mode: MemoryReaderMode;
}): DistillationReaderContext {
  const mode = params.mode;
  const segments: DistillationReadableSegment[] = [];
  const seenCompressedSegmentText = new Set<string>();

  const appendSegments = (params: {
    text: string;
    contentKind: "memory" | "diff";
    locatorPrefix: string;
    labelPrefix: string;
    metadata: Record<string, unknown>;
  }) => {
    const preparedText = prepareMemoryReaderContent({
      text: params.text,
      mode,
      contentKind: params.contentKind,
    });
    if (mode === "compressed") {
      const dedupeKey = preparedText.trim();
      if (!dedupeKey || seenCompressedSegmentText.has(dedupeKey)) return;
      seenCompressedSegmentText.add(dedupeKey);
    }
    segments.push(
      ...splitTextIntoSegments({
        text: preparedText,
        locatorPrefix: params.locatorPrefix,
        labelPrefix: params.labelPrefix,
        maxSegmentChars: groupedConfig.distillationTools.readerMaxCharsPerRead * 2,
        metadata: params.metadata,
      }),
    );
  };

  appendSegments({
    text: params.memory.content,
    contentKind: "memory",
    locatorPrefix: "vibe-memory",
    labelPrefix: "vibe memory",
    metadata: {
      vibeMemoryId: params.memory.id,
      sessionId: params.memory.sessionId,
      memoryType: params.memory.memoryType,
      memoryReaderMode: mode,
    },
  });

  for (const entry of params.diffEntries) {
    appendSegments({
      text: entry.diffHunk,
      contentKind: "diff",
      locatorPrefix: `diff:${entry.filePath}:${entry.id}`,
      labelPrefix: `diff ${entry.filePath}`,
      metadata: {
        vibeMemoryId: params.memory.id,
        diffEntryId: entry.id,
        filePath: entry.filePath,
        changeType: entry.changeType,
        language: entry.language,
        symbolName: entry.symbolName,
        symbolKind: entry.symbolKind,
        memoryReaderMode: mode,
      },
    });
  }

  return {
    enabled: true,
    apply: params.apply,
    jobId: params.jobId,
    source: {
      sourceKind: "vibe_memory",
      vibeMemoryId: params.memory.id,
    },
    segments,
    maxReads: groupedConfig.distillationTools.readerMaxReads,
    maxCharsPerRead: groupedConfig.distillationTools.readerMaxCharsPerRead,
    readCount: 0,
    readLocators: [],
  };
}

export function distillationReaderContextFromAudit(
  auditContext?: Record<string, unknown>,
): DistillationReaderContext | undefined {
  const value = auditContext?.[distillationReaderAuditContextKey];
  if (!value || typeof value !== "object") return undefined;
  return value as DistillationReaderContext;
}

export function readerCatalog(context: DistillationReaderContext): string {
  if (!context.enabled || context.segments.length === 0) return "(no readable segments)";
  return context.segments
    .map((segment) =>
      [
        `locator: ${segment.locator}`,
        `label: ${segment.label}`,
        `chars: ${segment.charCount}`,
        segment.metadata?.filePath ? `file: ${segment.metadata.filePath}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join(" / "),
    )
    .join("\n");
}

export async function readDistillationSegment(params: {
  context: DistillationReaderContext;
  locator: string;
  purpose?: string;
  candidateId?: string;
}): Promise<DistillationReadResult> {
  const locator = params.locator.trim();
  if (!locator) {
    return {
      ok: false,
      error: "locator must be a non-empty string",
      readCount: params.context.readCount,
      maxReads: params.context.maxReads,
    };
  }
  if (params.context.readCount >= params.context.maxReads) {
    return {
      ok: false,
      error: `read budget exceeded (${params.context.maxReads})`,
      readCount: params.context.readCount,
      maxReads: params.context.maxReads,
    };
  }

  const segment = params.context.segments.find((item) => item.locator === locator);
  if (!segment) {
    return {
      ok: false,
      error: `unknown locator: ${locator}`,
      readCount: params.context.readCount,
      maxReads: params.context.maxReads,
    };
  }

  params.context.readCount += 1;
  params.context.readLocators.push(locator);
  const truncated = truncate(segment.content, params.context.maxCharsPerRead);

  if (params.context.apply && params.context.jobId) {
    await recordDistillationReadEvent({
      jobId: params.context.jobId,
      candidateId: params.candidateId,
      source: params.context.source,
      locator,
      purpose: params.purpose,
      charCount: segment.charCount,
      truncated: truncated.truncated,
      metadata: segment.metadata,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    locator: segment.locator,
    label: segment.label,
    content: truncated.content,
    charCount: segment.charCount,
    truncated: truncated.truncated,
    readCount: params.context.readCount,
    maxReads: params.context.maxReads,
  };
}
