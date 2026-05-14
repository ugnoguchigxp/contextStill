import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";

export function renderContextPackMarkdown(pack: ContextPack): string {
  const lines: string[] = [];
  lines.push("# Context Pack");
  lines.push("");
  lines.push(`- Goal: ${pack.goal}`);
  lines.push(`- Intent: ${pack.intent}`);
  lines.push(`- Retrieval Mode: ${pack.retrievalMode}`);
  lines.push(`- Status: ${pack.status}`);
  lines.push("");

  lines.push("## Minimal Tasks");
  lines.push("");
  for (const task of pack.minimalTasks) {
    lines.push(`- ${task}`);
  }
  lines.push("");

  const renderSection = (title: string, items: ContextPack["rules"]): void => {
    lines.push(`## ${title}`);
    lines.push("");
    if (items.length === 0) {
      lines.push("- none");
    } else {
      for (const item of items) {
        lines.push(`- ${item.title} (${item.rankingReason})`);
      }
    }
    lines.push("");
  };

  renderSection("Rules", pack.rules);
  renderSection("Skills", pack.skills);
  renderSection("Examples", pack.examples);
  renderSection("Code Context", pack.codeContext);

  lines.push("## Source Refs");
  lines.push("");
  if (pack.sourceRefs.length === 0) {
    lines.push("- none");
  } else {
    for (const ref of pack.sourceRefs) {
      lines.push(`- ${ref}`);
    }
  }
  lines.push("");

  lines.push("## Diagnostics");
  lines.push("");
  if (pack.diagnostics.degradedReasons.length === 0) {
    lines.push("- degradedReasons: []");
  } else {
    lines.push(`- degradedReasons: ${pack.diagnostics.degradedReasons.join(", ")}`);
  }
  return lines.join("\n");
}
