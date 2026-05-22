import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";

export function renderContextPackMarkdown(pack: ContextPack): string {
  if (pack.status === "failed" || (pack.rules.length === 0 && pack.procedures.length === 0)) {
    return "No Content";
  }

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

  return lines.join("\n").trim();
}
