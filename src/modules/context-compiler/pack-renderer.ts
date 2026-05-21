import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";

export function renderContextPackMarkdown(pack: ContextPack): string {
  const lines: string[] = [];

  const appendKnowledgeSection = (title: string, items: ContextPack["rules"]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    lines.push("");
    for (const item of items) {
      lines.push(`### ${item.title}`);
      lines.push(item.content.trim());
      lines.push("");
    }
  };

  appendKnowledgeSection("Rules", pack.rules);
  appendKnowledgeSection("Procedures", pack.procedures);

  if (lines.length === 0) {
    lines.push("該当する knowledge はありません。通常の実装判断で進めてください。");
  }

  if (pack.warnings.length > 0) {
    lines.push("");
    lines.push("## Context Quality");
    lines.push("");
    for (const warning of pack.warnings.slice(0, 3)) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n").trim();
}
