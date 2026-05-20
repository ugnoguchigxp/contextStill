export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  /** 環境コンテキストや設定ファイルなどのメタデータターンかどうか */
  isMetadata?: boolean;
};

const roleLabels: Record<ChatTurn["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
};

export function getChatRoleLabel(role: ChatTurn["role"]): string {
  return roleLabels[role];
}

export function parseVibeMemoryTurns(content: string): ChatTurn[] {
  const trimmed = content.trim();
  if (!trimmed || trimmed === "Agent diff recorded." || trimmed === "Tool usage recorded.")
    return [];

  const jsonTurns = parseJsonOverviewTurns(trimmed);
  if (jsonTurns.length > 0) return jsonTurns;

  const turns = parseRolePrefixedTurns(trimmed);
  if (turns.length > 0) return turns;

  const cleaned = cleanNaturalText(trimmed);
  return cleaned ? [{ role: "assistant", content: cleaned }] : [];
}

function parseRolePrefixedTurns(content: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;
  let currentRaw = "";

  const flush = () => {
    if (!current) return;
    const metadata = isMetadataContent(currentRaw);
    const cleaned = cleanNaturalText(current.content);
    if (cleaned) turns.push({ ...current, content: cleaned, isMetadata: metadata || undefined });
    current = null;
    currentRaw = "";
  };

  for (const line of content.split("\n")) {
    const match = line.match(/^(USER|ASSISTANT|SYSTEM):\s*(.*)$/);
    if (match) {
      flush();
      const initialContent = match[2] ?? "";
      current = {
        role: match[1].toLowerCase() as ChatTurn["role"],
        content: initialContent,
      };
      currentRaw = initialContent;
      continue;
    }
    if (current) {
      current.content += `${current.content ? "\n" : ""}${line}`;
      currentRaw += `${currentRaw ? "\n" : ""}${line}`;
    }
  }

  flush();
  return turns;
}

function parseJsonOverviewTurns(content: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const line of content.split("\n")) {
    const jsonText = line.replace(/^(USER|ASSISTANT|SYSTEM):\s*/, "").trim();
    if (!jsonText.startsWith("{")) continue;

    try {
      const data = JSON.parse(jsonText) as {
        source?: unknown;
        type?: unknown;
        content?: unknown;
        tool_calls?: unknown;
      };
      if (typeof data.content !== "string") continue;
      const rawContent = data.content;
      const text = cleanNaturalText(rawContent);
      if (!text) continue;
      const role =
        data.source === "USER_EXPLICIT" || data.type === "USER_INPUT" ? "user" : "assistant";
      const metadata = isMetadataContent(rawContent) || undefined;
      turns.push({ role, content: text, isMetadata: metadata });
    } catch {}
  }
  return turns;
}

/**
 * environment_context や GEMINI.md 等のメタデータブロックを含むかどうか判定する。
 * 完全に除去するのではなく、isMetadata フラグで UI 側がアコーディオン非表示できるようにする。
 */
export function isMetadataContent(content: string): boolean {
  const trimmed = content.trim();
  // <environment_context> ブロックが含まれる場合
  if (/<environment_context[\s>]/i.test(trimmed)) return true;
  // GEMINI.md / AGENT.md / .cursorrules / system prompt 等の設定ファイルコンテンツが主体の場合
  // これらはコードブロックや長い設定テキストで始まる傾向がある
  if (/^```(markdown|md)?\n#\s+(GEMINI|AGENT|CLAUDE|CURSOR)/im.test(trimmed)) return true;
  // 環境情報タグのみで構成されている場合
  if (/^<environment_context>[\s\S]*?<\/environment_context>\s*$/i.test(trimmed)) return true;
  return false;
}

function cleanNaturalText(content: string): string {
  const userRequest = extractTaggedContent(content, "USER_REQUEST");
  const base = userRequest ?? content;
  const cleaned = base
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    // environment_context はメタデータとして除去（isMetadata フラグで UI 側が Accordion 表示する）
    .replace(/<environment_context[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<\/?[A-Z_]+>/g, "")
    .trim();

  if (!cleaned) return "";
  if (cleaned.startsWith("The USER performed the following action:")) return "";
  if (cleaned.includes("\nFile Path: `file://")) return "";
  if (cleaned.startsWith("Chunk ID:") && cleaned.includes("\nOutput:\n")) return "";
  if (cleaned.startsWith("*** Begin Patch")) return "";
  if (cleaned.startsWith("diff --git ")) return "";
  if (cleaned.startsWith("{") && cleaned.includes('"tool_calls"')) return "";
  return cleaned;
}

function extractTaggedContent(content: string, tagName: string): string | null {
  const match = content.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i"));
  return match?.[1]?.trim() ?? null;
}
