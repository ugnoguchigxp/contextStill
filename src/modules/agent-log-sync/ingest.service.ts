import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groupedConfig } from "../../config.js";
import {
  type ChatMessage,
  type IngestCursor,
  parseAntigravityOverviewMessages,
  sessionIdFromFile,
} from "./antigravity-parser.js";
import { parseClaudeSessionLog } from "./claude-parser.js";
import {
  type CodexFileContext,
  processCodexJsonlDelta,
  readCodexFileContext,
} from "./codex-parser.js";
import { filterSensitiveData } from "./log-filter.js";
import { deriveProjectFromPath } from "./project-analyzer.js";

type ChatRole = "user" | "assistant";

export { type ChatMessage, type IngestCursor, processCodexJsonlDelta };

export type IngestResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  messages: ChatMessage[];
  cursor: IngestCursor;
  maxObservedMtimeMs: number;
  checkedFiles: number;
  skipped?: boolean;
};

type IngestFileCursor = {
  offset: number;
  mtimeMs: number;
};

type RootBuildOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  codexSessionDir?: string;
  codexArchivedSessionDir?: string;
  antigravityLogDir?: string;
};

function parseAdditionalRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueNonEmptyPaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function windowsCodexFallbackRoots(options?: RootBuildOptions): {
  sessionRoots: string[];
  archivedRoots: string[];
} {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  if (platform !== "win32") {
    return { sessionRoots: [], archivedRoots: [] };
  }

  const appDataRoots = [env.APPDATA, env.LOCALAPPDATA]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  const sessionRoots = appDataRoots.flatMap((base) => [
    path.join(base, "codex", "sessions"),
    path.join(base, "openai", "codex", "sessions"),
    path.join(base, "OpenAI", "Codex", "sessions"),
  ]);
  const archivedRoots = appDataRoots.flatMap((base) => [
    path.join(base, "codex", "archived_sessions"),
    path.join(base, "openai", "codex", "archived_sessions"),
    path.join(base, "OpenAI", "Codex", "archived_sessions"),
  ]);
  return { sessionRoots, archivedRoots };
}

function windowsAntigravityFallbackRoots(options?: RootBuildOptions): string[] {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  if (platform !== "win32") return [];
  const appDataRoots = [env.APPDATA, env.LOCALAPPDATA]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  return appDataRoots.flatMap((base) => [
    path.join(base, "gemini", "antigravity-cli", "brain"),
    path.join(base, "gemini", "antigravity-ide", "brain"),
    path.join(base, "gemini", "antigravity", "brain"),
    path.join(base, "Google", "Gemini", "antigravity-cli", "brain"),
    path.join(base, "Google", "Gemini", "antigravity-ide", "brain"),
    path.join(base, "Google", "Gemini", "antigravity", "brain"),
  ]);
}

export function buildCodexIngestRoots(options?: RootBuildOptions): string[] {
  const env = options?.env ?? process.env;
  const windowsFallback = windowsCodexFallbackRoots(options);
  const codexSessionDir = options?.codexSessionDir ?? groupedConfig.codex.sessionDir;
  const codexArchivedSessionDir =
    options?.codexArchivedSessionDir ?? groupedConfig.codex.archivedSessionDir;

  return uniqueNonEmptyPaths([
    codexSessionDir,
    codexArchivedSessionDir,
    ...windowsFallback.sessionRoots,
    ...windowsFallback.archivedRoots,
    ...parseAdditionalRoots(env.MEMORY_ROUTER_CODEX_SESSION_DIRS),
    ...parseAdditionalRoots(env.MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIRS),
  ]);
}

export function buildAntigravityIngestRoots(options?: RootBuildOptions): string[] {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const homeGeminiDir = path.join(homeDir, ".gemini");
  const antigravityLogDir = options?.antigravityLogDir ?? groupedConfig.antigravity.logDir;

  return uniqueNonEmptyPaths([
    antigravityLogDir,
    path.join(homeGeminiDir, "antigravity-cli", "brain"),
    path.join(homeGeminiDir, "antigravity-ide", "brain"),
    path.join(homeGeminiDir, "antigravity", "brain"),
    ...windowsAntigravityFallbackRoots(options),
    ...parseAdditionalRoots(env.MEMORY_ROUTER_ANTIGRAVITY_LOG_DIRS),
  ]);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasFsErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isIgnorableOptionalFileError(error: unknown): boolean {
  return hasFsErrorCode(error, "ENOENT") || hasFsErrorCode(error, "ENOTDIR");
}

export function normalizeIngestCursor(raw: unknown): IngestCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const normalized: IngestCursor = {};
  for (const [filePath, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const offset = Number((value as IngestFileCursor).offset);
    const mtimeMs = Number((value as IngestFileCursor).mtimeMs);
    normalized[filePath] = {
      offset: Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0,
      mtimeMs: Number.isFinite(mtimeMs) && mtimeMs >= 0 ? Math.floor(mtimeMs) : 0,
    };
  }

  return normalized;
}

async function readTextDelta(filePath: string, startOffset: number): Promise<string> {
  if (startOffset <= 0) {
    return fs.readFile(filePath, "utf-8");
  }

  return await new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const stream = createReadStream(filePath, { start: startOffset, encoding: "utf-8" });
    stream.on("data", (chunk) => chunks.push(String(chunk)));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", reject);
  });
}

async function listJsonlFilesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isIgnorableOptionalFileError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function emptyIngestResult(cursor: IngestCursor, options?: { skipped?: boolean }): IngestResult {
  return {
    ok: true,
    errors: [],
    warnings: [],
    messages: [],
    cursor,
    maxObservedMtimeMs: 0,
    checkedFiles: 0,
    skipped: options?.skipped,
  };
}

const ANTIGRAVITY_PREFERRED_LOG_FILES = ["transcript.jsonl"] as const;

async function listAntigravitySessionLogFiles(
  logsDir: string,
  warnings: string[],
): Promise<string[]> {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (isIgnorableOptionalFileError(error)) return [];
    throw error;
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  // overview.txt を検出したら自動削除
  if (files.includes("overview.txt")) {
    const overviewPath = path.join(logsDir, "overview.txt");
    try {
      await fs.rm(overviewPath, { force: true });
    } catch (e) {
      warnings.push(`Failed to delete legacy overview.txt: ${toErrorMessage(e)}`);
    }
  }

  for (const preferredFile of ANTIGRAVITY_PREFERRED_LOG_FILES) {
    if (files.includes(preferredFile)) {
      return [path.join(logsDir, preferredFile)];
    }
  }

  return files
    .filter(
      (name) =>
        /\.(jsonl|txt)$/i.test(name) && /(transcript|overview|history|conversation)/i.test(name),
    )
    .sort()
    .map((name) => path.join(logsDir, name));
}

async function cleanUpLegacyFiles(root: string, warnings: string[]): Promise<void> {
  const possibleHistoryPaths = [
    path.join(root, "history.jsonl"),
    path.join(path.dirname(root), "history.jsonl"),
    path.join(path.dirname(root), "antigravity-cli", "history.jsonl"),
  ];

  for (const historyPath of possibleHistoryPaths) {
    try {
      const stat = await fs.stat(historyPath);
      if (stat.isFile()) {
        await fs.rm(historyPath, { force: true });
      }
    } catch {}
  }
}

export async function ingestCodexLogsFromRoots(
  roots: string[],
  since?: Date,
  cursor: IngestCursor = {},
  initialLookbackHours = groupedConfig.agentLogSync.initialLookbackHours,
): Promise<IngestResult> {
  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  const nextCursor = { ...normalizeIngestCursor(cursor) };
  let maxObservedMtimeMs = since ? since.getTime() : 0;
  let checkedFiles = 0;

  for (const root of roots.filter((dir) => dir.trim().length > 0)) {
    let files: string[] = [];
    try {
      files = await listJsonlFilesRecursively(root);
    } catch (error) {
      warnings.push(`Codex root ingest failed (${root}): ${toErrorMessage(error)}`);
      continue;
    }

    const threshold = since
      ? since.getTime()
      : Number.isFinite(initialLookbackHours) && initialLookbackHours > 0
        ? Date.now() - initialLookbackHours * 60 * 60 * 1000
        : 0;

    for (const filePath of files) {
      checkedFiles += 1;
      try {
        const stat = await fs.stat(filePath);
        maxObservedMtimeMs = Math.max(maxObservedMtimeMs, stat.mtimeMs);
        const prev = nextCursor[filePath];

        if (!prev && stat.mtimeMs < threshold) {
          nextCursor[filePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        let startOffset = prev?.offset ?? 0;
        if (startOffset > stat.size) {
          startOffset = 0;
        }
        if (startOffset === stat.size) {
          nextCursor[filePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        const content = await readTextDelta(filePath, startOffset);
        const context = startOffset > 0 ? await readCodexFileContext(filePath) : undefined;
        const delta = processCodexJsonlDelta(filePath, content, startOffset, context);
        messages.push(...delta.messages);
        nextCursor[filePath] = { offset: delta.nextOffset, mtimeMs: stat.mtimeMs };
      } catch (error) {
        warnings.push(`Codex file ingest failed (${filePath}): ${toErrorMessage(error)}`);
      }
    }
  }

  return {
    ok: true,
    errors: [],
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
    checkedFiles,
  };
}

export async function ingestCodexLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const roots = buildCodexIngestRoots();
  if (roots.length === 0)
    return emptyIngestResult(normalizeIngestCursor(cursor), { skipped: true });
  return ingestCodexLogsFromRoots(roots, since, cursor);
}

export async function ingestAntigravityLogsFromRoot(
  root: string,
  since?: Date,
  cursor: IngestCursor = {},
  initialLookbackHours = 24,
): Promise<IngestResult> {
  const normalizedCursor = normalizeIngestCursor(cursor);
  if (!root.trim()) return emptyIngestResult(normalizedCursor, { skipped: true });

  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  const nextCursor = { ...normalizedCursor };
  let maxObservedMtimeMs = since ? since.getTime() : 0;
  let checkedFiles = 0;

  // ディスク上のレガシーファイルをクリーンアップ
  await cleanUpLegacyFiles(root, warnings);

  let sessions: string[] = [];
  try {
    sessions = await fs.readdir(root);
  } catch (error) {
    if (isIgnorableOptionalFileError(error)) {
      return { ...emptyIngestResult(nextCursor, { skipped: true }), warnings: [] };
    }
    return {
      ok: false,
      errors: [`Antigravity logs root ingest failed (${root}): ${toErrorMessage(error)}`],
      warnings,
      messages,
      cursor: nextCursor,
      maxObservedMtimeMs,
      checkedFiles,
    };
  }

  const threshold = since
    ? since.getTime()
    : Date.now() - Math.max(0, initialLookbackHours) * 60 * 60 * 1000;

  for (const session of sessions) {
    const logsDir = path.join(root, session, ".system_generated", "logs");
    let logPaths: string[] = [];
    try {
      logPaths = await listAntigravitySessionLogFiles(logsDir, warnings);
    } catch (error) {
      warnings.push(`Antigravity logs scan failed (${logsDir}): ${toErrorMessage(error)}`);
      continue;
    }

    for (const logPath of logPaths) {
      try {
        const stat = await fs.stat(logPath);
        checkedFiles += 1;
        maxObservedMtimeMs = Math.max(maxObservedMtimeMs, stat.mtimeMs);
        const prev = nextCursor[logPath];

        if (!prev && stat.mtimeMs < threshold) {
          nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        let startOffset = prev?.offset ?? 0;
        if (startOffset > stat.size) {
          startOffset = 0;
        }
        if (startOffset === stat.size) {
          nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        const content = await readTextDelta(logPath, startOffset);
        if (content.trim()) {
          const parsedMessages = await parseAntigravityOverviewMessages(content, logPath, session);
          if (parsedMessages.length > 0) {
            messages.push(...parsedMessages);
          }
        }
        nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (isIgnorableOptionalFileError(error)) continue;
        warnings.push(`Antigravity file ingest failed (${logPath}): ${toErrorMessage(error)}`);
      }
    }
  }

  return {
    ok: true,
    errors: [],
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
    checkedFiles,
  };
}

export async function ingestAntigravityLogsFromRoots(
  roots: string[],
  since?: Date,
  cursor: IngestCursor = {},
  initialLookbackHours = groupedConfig.antigravity.initialLookbackHours,
): Promise<IngestResult> {
  const normalizedCursor = normalizeIngestCursor(cursor);
  const uniqueRoots = [...new Set(roots.filter((dir) => dir.trim().length > 0))];
  if (uniqueRoots.length === 0) return emptyIngestResult(normalizedCursor, { skipped: true });

  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let checkedFiles = 0;
  let maxObservedMtimeMs = since ? since.getTime() : 0;
  let nextCursor = { ...normalizedCursor };
  let ok = true;

  for (const root of uniqueRoots) {
    const result = await ingestAntigravityLogsFromRoot(
      root,
      since,
      nextCursor,
      initialLookbackHours,
    );
    ok = ok && result.ok;
    messages.push(...result.messages);
    warnings.push(...result.warnings);
    errors.push(...result.errors);
    checkedFiles += result.checkedFiles;
    maxObservedMtimeMs = Math.max(maxObservedMtimeMs, result.maxObservedMtimeMs);
    nextCursor = result.cursor;
  }

  return {
    ok,
    errors,
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
    checkedFiles,
  };
}

export async function ingestAntigravityLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const roots = buildAntigravityIngestRoots();

  return ingestAntigravityLogsFromRoots(
    roots,
    since,
    cursor,
    groupedConfig.antigravity.initialLookbackHours,
  );
}

export function decodeClaudeProjectPath(encoded: string): {
  projectName: string;
  projectRoot: string;
} {
  const normalized = encoded.startsWith("-") ? encoded : `-${encoded}`;
  const decoded = normalized.replace(/-/g, "/");
  const parts = decoded.split("/");
  const projectName = parts[parts.length - 1] || "Unknown";
  return { projectName, projectRoot: decoded };
}

export function buildClaudeIngestRoots(options?: RootBuildOptions): string[] {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const claudeProjectsDir = path.join(homeDir, ".claude", "projects");

  return uniqueNonEmptyPaths([
    claudeProjectsDir,
    ...parseAdditionalRoots(env.MEMORY_ROUTER_CLAUDE_LOG_DIRS),
  ]);
}

export async function ingestClaudeLogsFromRoot(
  root: string,
  since?: Date,
  cursor: IngestCursor = {},
  initialLookbackHours = 24,
): Promise<IngestResult> {
  const normalizedCursor = normalizeIngestCursor(cursor);
  if (!root.trim()) return emptyIngestResult(normalizedCursor, { skipped: true });

  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  const nextCursor = { ...normalizedCursor };
  let maxObservedMtimeMs = since ? since.getTime() : 0;
  let checkedFiles = 0;

  let projectDirs: string[] = [];
  try {
    projectDirs = await fs.readdir(root);
  } catch (error) {
    if (isIgnorableOptionalFileError(error)) {
      return { ...emptyIngestResult(nextCursor, { skipped: true }), warnings: [] };
    }
    return {
      ok: false,
      errors: [`Claude logs root ingest failed (${root}): ${toErrorMessage(error)}`],
      warnings,
      messages,
      cursor: nextCursor,
      maxObservedMtimeMs,
      checkedFiles,
    };
  }

  const threshold = since
    ? since.getTime()
    : Date.now() - Math.max(0, initialLookbackHours) * 60 * 60 * 1000;

  for (const projectDir of projectDirs) {
    const projectPath = path.join(root, projectDir);
    let statProject: Awaited<ReturnType<typeof fs.stat>>;
    try {
      statProject = await fs.stat(projectPath);
      if (!statProject.isDirectory()) continue;
    } catch {
      continue;
    }

    const { projectName, projectRoot } = decodeClaudeProjectPath(projectDir);

    let sessionFiles: string[] = [];
    try {
      sessionFiles = await fs.readdir(projectPath);
    } catch (error) {
      warnings.push(`Claude logs scan failed (${projectPath}): ${toErrorMessage(error)}`);
      continue;
    }

    const jsonlFiles = sessionFiles
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(projectPath, name));

    for (const filePath of jsonlFiles) {
      try {
        const stat = await fs.stat(filePath);
        checkedFiles += 1;
        maxObservedMtimeMs = Math.max(maxObservedMtimeMs, stat.mtimeMs);
        const prev = nextCursor[filePath];

        if (!prev && stat.mtimeMs < threshold) {
          nextCursor[filePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        let startOffset = prev?.offset ?? 0;
        if (startOffset > stat.size) {
          startOffset = 0;
        }
        if (startOffset === stat.size) {
          nextCursor[filePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
          continue;
        }

        const content = await readTextDelta(filePath, startOffset);
        if (content.trim()) {
          const session = sessionIdFromFile(filePath);
          const parsedMessages = parseClaudeSessionLog(content, filePath, session);
          for (const msg of parsedMessages) {
            msg.metadata.projectName = projectName;
            msg.metadata.projectRoot = projectRoot;
            messages.push(msg);
          }
        }
        nextCursor[filePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (isIgnorableOptionalFileError(error)) continue;
        warnings.push(`Claude file ingest failed (${filePath}): ${toErrorMessage(error)}`);
      }
    }
  }

  return {
    ok: true,
    errors: [],
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
    checkedFiles,
  };
}

export async function ingestClaudeLogsFromRoots(
  roots: string[],
  since?: Date,
  cursor: IngestCursor = {},
  initialLookbackHours = 24,
): Promise<IngestResult> {
  const normalizedCursor = normalizeIngestCursor(cursor);
  const uniqueRoots = [...new Set(roots.filter((dir) => dir.trim().length > 0))];
  if (uniqueRoots.length === 0) return emptyIngestResult(normalizedCursor, { skipped: true });

  const messages: ChatMessage[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let checkedFiles = 0;
  let maxObservedMtimeMs = since ? since.getTime() : 0;
  let nextCursor = { ...normalizedCursor };
  let ok = true;

  for (const root of uniqueRoots) {
    const result = await ingestClaudeLogsFromRoot(root, since, nextCursor, initialLookbackHours);
    ok = ok && result.ok;
    messages.push(...result.messages);
    warnings.push(...result.warnings);
    errors.push(...result.errors);
    checkedFiles += result.checkedFiles;
    maxObservedMtimeMs = Math.max(maxObservedMtimeMs, result.maxObservedMtimeMs);
    nextCursor = result.cursor;
  }

  return {
    ok,
    errors,
    warnings,
    messages,
    cursor: nextCursor,
    maxObservedMtimeMs,
    checkedFiles,
  };
}

export async function ingestClaudeLogs(
  since?: Date,
  cursor: IngestCursor = {},
): Promise<IngestResult> {
  const roots = buildClaudeIngestRoots();
  return ingestClaudeLogsFromRoots(
    roots,
    since,
    cursor,
    groupedConfig.antigravity.initialLookbackHours,
  );
}
