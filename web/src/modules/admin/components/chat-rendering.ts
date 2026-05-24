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
    if (cleaned)
      turns.push({
        ...current,
        content: cleaned,
        isMetadata: metadata || undefined,
      });
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
        thinking?: unknown;
        tool_calls?: unknown;
      };

      const source = typeof data.source === "string" ? data.source : "";
      const recordType = typeof data.type === "string" ? data.type : "";

      // 1. ユーザー入力の処理
      if (source === "USER_EXPLICIT" && recordType === "USER_INPUT") {
        if (typeof data.content === "string") {
          const text = cleanNaturalText(data.content);
          if (text) {
            const metadata = isMetadataContent(data.content) || undefined;
            turns.push({ role: "user", content: text, isMetadata: metadata });
          }
        }
        continue;
      }

      // 2. アシスタント返答 (PLANNER_RESPONSE) の処理 (2.0仕様)
      if (source === "MODEL" && recordType === "PLANNER_RESPONSE") {
        const textContent =
          typeof data.thinking === "string"
            ? data.thinking
            : typeof data.content === "string"
              ? data.content
              : "";

        const text = cleanNaturalText(textContent);
        if (text) {
          const metadata = isMetadataContent(textContent) || undefined;
          turns.push({ role: "assistant", content: text, isMetadata: metadata });
        }
      }
    } catch {}
  }
  return turns;
}

/**
 * environment_context や GEMINI.md 等のメタデータブロックを含むかどうか判定する。
 * 完全に除去するのではなく、isMetadata フラグで UI 側がアコーディオン非表示できるようにする。
 */
function isMetadataContent(content: string): boolean {
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
    // markdown-wysiwyg-editor のパースバグ回避:
    // **`code`** のようにネストされた場合にプレースホルダー §CODE§ が残る問題を防ぐため
    // バッククォートの周囲にスペースを挿入してパースを補助する
    .replace(/(\*\*|[*~_])`([^`]+)`(\*\*|[*~_])/g, "$1 `$2` $3")
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
