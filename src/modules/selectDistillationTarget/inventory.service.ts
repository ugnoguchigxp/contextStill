import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { asc } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/index.js";
import { vibeMemories } from "../../db/schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  selectDistillationTarget,
  selectedTargetFromState,
  type DistillationTargetCandidate,
  type DistillationTargetKind,
  type DistillationTargetStatus,
  type SelectedDistillationTarget,
} from "./domain.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  findNextSelectableDistillationTargetState,
  listDistillationTargetStatesForCandidates,
  markMissingWikiTargetsSkipped,
  upsertDistillationTargetState,
} from "./repository.js";

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isMissingRelationError(error: unknown, relationName: string): boolean {
  const needle = `relation "${relationName}" does not exist`;
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (typeof current === "string") {
      if (current.includes(needle)) return true;
      continue;
    }
    if (current instanceof Error) {
      if (current.message.includes(needle)) return true;
      const coded = current as Error & { code?: string; cause?: unknown };
      if (coded.code === "42P01") return true;
      if (coded.cause) queue.push(coded.cause);
      continue;
    }
    if (typeof current === "object") {
      const shaped = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
        originalError?: unknown;
      };
      if (shaped.code === "42P01") return true;
      if (typeof shaped.message === "string" && shaped.message.includes(needle)) return true;
      if (shaped.cause) queue.push(shaped.cause);
      if (shaped.originalError) queue.push(shaped.originalError);
    }
  }

  return false;
}

async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const parentPath =
      "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : rootDir;
    files.push(path.join(parentPath, entry.name));
  }
  return files.sort();
}

export async function collectWikiFileTargetCandidates(
  params: {
    rootPath?: string;
  } = {},
): Promise<DistillationTargetCandidate[]> {
  const rootPath = path.resolve(params.rootPath ?? groupedConfig.readFile.root);
  const files = await collectMarkdownFiles(rootPath);
  const candidates: DistillationTargetCandidate[] = [];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) continue;

    const absolutePath = path.resolve(filePath);
    const targetKey = toPosixPath(path.relative(rootPath, absolutePath));
    candidates.push({
      targetKind: "wiki_file",
      targetKey,
      sourceUri: absolutePath,
      status: "pending",
      sortKey: targetKey.toLowerCase(),
    });
  }

  return candidates.sort((a, b) =>
    (a.sortKey ?? a.targetKey).localeCompare(b.sortKey ?? b.targetKey),
  );
}

export async function collectVibeMemoryTargetCandidates(
  params: {
    limit?: number;
  } = {},
): Promise<DistillationTargetCandidate[]> {
  const limit = Math.max(1, Math.floor(params.limit ?? 100));
  let memories: Array<typeof vibeMemories.$inferSelect> = [];
  try {
    memories = await db
      .select()
      .from(vibeMemories)
      .orderBy(asc(vibeMemories.createdAt), asc(vibeMemories.id))
      .limit(limit);
  } catch (error) {
    if (isMissingRelationError(error, "vibe_memories")) {
      return [];
    }
    throw error;
  }

  if (memories.length === 0) return [];

  return memories.map((memory) => {
    return {
      targetKind: "vibe_memory",
      targetKey: memory.id,
      sourceUri: `vibe_memory:${memory.id}`,
      status: "pending",
      sortKey: memory.id,
      createdAt: memory.createdAt,
    } satisfies DistillationTargetCandidate;
  });
}

export async function applyPersistedDistillationTargetStatuses(params: {
  candidates: DistillationTargetCandidate[];
  distillationVersion?: string;
}): Promise<DistillationTargetCandidate[]> {
  const states = await listDistillationTargetStatesForCandidates({
    candidates: params.candidates,
    distillationVersion: params.distillationVersion,
  });
  const stateByTarget = new Map(
    states.map((state) => [`${state.targetKind}\0${state.targetKey}`, state]),
  );

  return params.candidates.map((candidate) => {
    const state = stateByTarget.get(`${candidate.targetKind}\0${candidate.targetKey}`);
    return state
      ? {
          ...candidate,
          status: state.status as DistillationTargetStatus,
          sortKey: state.sortKey,
        }
      : candidate;
  });
}

export type RefreshDistillationTargetInventoryResult = {
  distillationVersion: string;
  wikiTargets: number;
  vibeMemoryTargets: number;
  missingWikiTargetsSkipped: number;
};

export async function refreshDistillationTargetInventory(
  params: {
    kind?: "auto" | "wiki" | "vibe";
    rootPath?: string;
    vibeLimit?: number;
    distillationVersion?: string;
  } = {},
): Promise<RefreshDistillationTargetInventoryResult> {
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const rootPath = path.resolve(params.rootPath ?? groupedConfig.readFile.root);
  const kind = params.kind ?? "auto";
  const includeWiki = kind === "auto" || kind === "wiki";
  const includeVibe = kind === "auto" || kind === "vibe";

  const wikiCandidates = includeWiki ? await collectWikiFileTargetCandidates({ rootPath }) : [];
  const vibeCandidates = includeVibe
    ? await collectVibeMemoryTargetCandidates({ limit: params.vibeLimit })
    : [];

  for (const candidate of [...wikiCandidates, ...vibeCandidates]) {
    await upsertDistillationTargetState({
      candidate,
      distillationVersion,
      metadata: {
        inventoryRefreshedAt: new Date().toISOString(),
      },
    });
  }

  const missingWikiTargetsSkipped = includeWiki
    ? await markMissingWikiTargetsSkipped({
        currentTargetKeys: new Set(wikiCandidates.map((candidate) => candidate.targetKey)),
        rootPath,
        distillationVersion,
      })
    : 0;

  const result = {
    distillationVersion,
    wikiTargets: wikiCandidates.length,
    vibeMemoryTargets: vibeCandidates.length,
    missingWikiTargetsSkipped,
  };

  await recordAuditLogSafe({
    eventType: auditEventTypes.distillationTargetInventoryRefreshed,
    actor: "system",
    payload: result,
  });

  return result;
}

async function selectFromCandidatesWithPersistedStatuses(params: {
  candidates: DistillationTargetCandidate[];
  distillationVersion?: string;
}): Promise<SelectedDistillationTarget | null> {
  const candidates = await applyPersistedDistillationTargetStatuses(params);
  return selectDistillationTarget(candidates);
}

export async function previewNextDistillationTarget(
  params: {
    kind?: "auto" | "wiki" | "vibe";
    rootPath?: string;
    vibeLimit?: number;
    distillationVersion?: string;
    fromStateTable?: boolean;
  } = {},
): Promise<SelectedDistillationTarget | null> {
  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  if (params.fromStateTable) {
    const targetKind: DistillationTargetKind | undefined =
      params.kind === "wiki" ? "wiki_file" : params.kind === "vibe" ? "vibe_memory" : undefined;
    const state = await findNextSelectableDistillationTargetState({
      distillationVersion,
      targetKind,
    });
    return state ? selectedTargetFromState(state) : null;
  }

  const kind = params.kind ?? "auto";
  const wikiCandidates =
    kind === "vibe" ? [] : await collectWikiFileTargetCandidates({ rootPath: params.rootPath });
  const wikiSelected =
    kind === "vibe"
      ? null
      : await selectFromCandidatesWithPersistedStatuses({
          candidates: wikiCandidates,
          distillationVersion,
        });
  if (wikiSelected || kind === "wiki") return wikiSelected;

  const vibeCandidates = await collectVibeMemoryTargetCandidates({ limit: params.vibeLimit });
  return selectFromCandidatesWithPersistedStatuses({
    candidates: vibeCandidates,
    distillationVersion,
  });
}
