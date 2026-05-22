import fs from "node:fs/promises";
import path from "node:path";
import { filterSensitiveData } from "./log-filter.js";
import {
  decodeFileUrl,
  deriveProjectContextFromValues,
  deriveProjectFromPath,
} from "./project-analyzer.js";

type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown>;
};

export type IngestFileCursor = {
  offset: number;
  mtimeMs: number;
};

export type IngestCursor = Record<string, IngestFileCursor>;

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

export function sessionIdFromFile(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/i, "");
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

function stripAntigravityMetadata(content: string): string {
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/<\/?[A-Z_]+>/g, "")
    .trim();
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

export async function parseAntigravityOverviewMessages(
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

export function parseAntigravityCliHistoryLine(
  line: string,
  historyFilePath: string,
): ChatMessage | null {
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
