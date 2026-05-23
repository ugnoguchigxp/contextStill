import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeSourceLinks, sourceFragments, sources } from "../../db/schema.js";
import { linkKnowledgeToSourceFragment } from "../finalizeDistille/source-link.repository.js";

export type SourceReferenceCandidate = {
  uri: string;
  locator?: string;
  origin: string;
};

export type LinkKnowledgeFromMetadataParams = {
  knowledgeId: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  linkMetadataSource: string;
};

export type LinkKnowledgeFromMetadataResult = {
  candidateReferenceCount: number;
  resolvedReferenceCount: number;
  insertedLinkCount: number;
  skippedExistingLinkCount: number;
  unresolvedReferenceCount: number;
};

type ResolvedSourceFragment = {
  sourceFragmentId: string;
  resolvedLocator?: string;
  resolution: "exact" | "fallback_full" | "fallback_first";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitRef(raw: string): { uri: string; locator?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [uriPart, locatorPart] = trimmed.split("#", 2);
  const uri = uriPart?.trim();
  if (!uri) return null;
  const locator = locatorPart?.trim();
  return locator ? { uri, locator } : { uri };
}

function shouldIgnoreUri(uri: string): boolean {
  return (
    uri.startsWith("cover-evidence-result://") ||
    uri.startsWith("memory-router://") ||
    uri.startsWith("search:")
  );
}

function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    const parsed = new URL(uri);
    const pathname = decodeURIComponent(parsed.pathname);
    return pathname || undefined;
  } catch {
    const normalized = uri.replace(/^file:\/\/\/?/, "/");
    return normalized || undefined;
  }
}

function pathToFileUri(path: string): string {
  return `file://${path.startsWith("/") ? "" : "/"}${path}`;
}

function equivalentUris(uri: string): string[] {
  const candidates = new Set<string>();
  const trimmed = uri.trim();
  if (!trimmed) return [];
  candidates.add(trimmed);

  const path = fileUriToPath(trimmed);
  if (path) candidates.add(path);
  if (trimmed.startsWith("/")) candidates.add(pathToFileUri(trimmed));
  return [...candidates];
}

export function normalizeLinkConfidence(confidence: number | undefined): number {
  const normalized = Number(confidence ?? 0.7);
  if (!Number.isFinite(normalized)) return 0.7;
  if (normalized <= 1) return Math.max(0, Math.min(1, normalized));
  return Math.max(0, Math.min(1, normalized / 100));
}

export function extractSourceReferenceCandidates(metadata: Record<string, unknown>): SourceReferenceCandidate[] {
  const refs = new Map<string, SourceReferenceCandidate>();
  const pushRef = (candidate: SourceReferenceCandidate | null) => {
    if (!candidate) return;
    if (shouldIgnoreUri(candidate.uri)) return;
    const key = `${candidate.uri}#${candidate.locator ?? ""}`;
    if (!refs.has(key)) refs.set(key, candidate);
  };

  const sourceDocumentUri = valueAsString(metadata.sourceDocumentUri);
  const sourceUri = valueAsString(metadata.sourceUri);
  const sourceFragmentLocator = valueAsString(metadata.sourceFragmentLocator);

  if (sourceDocumentUri) {
    pushRef({
      uri: sourceDocumentUri,
      locator: sourceFragmentLocator,
      origin: "metadata.sourceDocumentUri",
    });
  }
  if (sourceUri) {
    pushRef({
      uri: sourceUri,
      locator: sourceFragmentLocator,
      origin: "metadata.sourceUri",
    });
  }

  const stringRefFields = [
    ["metadata.sourceRefs", metadata.sourceRefs],
    ["metadata.candidateSourceRefs", metadata.candidateSourceRefs],
  ] as const;
  for (const [origin, field] of stringRefFields) {
    if (!Array.isArray(field)) continue;
    for (const item of field) {
      if (typeof item !== "string") continue;
      const split = splitRef(item);
      if (!split) continue;
      pushRef({
        ...split,
        origin,
      });
    }
  }

  const references = Array.isArray(metadata.references) ? metadata.references : [];
  for (const item of references) {
    const record = asRecord(item);
    const kind = valueAsString(record.kind);
    if (kind && kind !== "source") continue;
    const uri = valueAsString(record.uri);
    if (!uri) continue;
    const locator = valueAsString(record.locator);
    pushRef({
      uri,
      locator,
      origin: "metadata.references",
    });
  }

  return [...refs.values()];
}

async function resolveSourceFragmentForReference(
  ref: SourceReferenceCandidate,
): Promise<ResolvedSourceFragment | null> {
  const uriCandidates = equivalentUris(ref.uri);
  if (uriCandidates.length === 0) return null;

  const sourceRows = await db
    .select({
      sourceId: sources.id,
      sourceUri: sources.uri,
    })
    .from(sources)
    .where(inArray(sources.uri, uriCandidates));
  if (sourceRows.length === 0) return null;

  const sourceIdByUri = new Map(sourceRows.map((row) => [row.sourceUri, row.sourceId] as const));
  const sourceId = uriCandidates.map((candidate) => sourceIdByUri.get(candidate)).find(Boolean);
  if (!sourceId) return null;

  const fragments = await db
    .select({
      sourceFragmentId: sourceFragments.id,
      locator: sourceFragments.locator,
    })
    .from(sourceFragments)
    .where(eq(sourceFragments.sourceId, sourceId))
    .orderBy(asc(sourceFragments.createdAt));
  if (fragments.length === 0) return null;

  const requestedLocator = ref.locator?.trim();
  if (requestedLocator) {
    const exact = fragments.find((fragment) => fragment.locator === requestedLocator);
    if (exact) {
      return {
        sourceFragmentId: exact.sourceFragmentId,
        resolvedLocator: requestedLocator,
        resolution: "exact",
      };
    }
  }

  const full = fragments.find((fragment) => fragment.locator === "full");
  if (full) {
    return {
      sourceFragmentId: full.sourceFragmentId,
      resolvedLocator: "full",
      resolution: "fallback_full",
    };
  }

  const [firstFragment] = fragments;
  if (!firstFragment) return null;
  return {
    sourceFragmentId: firstFragment.sourceFragmentId,
    resolvedLocator: firstFragment.locator,
    resolution: "fallback_first",
  };
}

export async function linkKnowledgeFromMetadata(
  params: LinkKnowledgeFromMetadataParams,
): Promise<LinkKnowledgeFromMetadataResult> {
  const metadata = asRecord(params.metadata);
  const refs = extractSourceReferenceCandidates(metadata);
  if (refs.length === 0) {
    return {
      candidateReferenceCount: 0,
      resolvedReferenceCount: 0,
      insertedLinkCount: 0,
      skippedExistingLinkCount: 0,
      unresolvedReferenceCount: 0,
    };
  }

  const existingRows = await db
    .select({
      sourceFragmentId: knowledgeSourceLinks.sourceFragmentId,
    })
    .from(knowledgeSourceLinks)
    .where(eq(knowledgeSourceLinks.knowledgeId, params.knowledgeId));
  const existingFragments = new Set(existingRows.map((row) => row.sourceFragmentId));
  const plannedPairs = new Set<string>();

  let resolvedReferenceCount = 0;
  let insertedLinkCount = 0;
  let skippedExistingLinkCount = 0;

  for (const ref of refs) {
    const resolved = await resolveSourceFragmentForReference(ref);
    if (!resolved) continue;

    resolvedReferenceCount += 1;
    const pairKey = `${params.knowledgeId}::${resolved.sourceFragmentId}`;
    if (plannedPairs.has(pairKey) || existingFragments.has(resolved.sourceFragmentId)) {
      skippedExistingLinkCount += 1;
      continue;
    }

    await linkKnowledgeToSourceFragment({
      knowledgeId: params.knowledgeId,
      sourceFragmentId: resolved.sourceFragmentId,
      confidence: normalizeLinkConfidence(params.confidence),
      metadata: {
        source: params.linkMetadataSource,
        origin: ref.origin,
        uri: ref.uri,
        requestedLocator: ref.locator ?? null,
        resolvedLocator: resolved.resolvedLocator ?? null,
        resolution: resolved.resolution,
      },
    });
    plannedPairs.add(pairKey);
    existingFragments.add(resolved.sourceFragmentId);
    insertedLinkCount += 1;
  }

  return {
    candidateReferenceCount: refs.length,
    resolvedReferenceCount,
    insertedLinkCount,
    skippedExistingLinkCount,
    unresolvedReferenceCount: Math.max(0, refs.length - resolvedReferenceCount),
  };
}
