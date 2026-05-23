import { count, desc, eq, inArray } from "drizzle-orm";
import { closeDbPool, getDb } from "../db/index.js";
import { knowledgeItems, knowledgeSourceLinks, sourceFragments, sources } from "../db/schema.js";
import { linkKnowledgeToSourceFragment } from "../modules/finalizeDistille/source-link.repository.js";

type CliOptions = {
  apply: boolean;
  limit?: number;
  includeLinked: boolean;
  confidence: number;
};

type KnowledgeRow = {
  id: string;
  metadata: unknown;
};

type ReferenceCandidate = {
  uri: string;
  locator?: string;
  origin: string;
};

type FragmentIndex = {
  firstFragmentId: string;
  fullFragmentId?: string;
  fragmentIdByLocator: Map<string, string>;
};

type LinkPlan = {
  knowledgeId: string;
  sourceFragmentId: string;
  uri: string;
  locator?: string;
  resolvedLocator?: string;
  resolution: "exact" | "fallback_full" | "fallback_first";
  origin: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseConfidence(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--confidence must be a number between 0 and 1");
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    includeLinked: false,
    confidence: 0.7,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--include-linked") {
      options.includeLinked = true;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      if (arg === "--limit") index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
      continue;
    }
    if (arg === "--confidence" || arg.startsWith("--confidence=")) {
      const raw = readArgValue(args, index, "--confidence");
      if (arg === "--confidence") index += 1;
      options.confidence = parseConfidence(raw);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
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
    uri.startsWith("agent://") ||
    uri.startsWith("memory-router://") ||
    uri.startsWith("vibe_memory:") ||
    uri.startsWith("search:")
  );
}

function sourceReferenceCandidates(metadata: Record<string, unknown>): ReferenceCandidate[] {
  const refs = new Map<string, ReferenceCandidate>();
  const pushRef = (candidate: ReferenceCandidate | null) => {
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

function chunk<T>(values: T[], size: number): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function fetchKnowledgeRows(limit?: number): Promise<KnowledgeRow[]> {
  const db = getDb();
  const query = db
    .select({
      id: knowledgeItems.id,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .orderBy(desc(knowledgeItems.updatedAt));

  return limit !== undefined ? query.limit(limit) : query;
}

async function fetchSourceInventory(): Promise<{
  sourceCount: number;
  sourceFragmentCount: number;
}> {
  const db = getDb();
  const [sourceCountRow, sourceFragmentCountRow] = await Promise.all([
    db.select({ count: count() }).from(sources),
    db.select({ count: count() }).from(sourceFragments),
  ]);

  return {
    sourceCount: Number(sourceCountRow[0]?.count ?? 0),
    sourceFragmentCount: Number(sourceFragmentCountRow[0]?.count ?? 0),
  };
}

async function fetchExistingPairs(knowledgeIds: string[]): Promise<Set<string>> {
  if (knowledgeIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({
      knowledgeId: knowledgeSourceLinks.knowledgeId,
      sourceFragmentId: knowledgeSourceLinks.sourceFragmentId,
    })
    .from(knowledgeSourceLinks)
    .where(inArray(knowledgeSourceLinks.knowledgeId, knowledgeIds));

  const set = new Set<string>();
  for (const row of rows) {
    set.add(`${row.knowledgeId}::${row.sourceFragmentId}`);
  }
  return set;
}

async function fetchSourcesByUris(uriCandidates: string[]): Promise<Map<string, string>> {
  if (uriCandidates.length === 0) return new Map();
  const db = getDb();
  const result = new Map<string, string>();
  for (const values of chunk(uriCandidates, 500)) {
    const rows = await db
      .select({
        sourceId: sources.id,
        uri: sources.uri,
      })
      .from(sources)
      .where(inArray(sources.uri, values));
    for (const row of rows) {
      result.set(row.uri, row.sourceId);
    }
  }
  return result;
}

async function fetchFragmentsBySourceIds(sourceIds: string[]): Promise<Map<string, FragmentIndex>> {
  if (sourceIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      sourceId: sourceFragments.sourceId,
      sourceFragmentId: sourceFragments.id,
      locator: sourceFragments.locator,
      createdAt: sourceFragments.createdAt,
    })
    .from(sourceFragments)
    .where(inArray(sourceFragments.sourceId, sourceIds))
    .orderBy(sourceFragments.sourceId, sourceFragments.createdAt);

  const map = new Map<string, FragmentIndex>();
  for (const row of rows) {
    const current = map.get(row.sourceId);
    if (!current) {
      map.set(row.sourceId, {
        firstFragmentId: row.sourceFragmentId,
        fullFragmentId: row.locator === "full" ? row.sourceFragmentId : undefined,
        fragmentIdByLocator: new Map([[row.locator, row.sourceFragmentId]]),
      });
      continue;
    }

    if (!current.fragmentIdByLocator.has(row.locator)) {
      current.fragmentIdByLocator.set(row.locator, row.sourceFragmentId);
    }
    if (!current.fullFragmentId && row.locator === "full") {
      current.fullFragmentId = row.sourceFragmentId;
    }
  }

  return map;
}

function resolveFragment(params: {
  sourceId: string;
  requestedLocator?: string;
  fragmentIndexBySourceId: Map<string, FragmentIndex>;
}): { sourceFragmentId: string; resolvedLocator?: string; resolution: LinkPlan["resolution"] } | null {
  const fragmentIndex = params.fragmentIndexBySourceId.get(params.sourceId);
  if (!fragmentIndex) return null;

  const requestedLocator = params.requestedLocator?.trim();
  if (requestedLocator) {
    const exact = fragmentIndex.fragmentIdByLocator.get(requestedLocator);
    if (exact) {
      return {
        sourceFragmentId: exact,
        resolvedLocator: requestedLocator,
        resolution: "exact",
      };
    }
  }

  if (fragmentIndex.fullFragmentId) {
    return {
      sourceFragmentId: fragmentIndex.fullFragmentId,
      resolvedLocator: "full",
      resolution: "fallback_full",
    };
  }

  return {
    sourceFragmentId: fragmentIndex.firstFragmentId,
    resolution: "fallback_first",
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourceInventory = await fetchSourceInventory();
  if (sourceInventory.sourceCount === 0 || sourceInventory.sourceFragmentCount === 0) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: !options.apply,
          limit: options.limit ?? null,
          includeLinked: options.includeLinked,
          confidence: options.confidence,
          scannedKnowledgeRows: 0,
          targetKnowledgeRows: 0,
          rowsWithReferenceCandidates: 0,
          candidateReferenceCount: 0,
          resolvedReferenceCount: 0,
          unresolvedReferenceCount: 0,
          existingLinkedPairCount: 0,
          plannedLinkCount: 0,
          insertedLinkCount: 0,
          linkedKnowledgeCount: 0,
          unresolvedUriSample: [],
          unresolvedLocatorSample: [],
          sourceCount: sourceInventory.sourceCount,
          sourceFragmentCount: sourceInventory.sourceFragmentCount,
          warning:
            "sources/source_fragments are empty. Import sources first (e.g. bun run import:sources), then rerun this script.",
        },
        null,
        2,
      ),
    );
    return;
  }

  const rows = await fetchKnowledgeRows(options.limit);
  const knowledgeIds = rows.map((row) => row.id);
  const existingPairs = await fetchExistingPairs(knowledgeIds);

  const existingLinkedKnowledgeIds = new Set<string>();
  for (const key of existingPairs) {
    const [knowledgeId] = key.split("::", 1);
    if (knowledgeId) existingLinkedKnowledgeIds.add(knowledgeId);
  }

  const targetRows = options.includeLinked
    ? rows
    : rows.filter((row) => !existingLinkedKnowledgeIds.has(row.id));

  const refsByKnowledgeId = new Map<string, ReferenceCandidate[]>();
  const uriCandidates = new Set<string>();

  for (const row of targetRows) {
    const metadata = asRecord(row.metadata);
    const refs = sourceReferenceCandidates(metadata);
    if (refs.length === 0) continue;
    refsByKnowledgeId.set(row.id, refs);
    for (const ref of refs) {
      for (const uri of equivalentUris(ref.uri)) {
        uriCandidates.add(uri);
      }
    }
  }

  const sourceIdByUri = await fetchSourcesByUris([...uriCandidates]);
  const sourceIds = [...new Set(sourceIdByUri.values())];
  const fragmentIndexBySourceId = await fetchFragmentsBySourceIds(sourceIds);

  const plannedLinks = new Map<string, LinkPlan>();
  const unresolvedUris = new Set<string>();
  const unresolvedLocators = new Set<string>();
  let candidateRefCount = 0;
  let resolvedRefCount = 0;
  let skippedAlreadyLinked = 0;

  for (const [knowledgeId, refs] of refsByKnowledgeId.entries()) {
    for (const ref of refs) {
      candidateRefCount += 1;

      const equivalents = equivalentUris(ref.uri);
      const sourceId = equivalents.map((uri) => sourceIdByUri.get(uri)).find(Boolean);
      if (!sourceId) {
        unresolvedUris.add(ref.uri);
        continue;
      }

      const resolved = resolveFragment({
        sourceId,
        requestedLocator: ref.locator,
        fragmentIndexBySourceId,
      });
      if (!resolved) {
        unresolvedLocators.add(`${ref.uri}#${ref.locator ?? ""}`);
        continue;
      }

      resolvedRefCount += 1;
      const pairKey = `${knowledgeId}::${resolved.sourceFragmentId}`;
      if (existingPairs.has(pairKey)) {
        skippedAlreadyLinked += 1;
        continue;
      }
      if (!plannedLinks.has(pairKey)) {
        plannedLinks.set(pairKey, {
          knowledgeId,
          sourceFragmentId: resolved.sourceFragmentId,
          uri: ref.uri,
          locator: ref.locator,
          resolvedLocator: resolved.resolvedLocator,
          resolution: resolved.resolution,
          origin: ref.origin,
        });
      }
    }
  }

  let insertedLinks = 0;
  if (options.apply) {
    for (const link of plannedLinks.values()) {
      await linkKnowledgeToSourceFragment({
        knowledgeId: link.knowledgeId,
        sourceFragmentId: link.sourceFragmentId,
        confidence: options.confidence,
        metadata: {
          source: "backfillKnowledgeSourceLinks",
          origin: link.origin,
          uri: link.uri,
          requestedLocator: link.locator ?? null,
          resolvedLocator: link.resolvedLocator ?? null,
          resolution: link.resolution,
        },
      });
      insertedLinks += 1;
    }
  }

  const linkedKnowledgeIds = new Set<string>([...plannedLinks.values()].map((link) => link.knowledgeId));

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: !options.apply,
        limit: options.limit ?? null,
        includeLinked: options.includeLinked,
        confidence: options.confidence,
        scannedKnowledgeRows: rows.length,
        targetKnowledgeRows: targetRows.length,
        rowsWithReferenceCandidates: refsByKnowledgeId.size,
        candidateReferenceCount: candidateRefCount,
        resolvedReferenceCount: resolvedRefCount,
        unresolvedReferenceCount: Math.max(0, candidateRefCount - resolvedRefCount),
        existingLinkedPairCount: skippedAlreadyLinked,
        plannedLinkCount: plannedLinks.size,
        insertedLinkCount: insertedLinks,
        linkedKnowledgeCount: linkedKnowledgeIds.size,
        unresolvedUriSample: [...unresolvedUris].slice(0, 20),
        unresolvedLocatorSample: [...unresolvedLocators].slice(0, 20),
        sourceCount: sourceInventory.sourceCount,
        sourceFragmentCount: sourceInventory.sourceFragmentCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
