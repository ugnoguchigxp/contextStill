import { filterSensitiveData } from "./log-filter.js";
import { deriveProjectContextFromValues } from "./project-analyzer.js";

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
};

export function sessionIdFromFile(filePath: string): string {
  const base = filePath.replace(/\.jsonl$/i, "");
  const parts = base.split(/[\/\\]/);
  return parts[parts.length - 1] || "default";
}

function parseClaudeToolCall(toolUse: Record<string, unknown>): ToolCallSummary {
  const name = typeof toolUse.name === "string" ? toolUse.name : "tool";
  const input =
    toolUse.input && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};

  const targetFile =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.filePath === "string"
        ? input.filePath
        : undefined;

  const contentPreview =
    typeof input.content === "string"
      ? input.content
      : typeof input.replacement === "string"
        ? input.replacement
        : undefined;

  const commandLine = typeof input.command === "string" ? input.command : undefined;

  return {
    name,
    summary: name,
    commandLine,
    targetFile,
    contentPreview,
  };
}

export function parseClaudeLogLine(
  line: string,
  logPath: string,
  sessionId: string,
): ChatMessage | null {
  try {
    const data = JSON.parse(line.trim()) as {
      type?: unknown;
      message?: unknown;
      timestamp?: unknown;
      sessionId?: unknown;
    };

    const type = typeof data.type === "string" ? data.type : "";
    if (type !== "user" && type !== "assistant") return null;

    const message =
      data.message && typeof data.message === "object"
        ? (data.message as Record<string, unknown>)
        : null;
    if (!message) return null;

    const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;
    const resolvedSessionId = typeof data.sessionId === "string" ? data.sessionId : sessionId;

    if (type === "user") {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      if (!content) return null;

      const projectContext = deriveProjectContextFromValues([content]);
      return {
        role: "user",
        content: filterSensitiveData(content),
        metadata: {
          source: "Claude",
          sourceId: "claude_logs",
          sessionId: resolvedSessionId,
          sessionFile: logPath,
          timestamp,
          ...projectContext,
        },
      };
    }

    if (type === "assistant") {
      let textContent = "";
      const toolCalls: ToolCallSummary[] = [];

      const content = message.content;
      if (typeof content === "string") {
        textContent = content;
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") {
            textContent += (textContent ? "\n" : "") + record.text;
          } else if (record.type === "tool_use") {
            toolCalls.push(parseClaudeToolCall(record));
          }
        }
      }

      const strippedText = textContent.trim();
      const toolCallsExist = toolCalls.length > 0;

      if (strippedText || toolCallsExist) {
        const projectContext = deriveProjectContextFromValues([
          strippedText,
          ...toolCalls.flatMap((toolCall) => [
            toolCall.cwd,
            toolCall.targetFile,
            toolCall.contentPreview,
          ]),
        ]);

        const finalContent = strippedText
          ? strippedText
          : toolCalls
              .map((tc) => `${tc.name}${tc.targetFile ? ` - file: ${tc.targetFile}` : ""}`)
              .join("\n");

        return {
          role: "assistant",
          content: filterSensitiveData(finalContent),
          metadata: {
            source: "Claude",
            sourceId: "claude_logs",
            sessionId: resolvedSessionId,
            sessionFile: logPath,
            timestamp,
            ...projectContext,
            ...(toolCallsExist ? { toolCalls } : {}),
            messageKind: strippedText ? "chat" : "tool_call",
          },
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function parseClaudeSessionLog(
  content: string,
  logPath: string,
  sessionId: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseClaudeLogLine(line, logPath, sessionId);
    if (parsed) {
      messages.push(parsed);
    }
  }
  return messages;
}
