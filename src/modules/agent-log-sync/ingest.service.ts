import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groupedConfig } from "../../config.js";

type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown>;
};

type ToolCallSummary = {
  name: string;
  summary?: string;
  commandLine?: string;
  cwd?: string;
  action?: string;
  targetFile?: string;
  contentPreview?: string;
  sourceTruncated?: boolean;
  reconstructedFromFile?: boolean;
};

type IngestFileCursor = {
  offset: number;
  mtimeMs: number;
};

export type IngestCursor = Record<string, IngestFileCursor>;

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

type CodexTextPart = {
  type?: string;
  text?: string;
};

type ProjectContext = {
  cwd?: string;
  projectRoot?: string;
  projectName?: string;
  sessionStartedAt?: string;
};

type CodexFileContext = ProjectContext & {
  sessionId?: string;
};

const SECRET_PATTERNS: RegExp[] = [
  /export\s+[A-Z_]*PASSWORD=.*$/gim,
  /export\s+[A-Z_]*TOKEN=.*$/gim,
  /export\s+[A-Z_]*KEY=.*$/gim,
  /password\s*[:=]\s*\S+/gi,
  /secret[_-]?key\s*[:=]\s*\S+/gi,
  /auth[_-]?token\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /bearer\s+[a-z0-9\-_.]+/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /xox[baprs]-\S+/gm,
  /ghp_\S+/gm,
  /ghs_\S+/gm,
  /([a-zA-Z0-9]{48,})/g,
];

const SECRET_LINE_KEYWORDS = ["password", "secret_key", "auth_token"];

function filterSensitiveData(text: string): string {
  let filtered = text;
  for (const pattern of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, "[REMOVED SENSITIVE DATA]");
  }

  return filtered
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase();
      return !SECRET_LINE_KEYWORDS.some((keyword) => lower.includes(keyword));
    })
    .join("\n");
}

function extractCodexTextContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";

  return raw
    .filter(
      (part): part is CodexTextPart =>
        part !== null &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string" &&
        ["input_text", "output_text", "text", "summary_text"].includes(
          String((part as { type?: unknown }).type ?? "text"),
        ),
    )
    .map((part) => part.text ?? "")
    .join("\n");
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

function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/i, "");
}

function deriveProjectFromPath(rawPath: string | undefined): ProjectContext {
  if (!rawPath) return {};
  const decodedPath = rawPath.startsWith("file://") ? decodeFileUrl(rawPath) : rawPath;
  const normalizedPath = decodedPath?.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!normalizedPath) return {};

  const parts = normalizedPath.split(path.sep).filter(Boolean);
  const codeIndex = parts.lastIndexOf("Code");
  if (codeIndex >= 0 && parts[codeIndex + 1]) {
    const projectRoot = `${path.sep}${parts.slice(0, codeIndex + 2).join(path.sep)}`;
    return {
      projectRoot,
      projectName: parts[codeIndex + 1],
    };
  }

  if (path.isAbsolute(normalizedPath)) {
    return {
      projectRoot: normalizedPath,
      projectName: path.basename(normalizedPath),
    };
  }

  return {};
}

function extractPathCandidates(text: string | undefined): string[] {
  if (!text) return [];
  const candidates = new Set<string>();
  for (const match of text.matchAll(/file:\/\/[^\s`"'<>),]+/g)) {
    if (match[0]) candidates.add(match[0]);
  }
  for (const match of text.matchAll(/\/Users\/[^\s`"'<>),]+\/Code\/[^\s`"'<>),]+/g)) {
    if (match[0]) candidates.add(match[0]);
  }
  return [...candidates];
}

function deriveProjectContextFromValues(values: Array<string | undefined>): ProjectContext {
  for (const value of values) {
    for (const candidate of extractPathCandidates(value)) {
      const context = deriveProjectFromPath(candidate);
      if (context.projectName) return context;
    }

    const context = deriveProjectFromPath(value);
    if (context.projectName) return context;
  }

  return {};
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function stripAntigravityMetadata(content: string): string {
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/<\/?[A-Z_]+>/g, "")
    .trim();
}

function normalizeToolValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed.trim();
  } catch {}
  return trimmed.replace(/^"+|"+$/g, "");
}

function hasTruncationMarker(content: string): boolean {
  return /<truncated \d+ (?:bytes|chars)>/i.test(content);
}

function summarizeAntigravityToolCalls(toolCalls: unknown): ToolCallSummary[] {
  if (!Array.isArray(toolCalls)) return [];

  const summaries: ToolCallSummary[] = [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) continue;
    const record = toolCall as Record<string, unknown>;
    const args =
      record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? (record.args as Record<string, unknown>)
        : {};
    const contentPreview =
      normalizeToolValue(args.CodeContent) ??
      normalizeToolValue(args.ReplacementContent) ??
      normalizeToolValue(args.ReplacementChunks) ??
      normalizeToolValue(args.TargetContent);
    const targetFile = normalizeToolValue(args.TargetFile);
    const description =
      normalizeToolValue(args.Description) ?? normalizeToolValue(args.Instruction);
    summaries.push({
      name: normalizeToolValue(record.name) ?? "tool",
      summary: normalizeToolValue(args.toolSummary) ?? description,
      commandLine: normalizeToolValue(args.CommandLine),
      cwd: normalizeToolValue(args.Cwd),
      action: normalizeToolValue(args.toolAction),
      targetFile,
      contentPreview,
      sourceTruncated: contentPreview ? hasTruncationMarker(contentPreview) : undefined,
    });
  }

  return summaries;
}

function formatToolCallSummary(toolCall: ToolCallSummary): string {
  const details = [
    toolCall.summary,
    toolCall.commandLine ? `$ ${toolCall.commandLine}` : undefined,
    toolCall.cwd ? `cwd: ${toolCall.cwd}` : undefined,
    toolCall.targetFile ? `file: ${toolCall.targetFile}` : undefined,
  ].filter(Boolean);
  return `${toolCall.name}${details.length > 0 ? ` - ${details.join(" | ")}` : ""}`;
}

type FileViewAction = {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
};

function parseAntigravityFileViewAction(content: string): FileViewAction | null {
  const fileUrlMatch = content.match(/File Path:\s*`(file:\/\/[^`]+)`/);
  const shownPathMatch = content.match(/Show the contents of file (.+?)(?: from lines|\n)/);
  const filePath = fileUrlMatch
    ? decodeFileUrl(fileUrlMatch[1])
    : shownPathMatch?.[1]?.trim() || null;
  if (!filePath) return null;

  const lineRangeMatch =
    content.match(/from lines (\d+) to (\d+)/i) ?? content.match(/Showing lines (\d+) to (\d+)/i);
  const singleLineMatch = content.match(/from lines (\d+) to \1/i);

  return {
    filePath,
    startLine: lineRangeMatch
      ? Number(lineRangeMatch[1])
      : singleLineMatch
        ? Number(singleLineMatch[1])
        : null,
    endLine: lineRangeMatch
      ? Number(lineRangeMatch[2])
      : singleLineMatch
        ? Number(singleLineMatch[1])
        : null,
  };
}

function decodeFileUrl(fileUrl: string): string | null {
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return fileUrl.replace(/^file:\/\//, "");
  }
}

async function reconstructFileViewContent(action: FileViewAction): Promise<string | null> {
  if (!action.startLine || !action.endLine) return null;

  try {
    const content = await fs.readFile(action.filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, action.startLine);
    const endLine = Math.min(Math.max(startLine, action.endLine), lines.length);
    return lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}: ${line}`)
      .join("\n");
  } catch {
    return null;
  }
}

async function summarizeAntigravityUserAction(
  recordType: string,
  content: string,
): Promise<ToolCallSummary> {
  const fileViewAction = parseAntigravityFileViewAction(content);
  if (fileViewAction) {
    const reconstructedContent = await reconstructFileViewContent(fileViewAction);
    const range =
      fileViewAction.startLine && fileViewAction.endLine
        ? `lines ${fileViewAction.startLine}-${fileViewAction.endLine}`
        : "file content";
    return {
      name: recordType || "VIEW_FILE",
      summary: `Show ${range}`,
      action: recordType || undefined,
      targetFile: fileViewAction.filePath,
      contentPreview: reconstructedContent ?? content.trim(),
      sourceTruncated: hasTruncationMarker(content),
      reconstructedFromFile: Boolean(reconstructedContent),
    };
  }

  const summary =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && line !== "The USER performed the following action:") ??
    recordType.toLowerCase();

  return {
    name: recordType || "USER_ACTION",
    summary,
    action: recordType || undefined,
    contentPreview: content.trim(),
    sourceTruncated: hasTruncationMarker(content),
  };
}

function pushAntigravityToolMessage(params: {
  messages: ChatMessage[];
  toolCalls: ToolCallSummary[];
  logPath: string;
  sessionId: string;
  createdAt: unknown;
  stepIndex: unknown;
  recordType: string;
}): void {
  if (params.toolCalls.length === 0) return;
  const projectContext = deriveProjectContextFromValues(
    params.toolCalls.flatMap((toolCall) => [
      toolCall.cwd,
      toolCall.targetFile,
      toolCall.contentPreview,
    ]),
  );
  params.messages.push({
    role: "assistant",
    content: params.toolCalls.map(formatToolCallSummary).join("\n"),
    metadata: {
      source: "Antigravity",
      sourceId: "antigravity_logs",
      sessionId: params.sessionId,
      sessionFile: params.logPath,
      timestamp: typeof params.createdAt === "string" ? params.createdAt : undefined,
      stepIndex: params.stepIndex,
      recordType: params.recordType,
      ...projectContext,
      messageKind: "tool_call",
      toolCalls: params.toolCalls,
    },
  });
}

async function parseAntigravityOverviewMessages(
  content: string,
  logPath: string,
  sessionId: string,
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const data = JSON.parse(trimmed) as {
        step_index?: unknown;
        source?: unknown;
        type?: unknown;
        created_at?: unknown;
        content?: unknown;
        tool_calls?: unknown;
      };
      const toolCalls = summarizeAntigravityToolCalls(data.tool_calls);
      const source = typeof data.source === "string" ? data.source : "";
      const recordType = typeof data.type === "string" ? data.type : "";
      const isUserInput = source === "USER_EXPLICIT" && recordType === "USER_INPUT";
      const projectContext = deriveProjectContextFromValues([
        typeof data.content === "string" ? data.content : undefined,
        ...toolCalls.flatMap((toolCall) => [
          toolCall.cwd,
          toolCall.targetFile,
          toolCall.contentPreview,
        ]),
      ]);

      if (typeof data.content !== "string") {
        pushAntigravityToolMessage({
          messages,
          toolCalls,
          logPath,
          sessionId,
          createdAt: data.created_at,
          stepIndex: data.step_index,
          recordType,
        });
        continue;
      }

      if (source === "USER_EXPLICIT" && !isUserInput) {
        const userAction = await summarizeAntigravityUserAction(recordType, data.content);
        pushAntigravityToolMessage({
          messages,
          toolCalls: [userAction, ...toolCalls],
          logPath,
          sessionId,
          createdAt: data.created_at,
          stepIndex: data.step_index,
          recordType,
        });
        continue;
      }

      const userRequest = extractTaggedContent(data.content, "USER_REQUEST");
      const textContent = userRequest ? userRequest.trim() : stripAntigravityMetadata(data.content);
      if (!textContent.trim()) {
        pushAntigravityToolMessage({
          messages,
          toolCalls,
          logPath,
          sessionId,
          createdAt: data.created_at,
          stepIndex: data.step_index,
          recordType,
        });
        continue;
      }

      const role: ChatRole = isUserInput ? "user" : "assistant";

      messages.push({
        role,
        content: filterSensitiveData(textContent),
        metadata: {
          source: "Antigravity",
          sourceId: "antigravity_logs",
          sessionId,
          sessionFile: logPath,
          timestamp: typeof data.created_at === "string" ? data.created_at : undefined,
          stepIndex: data.step_index,
          recordType,
          ...projectContext,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
      });
    } catch {}
  }

  return messages;
}

function extractCwdFromEnvironmentContext(text: string): string | undefined {
  return text.match(/<cwd>([^<]+)<\/cwd>/)?.[1]?.trim();
}

function updateCodexFileContext(line: string, current: CodexFileContext): CodexFileContext {
  try {
    const data = JSON.parse(line) as {
      type?: unknown;
      payload?: {
        id?: unknown;
        timestamp?: unknown;
        cwd?: unknown;
        turn_id?: unknown;
      };
    };
    const payload = data.payload;
    if (!payload || typeof payload !== "object") return current;

    if (data.type === "session_meta") {
      const cwd = typeof payload.cwd === "string" ? payload.cwd : current.cwd;
      const projectContext = deriveProjectFromPath(cwd);
      return {
        ...current,
        sessionId: typeof payload.id === "string" ? payload.id : current.sessionId,
        cwd,
        sessionStartedAt:
          typeof payload.timestamp === "string" ? payload.timestamp : current.sessionStartedAt,
        ...projectContext,
      };
    }

    if (data.type === "turn_context" && typeof payload.cwd === "string") {
      const projectContext = deriveProjectFromPath(payload.cwd);
      return {
        ...current,
        cwd: payload.cwd,
        ...projectContext,
      };
    }
  } catch {}

  return current;
}

function buildCodexMessageMetadata(params: {
  filePath: string;
  timestamp: unknown;
  context: CodexFileContext;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const projectContext = deriveProjectFromPath(params.context.cwd);
  return {
    source: "Codex",
    sourceId: "codex_logs",
    sessionId: params.context.sessionId ?? sessionIdFromFile(params.filePath),
    sessionFile: params.filePath,
    timestamp: typeof params.timestamp === "string" ? params.timestamp : undefined,
    cwd: params.context.cwd,
    sessionStartedAt: params.context.sessionStartedAt,
    ...projectContext,
    ...params.context,
    ...params.extra,
  };
}

function parseCodexJsonLine(
  line: string,
  filePath: string,
  context: CodexFileContext = {},
): ChatMessage | null {
  try {
    const data = JSON.parse(line) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        content?: unknown;
        name?: unknown;
        input?: unknown;
        arguments?: unknown;
      };
    };
    if (data.type !== "response_item") return null;
    const payload = data.payload;
    if (!payload) return null;

    if (
      (payload.type === "custom_tool_call" || payload.type === "function_call") &&
      payload.name === "apply_patch"
    ) {
      const textContent =
        typeof payload.input === "string"
          ? payload.input
          : typeof payload.arguments === "string"
            ? payload.arguments
            : "";
      if (!textContent.trim()) return null;

      return {
        role: "assistant",
        content: filterSensitiveData(textContent),
        metadata: buildCodexMessageMetadata({
          filePath,
          timestamp: data.timestamp,
          context,
          extra: {
            messageKind: "tool_call",
            toolName: "apply_patch",
          },
        }),
      };
    }

    if (payload.type !== "message") return null;
    if (payload.role !== "user" && payload.role !== "assistant") return null;

    const textContent = extractCodexTextContent(payload.content);
    if (!textContent.trim()) return null;

    return {
      role: payload.role,
      content: filterSensitiveData(textContent),
      metadata: buildCodexMessageMetadata({
        filePath,
        timestamp: data.timestamp,
        context: {
          ...context,
          cwd: context.cwd ?? extractCwdFromEnvironmentContext(textContent),
        },
      }),
    };
  } catch {
    return null;
  }
}

export function processCodexJsonlDelta(
  filePath: string,
  content: string,
  startOffset: number,
  context: CodexFileContext = {},
): { messages: ChatMessage[]; nextOffset: number } {
  if (!content) return { messages: [], nextOffset: startOffset };

  const messages: ChatMessage[] = [];
  let codexContext: CodexFileContext = {
    sessionId: sessionIdFromFile(filePath),
    ...context,
  };
  const endsWithNewline = content.endsWith("\n");
  let completeSegment = content;
  let trailingSegment = "";

  if (!endsWithNewline) {
    const lastNewlineIndex = content.lastIndexOf("\n");
    if (lastNewlineIndex >= 0) {
      completeSegment = content.slice(0, lastNewlineIndex + 1);
      trailingSegment = content.slice(lastNewlineIndex + 1);
    } else {
      completeSegment = "";
      trailingSegment = content;
    }
  }

  if (completeSegment) {
    for (const line of completeSegment.split("\n").filter((entry) => entry.trim())) {
      codexContext = updateCodexFileContext(line, codexContext);
      const parsed = parseCodexJsonLine(line, filePath, codexContext);
      if (parsed) messages.push(parsed);
    }
  }

  let consumedBytes = Buffer.byteLength(completeSegment, "utf8");
  if (!endsWithNewline) {
    const trailingTrimmed = trailingSegment.trim();
    if (!trailingTrimmed) {
      consumedBytes += Buffer.byteLength(trailingSegment, "utf8");
    } else {
      codexContext = updateCodexFileContext(trailingSegment, codexContext);
      const parsedTrailing = parseCodexJsonLine(trailingSegment, filePath, codexContext);
      if (parsedTrailing) {
        messages.push(parsedTrailing);
        consumedBytes += Buffer.byteLength(trailingSegment, "utf8");
      }
    }
  }

  return { messages, nextOffset: startOffset + consumedBytes };
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

async function readCodexFileContext(filePath: string): Promise<CodexFileContext> {
  try {
    const prefix = await new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const stream = createReadStream(filePath, { start: 0, end: 262_143, encoding: "utf-8" });
      stream.on("data", (chunk) => chunks.push(String(chunk)));
      stream.on("end", () => resolve(chunks.join("")));
      stream.on("error", reject);
    });

    let context: CodexFileContext = { sessionId: sessionIdFromFile(filePath) };
    for (const line of prefix.split("\n").filter((entry) => entry.trim())) {
      context = updateCodexFileContext(line, context);
      if (context.cwd && context.sessionStartedAt) break;
    }
    return context;
  } catch {
    return { sessionId: sessionIdFromFile(filePath) };
  }
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

const ANTIGRAVITY_PREFERRED_LOG_FILES = ["transcript.jsonl", "overview.txt"] as const;

async function listAntigravitySessionLogFiles(logsDir: string): Promise<string[]> {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (isIgnorableOptionalFileError(error)) return [];
    throw error;
  }

  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
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

function parseAntigravityCliHistoryLine(line: string, historyFilePath: string): ChatMessage | null {
  try {
    const data = JSON.parse(line) as {
      display?: unknown;
      timestamp?: unknown;
      workspace?: unknown;
      conversationId?: unknown;
    };

    if (typeof data.display !== "string" || !data.display.trim()) return null;
    const workspace = typeof data.workspace === "string" ? data.workspace : undefined;
    const projectContext = deriveProjectFromPath(workspace);
    const timestampMs = Number(data.timestamp);
    const timestamp =
      Number.isFinite(timestampMs) && timestampMs > 0
        ? new Date(timestampMs).toISOString()
        : undefined;

    return {
      role: "user",
      content: filterSensitiveData(data.display.trim()),
      metadata: {
        source: "Antigravity",
        sourceId: "antigravity_logs",
        sessionId:
          typeof data.conversationId === "string" && data.conversationId.trim().length > 0
            ? data.conversationId.trim()
            : sessionIdFromFile(historyFilePath),
        sessionFile: historyFilePath,
        timestamp,
        cwd: workspace,
        ...projectContext,
      },
    };
  } catch {
    return null;
  }
}

async function ingestAntigravityCliHistoryFallback(params: {
  brainRoot: string;
  since?: Date;
  cursor: IngestCursor;
  warnings: string[];
  messages: ChatMessage[];
  maxObservedMtimeMs: number;
  checkedFiles: number;
}): Promise<{ maxObservedMtimeMs: number; checkedFiles: number }> {
  const cliRoot = path.dirname(params.brainRoot);
  if (path.basename(cliRoot) !== "antigravity-cli") {
    return {
      maxObservedMtimeMs: params.maxObservedMtimeMs,
      checkedFiles: params.checkedFiles,
    };
  }

  const historyFilePath = path.join(cliRoot, "history.jsonl");
  try {
    const stat = await fs.stat(historyFilePath);
    const nextMaxObservedMtimeMs = Math.max(params.maxObservedMtimeMs, stat.mtimeMs);
    const prev = params.cursor[historyFilePath];
    let startOffset = prev?.offset ?? 0;
    if (startOffset > stat.size) startOffset = 0;
    if (startOffset === stat.size) {
      params.cursor[historyFilePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
      return {
        maxObservedMtimeMs: nextMaxObservedMtimeMs,
        checkedFiles: params.checkedFiles + 1,
      };
    }

    const content = await readTextDelta(historyFilePath, startOffset);
    if (content.trim()) {
      for (const line of content.split("\n").filter((entry) => entry.trim())) {
        const parsed = parseAntigravityCliHistoryLine(line, historyFilePath);
        if (!parsed) continue;
        if (params.since) {
          const timestamp = parsed.metadata.timestamp;
          if (
            typeof timestamp === "string" &&
            new Date(timestamp).getTime() < params.since.getTime()
          ) {
            continue;
          }
        }
        params.messages.push(parsed);
      }
    }
    params.cursor[historyFilePath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
    return {
      maxObservedMtimeMs: nextMaxObservedMtimeMs,
      checkedFiles: params.checkedFiles + 1,
    };
  } catch (error) {
    if (!isIgnorableOptionalFileError(error)) {
      params.warnings.push(
        `Antigravity CLI history ingest failed (${historyFilePath}): ${toErrorMessage(error)}`,
      );
    }
    return {
      maxObservedMtimeMs: params.maxObservedMtimeMs,
      checkedFiles: params.checkedFiles,
    };
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
  const roots = [groupedConfig.codex.sessionDir, groupedConfig.codex.archivedSessionDir].filter(
    (dir) => dir.trim().length > 0,
  );
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
      logPaths = await listAntigravitySessionLogFiles(logsDir);
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
          } else {
            messages.push({
              role: "assistant",
              content: filterSensitiveData(content),
              metadata: {
                source: "Antigravity",
                sourceId: "antigravity_logs",
                sessionId: session,
                sessionFile: logPath,
              },
            });
          }
        }
        nextCursor[logPath] = { offset: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (isIgnorableOptionalFileError(error)) continue;
        warnings.push(`Antigravity file ingest failed (${logPath}): ${toErrorMessage(error)}`);
      }
    }
  }

  if (checkedFiles === 0) {
    const fallback = await ingestAntigravityCliHistoryFallback({
      brainRoot: root,
      since,
      cursor: nextCursor,
      warnings,
      messages,
      maxObservedMtimeMs,
      checkedFiles,
    });
    checkedFiles = fallback.checkedFiles;
    maxObservedMtimeMs = fallback.maxObservedMtimeMs;
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
  const homeGeminiDir = path.join(os.homedir(), ".gemini");
  const roots = [
    groupedConfig.antigravity.logDir,
    path.join(homeGeminiDir, "antigravity-cli", "brain"),
    path.join(homeGeminiDir, "antigravity-ide", "brain"),
    path.join(homeGeminiDir, "antigravity", "brain"),
  ];

  return ingestAntigravityLogsFromRoots(
    roots,
    since,
    cursor,
    groupedConfig.antigravity.initialLookbackHours,
  );
}
