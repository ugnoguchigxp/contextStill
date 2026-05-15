export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
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

  const flush = () => {
    if (!current) return;
    const cleaned = cleanNaturalText(current.content);
    if (cleaned) turns.push({ ...current, content: cleaned });
    current = null;
  };

  for (const line of content.split("\n")) {
    const match = line.match(/^(USER|ASSISTANT|SYSTEM):\s*(.*)$/);
    if (match) {
      flush();
      current = {
        role: match[1].toLowerCase() as ChatTurn["role"],
        content: match[2] ?? "",
      };
      continue;
    }
    if (current) {
      current.content += `${current.content ? "\n" : ""}${line}`;
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
      const text = cleanNaturalText(data.content);
      if (!text) continue;
      const role =
        data.source === "USER_EXPLICIT" || data.type === "USER_INPUT" ? "user" : "assistant";
      turns.push({ role, content: text });
    } catch {}
  }
  return turns;
}

function cleanNaturalText(content: string): string {
  const userRequest = extractTaggedContent(content, "USER_REQUEST");
  const base = userRequest ?? content;
  const cleaned = base
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
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
