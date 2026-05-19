import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { asc, inArray } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/index.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
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
      inputHash: sha256(content),
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
  const memories = await db
    .select()
    .from(vibeMemories)
    .orderBy(asc(vibeMemories.createdAt), asc(vibeMemories.id))
    .limit(limit);

  if (memories.length === 0) return [];

  const diffs = await db
    .select()
    .from(agentDiffEntries)
    .where(
      inArray(
        agentDiffEntries.vibeMemoryId,
        memories.map((memory) => memory.id),
      ),
    )
    .orderBy(
      asc(agentDiffEntries.vibeMemoryId),
      asc(agentDiffEntries.createdAt),
      asc(agentDiffEntries.filePath),
      asc(agentDiffEntries.id),
    );

  const diffsByMemoryId = new Map<string, typeof diffs>();
  for (const diff of diffs) {
    const current = diffsByMemoryId.get(diff.vibeMemoryId) ?? [];
    current.push(diff);
    diffsByMemoryId.set(diff.vibeMemoryId, current);
  }

  return memories.map((memory) => {
    const memoryDiffs = diffsByMemoryId.get(memory.id) ?? [];
    const hashInput = [
      memory.content,
      ...memoryDiffs.map((diff) => `${diff.filePath}\n${diff.diffHunk}`),
    ].join("\n\n--- agent diff ---\n\n");
    return {
      targetKind: "vibe_memory",
      targetKey: memory.id,
      sourceUri: `vibe_memory:${memory.id}`,
      inputHash: sha256(hashInput),
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
    states.map((state) => [`${state.targetKind}\0${state.targetKey}\0${state.inputHash}`, state]),
  );

  return params.candidates.map((candidate) => {
    const state = stateByTarget.get(
      `${candidate.targetKind}\0${candidate.targetKey}\0${candidate.inputHash}`,
    );
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
