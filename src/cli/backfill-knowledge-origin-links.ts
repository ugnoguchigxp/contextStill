import { count, desc, eq, inArray } from "drizzle-orm";
import { closeDbPool, getDb } from "../db/index.js";
import { knowledgeItems, knowledgeOriginLinks } from "../db/schema.js";

type CliOptions = {
  apply: boolean;
  limit?: number;
  includeLinked: boolean;
  json: boolean;
};

type KnowledgeRow = {
  id: string;
  metadata: unknown;
};

type OriginExtract = {
  kind: "vibe_memory" | "agent_candidate" | "landscape_review_item";
  key: string;
  uri: string;
};

type IgnoredFamily =
  | "local_path"
  | "file"
  | "web"
  | "cover_evidence"
  | "memory_router"
  | "search"
  | "other";

type LinkPlan = {
  knowledgeId: string;
  originKind: OriginExtract["kind"];
  originUri: string;
  originKey: string;
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    includeLinked: false,
    json: false,
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
      options.json = true;
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function extractOrigin(uri: string): { origin: OriginExtract } | { ignored: IgnoredFamily } | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("vibe_memory:")) {
    const key = trimmed.substring("vibe_memory:".length);
    return {
      origin: {
        kind: "vibe_memory",
        key,
        uri: trimmed,
      },
    };
  }

  if (trimmed.startsWith("agent://candidate/")) {
    const key = trimmed.substring("agent://candidate/".length);
    return {
      origin: {
        kind: "agent_candidate",
        key,
        uri: trimmed,
      },
    };
  }

  if (trimmed.startsWith("landscape://review-item/")) {
    const key = trimmed.substring("landscape://review-item/".length);
    return {
      origin: {
        kind: "landscape_review_item",
        key,
        uri: trimmed,
      },
    };
  }

  // Ignored checks
  if (trimmed.startsWith("cover-evidence-result://")) {
    return { ignored: "cover_evidence" };
  }
  if (trimmed.startsWith("context-still://") || trimmed.startsWith("memory-router://")) {
    return { ignored: "memory_router" };
  }
  if (trimmed.startsWith("search:")) {
    return { ignored: "search" };
  }
  if (trimmed.startsWith("file://")) {
    return { ignored: "file" };
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:\\/.test(trimmed)) {
    return { ignored: "local_path" };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { ignored: "web" };
  }

  return { ignored: "other" };
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

async function fetchExistingOriginPairs(knowledgeIds: string[]): Promise<Set<string>> {
  if (knowledgeIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({
      knowledgeId: knowledgeOriginLinks.knowledgeId,
      originKind: knowledgeOriginLinks.originKind,
      originUri: knowledgeOriginLinks.originUri,
    })
    .from(knowledgeOriginLinks)
    .where(inArray(knowledgeOriginLinks.knowledgeId, knowledgeIds));

  const set = new Set<string>();
  for (const row of rows) {
    set.add(`${row.knowledgeId}::${row.originKind}::${row.originUri}`);
  }
  return set;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await fetchKnowledgeRows(options.limit);
  const knowledgeIds = rows.map((row) => row.id);
  const existingPairs = await fetchExistingOriginPairs(knowledgeIds);

  const existingLinkedKnowledgeIds = new Set<string>();
  for (const key of existingPairs) {
    const [knowledgeId] = key.split("::", 1);
    if (knowledgeId) existingLinkedKnowledgeIds.add(knowledgeId);
  }

  const targetRows = options.includeLinked
    ? rows
    : rows.filter((row) => !existingLinkedKnowledgeIds.has(row.id));

  const plannedLinks = new Map<string, LinkPlan>();
  const originCandidateKnowledgeIds = new Set<string>();
  let existingLinkedPairCount = 0;

  const originKindCounts = {
    vibe_memory: 0,
    agent_candidate: 0,
    landscape_review_item: 0,
  };

  const ignoredFamilyCounts = {
    local_path: 0,
    file: 0,
    web: 0,
    cover_evidence: 0,
    memory_router: 0,
    search: 0,
    other: 0,
  };

  for (const row of targetRows) {
    const metadata = asRecord(row.metadata);
    const uris = new Set<string>();

    const sourceDocumentUri = valueAsString(metadata.sourceDocumentUri);
    const sourceUri = valueAsString(metadata.sourceUri);
    if (sourceDocumentUri) uris.add(sourceDocumentUri);
    if (sourceUri) uris.add(sourceUri);

    if (Array.isArray(metadata.sourceRefs)) {
      for (const ref of metadata.sourceRefs) {
        if (typeof ref === "string") uris.add(ref);
      }
    }
    if (Array.isArray(metadata.candidateSourceRefs)) {
      for (const ref of metadata.candidateSourceRefs) {
        if (typeof ref === "string") uris.add(ref);
      }
    }
    if (Array.isArray(metadata.references)) {
      for (const item of metadata.references) {
        const record = asRecord(item);
        const uri = valueAsString(record.uri);
        if (uri) uris.add(uri);
      }
    }

    for (const uri of uris) {
      const result = extractOrigin(uri);
      if (!result) continue;

      if ("origin" in result) {
        const { kind, key, uri: normalizedUri } = result.origin;
        originKindCounts[kind]++;
        originCandidateKnowledgeIds.add(row.id);

        const pairKey = `${row.id}::${kind}::${normalizedUri}`;
        if (existingPairs.has(pairKey)) {
          existingLinkedPairCount++;
          continue;
        }

        if (!plannedLinks.has(pairKey)) {
          plannedLinks.set(pairKey, {
            knowledgeId: row.id,
            originKind: kind,
            originUri: normalizedUri,
            originKey: key,
          });
        }
      } else if ("ignored" in result) {
        ignoredFamilyCounts[result.ignored]++;
      }
    }
  }

  let insertedLinkCount = 0;
  if (options.apply && plannedLinks.size > 0) {
    const db = getDb();
    for (const link of plannedLinks.values()) {
      const inserted = await db
        .insert(knowledgeOriginLinks)
        .values({
          knowledgeId: link.knowledgeId,
          originKind: link.originKind,
          originUri: link.originUri,
          originKey: link.originKey,
          confidence: 1.0,
          metadata: { source: "backfillKnowledgeOriginLinks" },
        })
        .onConflictDoNothing()
        .returning({ id: knowledgeOriginLinks.id });
      if (inserted.length > 0) insertedLinkCount++;
    }
  }

  const output = {
    ok: true,
    dryRun: !options.apply,
    scannedKnowledgeRows: rows.length,
    originCandidateKnowledgeRows: originCandidateKnowledgeIds.size,
    plannedLinkCount: plannedLinks.size,
    insertedLinkCount,
    existingLinkedPairCount,
    originKindCounts,
    ignoredFamilyCounts: {
      local_path: ignoredFamilyCounts.local_path,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("Backfill origin links result:");
    console.log(`- Dry run: ${output.dryRun}`);
    console.log(`- Scanned knowledge: ${output.scannedKnowledgeRows}`);
    console.log(`- Planned links to insert: ${output.plannedLinkCount}`);
    console.log(`- Successfully inserted links: ${output.insertedLinkCount}`);
    console.log(`- Existing links skipped: ${output.existingLinkedPairCount}`);
    console.log("- Origin kinds breakdown:", JSON.stringify(output.originKindCounts));
    console.log(`- Ignored local paths: ${output.ignoredFamilyCounts.local_path}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
