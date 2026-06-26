import { asc, eq } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import { redactSecrets } from "../../shared/utils/secret-redaction.js";
import { sliceTextByTokenWindow } from "../readFile/token-window.service.js";

type VibeMemoryRow = {
  id: string;
  session_id: string;
  content: string;
  metadata: unknown;
};

export type AgentDiffRow = {
  file_path: string;
  diff_hunk: string;
  change_type: string | null;
  language: string | null;
  symbol_name: string | null;
  symbol_kind: string | null;
};

export type FilteredVibeMemoryStats = {
  originalChars: number;
  filteredChars: number;
  droppedMessages: number;
  droppedToolOutputs: number;
  includedDiffHunks: number;
  truncatedDiffHunks: number;
};

export type FilteredVibeMemoryReadResult = {
  content: string;
  totalTokens: number;
  from: number;
  toExclusive: number;
  returnedTokens: number;
  stats: FilteredVibeMemoryStats;
};

export type FilteredVibeMemoryContent = {
  content: string;
  stats: FilteredVibeMemoryStats;
};

const maxMessageChars = 2200;
const maxToolCallChars = 900;
const maxDiffChars = 2400;
const maxDiffTotalChars = 12000;

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readRows(vibeMemoryId: string): Promise<{
  memory: VibeMemoryRow | null;
  diffs: AgentDiffRow[];
}> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const memory =
      sqlite.db
        .query<VibeMemoryRow, [string]>(
          `
          select id, session_id, content, metadata
          from vibe_memories
          where id = ?
          limit 1
        `,
        )
        .get(vibeMemoryId) ?? null;
    const diffs = sqlite.db
      .query<AgentDiffRow, [string]>(
        `
        select file_path, diff_hunk, change_type, language, symbol_name, symbol_kind
        from agent_diff_entries
        where vibe_memory_id = ?
        order by created_at asc, file_path asc, id asc
      `,
      )
      .all(vibeMemoryId);
    return { memory, diffs };
  }

  const [memoryRow] = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.id, vibeMemoryId))
    .limit(1);
  const diffs = await db
    .select()
    .from(agentDiffEntries)
    .where(eq(agentDiffEntries.vibeMemoryId, vibeMemoryId))
    .orderBy(
      asc(agentDiffEntries.createdAt),
      asc(agentDiffEntries.filePath),
      asc(agentDiffEntries.id),
    );
  return {
    memory: memoryRow
      ? {
          id: memoryRow.id,
          session_id: memoryRow.sessionId,
          content: memoryRow.content,
          metadata: memoryRow.metadata,
        }
      : null,
    diffs: diffs.map((entry) => ({
      file_path: entry.filePath,
      diff_hunk: entry.diffHunk,
      change_type: entry.changeType,
      language: entry.language,
      symbol_name: entry.symbolName,
      symbol_kind: entry.symbolKind,
    })),
  };
}

function stripKnownBoilerplate(text: string): string {
  return text
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/giu, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, "")
    .replace(/^(?:USER:\s*)?# AGENTS\.md instructions.*$/gimu, "")
    .replace(/^--- project-doc ---$/gimu, "")
    .replace(/^このプロジェクトでの作業を開始する際、最初に一度だけ .*$/gimu, "")
    .replace(/<filesystem>[\s\S]*?<\/filesystem>/giu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isProgressOnlyAssistantBlock(block: string): boolean {
  const normalized = block.replace(/\s+/gu, " ").trim();
  if (!normalized.startsWith("ASSISTANT:")) return false;
  if (normalized.length > 180) return false;
  if (/(通りました|失敗|原因|修正|完了|問題|error|failed|failed|failure|検証)/iu.test(normalized)) {
    return false;
  }
  return /(確認します|調べます|読みます|実行します|進めます|次に|最後に)/u.test(normalized);
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  const head = value.slice(0, Math.floor(maxChars * 0.7)).trimEnd();
  const tail = value.slice(value.length - Math.floor(maxChars * 0.2)).trimStart();
  return {
    text: `${head}\n[...truncated ${value.length - head.length - tail.length} chars...]\n${tail}`,
    truncated: true,
  };
}

function compactFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/gu, "/");
  for (const marker of ["/src/", "/test/", "/crates/", "/spec/", "/docs/"]) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-4).join("/");
}

function compactKnownFilePathsInText(text: string): string {
  return text.replace(/\/[^\s"'`),]+\/(?:src|test|crates|spec|docs)\/[^\s"'`),]+/gu, (match) =>
    compactFilePath(match),
  );
}

function filterMemoryContent(content: string): {
  text: string;
  droppedMessages: number;
  droppedToolOutputs: number;
} {
  const blocks = stripKnownBoilerplate(content)
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  let droppedMessages = 0;
  let droppedToolOutputs = 0;

  for (const block of blocks) {
    if (isProgressOnlyAssistantBlock(block)) {
      droppedMessages += 1;
      continue;
    }
    if (/^(TOOL|FUNCTION|SYSTEM):/iu.test(block) && block.length > maxMessageChars) {
      droppedToolOutputs += 1;
      continue;
    }
    const dedupeKey = block.replace(/\s+/gu, " ").trim().toLowerCase();
    if (seen.has(dedupeKey)) {
      droppedMessages += 1;
      continue;
    }
    seen.add(dedupeKey);
    kept.push(truncate(redactSecrets(compactKnownFilePathsInText(block)), maxMessageChars).text);
  }

  return {
    text: kept.join("\n\n"),
    droppedMessages,
    droppedToolOutputs,
  };
}

function toolCallLines(metadata: Record<string, unknown>): string[] {
  const toolCalls = metadata.toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of toolCalls.slice(0, 60)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const call = raw as Record<string, unknown>;
    const name = typeof call.name === "string" ? call.name : "tool";
    const command =
      typeof call.command === "string" ? compactKnownFilePathsInText(call.command) : undefined;
    const targetFile =
      typeof call.targetFile === "string" ? compactFilePath(call.targetFile) : undefined;
    const contentPreview =
      typeof call.contentPreview === "string"
        ? truncate(compactKnownFilePathsInText(call.contentPreview), 500).text
        : undefined;
    const pieces = [
      `tool=${name}`,
      command ? `command=${command}` : undefined,
      targetFile ? `targetFile=${targetFile}` : undefined,
      contentPreview ? `contentPreview=${contentPreview}` : undefined,
    ].filter((piece): piece is string => Boolean(piece));
    const line = redactSecrets(pieces.join(" "));
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    lines.push(truncate(line, maxToolCallChars).text);
  }
  return lines;
}

function isNoisyDiffPath(filePath: string): boolean {
  return (
    /(^|\/)(node_modules|coverage|dist|build|target|\.next)\//u.test(filePath) ||
    /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(filePath)
  );
}

function diffSection(diffs: AgentDiffRow[]): {
  lines: string[];
  includedDiffHunks: number;
  truncatedDiffHunks: number;
} {
  const lines: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  let includedDiffHunks = 0;
  let truncatedDiffHunks = 0;

  for (const diff of diffs) {
    if (isNoisyDiffPath(diff.file_path)) continue;
    const key = `${diff.file_path}\n${diff.diff_hunk}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (totalChars >= maxDiffTotalChars) {
      truncatedDiffHunks += 1;
      continue;
    }
    const remaining = Math.max(200, maxDiffTotalChars - totalChars);
    const maxChars = Math.min(maxDiffChars, remaining);
    const truncated = truncate(
      redactSecrets(compactKnownFilePathsInText(diff.diff_hunk)),
      maxChars,
    );
    if (truncated.truncated) truncatedDiffHunks += 1;
    const header = [
      `file=${compactFilePath(diff.file_path)}`,
      diff.change_type ? `changeType=${diff.change_type}` : undefined,
      diff.language ? `language=${diff.language}` : undefined,
      diff.symbol_name ? `symbol=${diff.symbol_name}` : undefined,
      diff.symbol_kind ? `symbolKind=${diff.symbol_kind}` : undefined,
    ]
      .filter((piece): piece is string => Boolean(piece))
      .join(" ");
    const block = `${header}\n${truncated.text}`;
    totalChars += block.length;
    includedDiffHunks += 1;
    lines.push(block);
  }

  return { lines, includedDiffHunks, truncatedDiffHunks };
}

export async function readFilteredVibeMemoryForCandidateWindow(input: {
  vibeMemoryId: string;
  fromToken?: number;
  readTokens?: number;
}): Promise<FilteredVibeMemoryReadResult> {
  const vibeMemoryId = input.vibeMemoryId.trim();
  if (!vibeMemoryId) throw new Error("vibeMemoryId is required");
  const { memory, diffs } = await readRows(vibeMemoryId);
  if (!memory) throw new Error(`vibe memory not found: ${vibeMemoryId}`);

  const filtered = buildFilteredVibeMemoryForCandidateContent({
    id: memory.id,
    sessionId: memory.session_id,
    content: memory.content,
    metadata: asRecord(memory.metadata),
    diffs,
  });
  const readTokens = Math.min(
    Math.max(1, Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens)),
    Math.max(1, groupedConfig.readFile.maxTokens),
  );
  const window = sliceTextByTokenWindow({
    text: filtered.content,
    fromToken: Math.max(0, Math.floor(input.fromToken ?? 0)),
    readTokens,
  });
  return {
    content: window.content,
    totalTokens: window.totalTokens,
    from: window.tokenRange.from,
    toExclusive: window.tokenRange.toExclusive,
    returnedTokens: window.returnedTokens,
    stats: filtered.stats,
  };
}

export function buildFilteredVibeMemoryForCandidateContent(input: {
  id: string;
  sessionId: string;
  content: string;
  metadata?: Record<string, unknown>;
  diffs?: AgentDiffRow[];
}): FilteredVibeMemoryContent {
  const metadata = input.metadata ?? {};
  const diffs = input.diffs ?? [];
  const filteredMemory = filterMemoryContent(input.content);
  const tools = toolCallLines(metadata);
  const diff = diffSection(diffs);
  const sections = [
    `[filtered_vibe_memory]\nid=${input.id}\nsession_id=${input.sessionId}`,
    filteredMemory.text ? `[messages]\n${filteredMemory.text}` : undefined,
    tools.length > 0 ? `[tool_calls]\n${tools.join("\n")}` : undefined,
    diff.lines.length > 0 ? `[agent_diffs]\n${diff.lines.join("\n\n")}` : undefined,
  ].filter((section): section is string => Boolean(section));
  const content = sections.join("\n\n");
  return {
    content,
    stats: {
      originalChars:
        input.content.length + diffs.reduce((total, entry) => total + entry.diff_hunk.length, 0),
      filteredChars: content.length,
      droppedMessages: filteredMemory.droppedMessages,
      droppedToolOutputs: filteredMemory.droppedToolOutputs,
      includedDiffHunks: diff.includedDiffHunks,
      truncatedDiffHunks: diff.truncatedDiffHunks,
    },
  };
}
