import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";

export function renderContextPackMarkdown(pack: ContextPack): string {
  const lines: string[] = [];
  lines.push("# コンテキスト・パック");
  lines.push("");
  lines.push(`- 目的: ${pack.goal}`);
  lines.push(`- 意図: ${pack.intent}`);
  lines.push(`- 検索モード: ${pack.retrievalMode}`);
  lines.push(`- 状態: ${pack.status}`);
  lines.push("");

  lines.push("## 最小タスク");
  lines.push("");
  for (const task of pack.minimalTasks) {
    lines.push(`- ${task}`);
  }
  lines.push("");

  const renderSection = (title: string, items: ContextPack["rules"]): void => {
    lines.push(`## ${title}`);
    lines.push("");
    if (items.length === 0) {
      lines.push("- なし");
    } else {
      for (const item of items) {
        lines.push(`- ${item.title} (${item.rankingReason})`);
      }
    }
    lines.push("");
  };

  renderSection("ルール", pack.rules);
  renderSection("手順", pack.procedures);
  renderSection("ファイル・ヒント", pack.codeContext);

  lines.push("## 関連するソース・エビデンス");
  lines.push("");
  if (pack.sourceRefs.length === 0) {
    lines.push("- なし");
  } else {
    for (const ref of pack.sourceRefs) {
      lines.push(`- ${ref}`);
    }
  }
  lines.push("");

  lines.push("## 警告 / 不足しているコンテキスト");
  lines.push("");
  if (pack.warnings.length === 0) {
    lines.push("- なし");
  } else {
    for (const warning of pack.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");

  lines.push("## 推奨される次の MCP コール");
  lines.push("");
  const suggestedNextCalls =
    Array.isArray(pack.diagnostics.retrievalStats.suggestedNextCalls) &&
    pack.diagnostics.retrievalStats.suggestedNextCalls.every((item) => typeof item === "string")
      ? (pack.diagnostics.retrievalStats.suggestedNextCalls as string[])
      : [];
  if (suggestedNextCalls.length === 0) {
    lines.push("- なし");
  } else {
    for (const call of suggestedNextCalls) {
      lines.push(`- ${call}`);
    }
  }
  lines.push("");

  lines.push("## 診断情報");
  lines.push("");
  if (pack.diagnostics.degradedReasons.length === 0) {
    lines.push("- 低下理由: []");
  } else {
    lines.push(`- 低下理由: ${pack.diagnostics.degradedReasons.join(", ")}`);
  }
  return lines.join("\n");
}
