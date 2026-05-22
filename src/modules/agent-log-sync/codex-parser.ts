import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type ChatMessage, sessionIdFromFile } from "./antigravity-parser.js";
import { filterSensitiveData } from "./log-filter.js";
import { type ProjectContext, deriveProjectFromPath } from "./project-analyzer.js";

type CodexTextPart = {
  type?: string;
  text?: string;
};

export type CodexFileContext = ProjectContext & {
  sessionId?: string;
};

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
      role: payload.role as "user" | "assistant",
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

export async function readCodexFileContext(filePath: string): Promise<CodexFileContext> {
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
