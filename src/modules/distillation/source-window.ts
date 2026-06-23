import { z } from "zod";

export type SourceWindowEvent = {
  id: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
  filePath?: string | null;
};

export type BoundedSourceWindow = {
  windowIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  text: string;
  previousOpenBoundarySummary?: string;
};

export const semanticChunkBoundaryKinds = [
  "request_to_result",
  "investigation",
  "implementation",
  "verification",
  "failure_resolution",
  "decision_turn",
  "misc",
] as const;

export const semanticChunkOutputKinds = ["episode", "candidate", "both", "none"] as const;

export type SemanticChunkBoundaryKind = (typeof semanticChunkBoundaryKinds)[number];
export type SemanticChunkOutputKind = (typeof semanticChunkOutputKinds)[number];

export type SemanticChunk = {
  chunkIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  taskBoundaryKind: SemanticChunkBoundaryKind;
  title: string;
  boundaryReason: string;
  expectedOutputs: SemanticChunkOutputKind[];
  openBoundary: boolean;
};

export const semanticChunkSchema = z.object({
  chunkIndex: z.number().int().nonnegative().optional().default(0),
  sourceStartOffset: z.number().int().nonnegative(),
  sourceEndOffset: z.number().int().positive(),
  eventIds: z.array(z.string()).optional().default([]),
  taskBoundaryKind: z.enum(semanticChunkBoundaryKinds).optional().default("misc"),
  title: z.string().trim().min(1),
  boundaryReason: z.string().trim().min(1),
  expectedOutputs: z.array(z.enum(semanticChunkOutputKinds)).min(1).optional().default(["both"]),
  openBoundary: z.boolean().optional().default(false),
});

export const semanticChunkArraySchema = z.array(semanticChunkSchema);

const DEFAULT_WINDOW_TOKENS = 8000;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function textForByteRange(content: string, startOffset: number, endOffset: number): string {
  return Buffer.from(content, "utf8").subarray(startOffset, endOffset).toString("utf8");
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0b1100_0000) === 0b1000_0000;
}

function safeUtf8End(buffer: Buffer, startOffset: number, proposedEnd: number, endOffset: number) {
  if (proposedEnd >= endOffset) return endOffset;
  let safeEnd = proposedEnd;
  while (safeEnd > startOffset && isUtf8ContinuationByte(buffer[safeEnd])) {
    safeEnd -= 1;
  }
  if (safeEnd > startOffset) return safeEnd;

  safeEnd = proposedEnd;
  while (safeEnd < endOffset && isUtf8ContinuationByte(buffer[safeEnd])) {
    safeEnd += 1;
  }
  return safeEnd;
}

function maxWindowBytes(maxTokens: number | undefined): number {
  return Math.max(1024, Math.floor(maxTokens ?? DEFAULT_WINDOW_TOKENS) * 4);
}

function splitByteRange(params: {
  content: string;
  startOffset: number;
  endOffset: number;
  maxBytes: number;
  eventIds: string[];
  startWindowIndex: number;
}): BoundedSourceWindow[] {
  const windows: BoundedSourceWindow[] = [];
  const buffer = Buffer.from(params.content, "utf8");
  let start = params.startOffset;
  let windowIndex = params.startWindowIndex;
  while (start < params.endOffset) {
    const proposedEnd = Math.min(params.endOffset, start + params.maxBytes);
    const end = safeUtf8End(buffer, start, proposedEnd, params.endOffset);
    windows.push({
      windowIndex,
      sourceStartOffset: start,
      sourceEndOffset: end,
      eventIds: params.eventIds,
      text: textForByteRange(params.content, start, end),
    });
    start = end;
    windowIndex += 1;
  }
  return windows;
}

export function buildBoundedSourceWindows(params: {
  content: string;
  events?: SourceWindowEvent[];
  maxTokens?: number;
}): BoundedSourceWindow[] {
  const contentBytes = byteLength(params.content);
  const maxBytes = maxWindowBytes(params.maxTokens);
  const events = [...(params.events ?? [])]
    .filter((event) => event.endOffset > event.startOffset)
    .sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

  if (contentBytes === 0) return [];
  if (events.length === 0) {
    return splitByteRange({
      content: params.content,
      startOffset: 0,
      endOffset: contentBytes,
      maxBytes,
      eventIds: [],
      startWindowIndex: 0,
    });
  }

  const windows: BoundedSourceWindow[] = [];
  let current: SourceWindowEvent[] = [];

  const flushCurrent = () => {
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) return;
    const startWindowIndex = windows.length;
    const rangeWindows = splitByteRange({
      content: params.content,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      maxBytes,
      eventIds: current.map((event) => event.id),
      startWindowIndex,
    });
    windows.push(...rangeWindows);
    current = [];
  };

  for (const event of events) {
    if (current.length === 0) {
      current.push(event);
      continue;
    }
    const first = current[0];
    const projectedBytes = first ? event.endOffset - first.startOffset : 0;
    if (projectedBytes > maxBytes) {
      flushCurrent();
      current.push(event);
      continue;
    }
    current.push(event);
  }
  flushCurrent();
  return windows.length > 0
    ? windows
    : splitByteRange({
        content: params.content,
        startOffset: 0,
        endOffset: contentBytes,
        maxBytes,
        eventIds: [],
        startWindowIndex: 0,
      });
}

function chunkPayloadToArray(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  const record = value as { chunks?: unknown; semanticChunks?: unknown };
  if (Array.isArray(record.chunks)) return record.chunks;
  if (Array.isArray(record.semanticChunks)) return record.semanticChunks;
  return value;
}

function chunkIsInsideWindow(chunk: SemanticChunk, windows: BoundedSourceWindow[]): boolean {
  return windows.some(
    (window) =>
      chunk.sourceStartOffset >= window.sourceStartOffset &&
      chunk.sourceEndOffset <= window.sourceEndOffset,
  );
}

export function validateSemanticChunks(params: {
  windows: BoundedSourceWindow[];
  chunks: unknown;
}): SemanticChunk[] {
  const parsed = semanticChunkArraySchema.safeParse(chunkPayloadToArray(params.chunks));
  if (!parsed.success) return [];
  return parsed.data
    .filter((chunk) => chunk.sourceEndOffset > chunk.sourceStartOffset)
    .filter((chunk) => chunkIsInsideWindow(chunk, params.windows))
    .sort(
      (a, b) => a.sourceStartOffset - b.sourceStartOffset || a.sourceEndOffset - b.sourceEndOffset,
    )
    .map((chunk, index) => ({
      ...chunk,
      chunkIndex: index,
      expectedOutputs: [...new Set(chunk.expectedOutputs)],
    }));
}

export function deterministicSemanticChunksFromWindows(
  windows: BoundedSourceWindow[],
): SemanticChunk[] {
  return windows.map((window, index) => ({
    chunkIndex: index,
    sourceStartOffset: window.sourceStartOffset,
    sourceEndOffset: window.sourceEndOffset,
    eventIds: [...window.eventIds],
    taskBoundaryKind: "misc",
    title: `source window ${index + 1}`,
    boundaryReason: "bounded source window fallback",
    expectedOutputs: ["both"],
    openBoundary: false,
  }));
}
