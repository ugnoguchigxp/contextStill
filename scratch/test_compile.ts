import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";

async function main() {
  const input = {
    goal: "Graph視覚化画面の左上にあるLegend（Rule/Procedureの識別サンプル）において、実際のNodeサンプルが表示されず機能していない問題を修正する。",
    intent: "edit",
    technologies: ["react", "typescript", "tailwindcss", "lucide-react"],
    files: ["web/src/modules/admin/components/graph.page.tsx"],
    changeTypes: ["bugfix", "ui-fix"],
  };

  console.log("--- INPUT ---");
  console.log(JSON.stringify(input, null, 2));

  try {
    const { pack } = await compileContextPack(input);

    console.log("\n--- OUTPUT (RAW) ---");
    const hasAnyContent =
      pack.rules.length > 0 ||
      pack.procedures.length > 0 ||
      pack.codeContext.length > 0 ||
      pack.warnings.length > 0;

    if (!hasAnyContent) {
      console.log("no content");
    } else {
      console.log(JSON.stringify(pack, null, 2));
    }

    if (pack.diagnostics?.retrievalStats?.agenticUsed === false) {
      console.warn("\n[WARNING] Agentic Refinement was NOT used. Check logs for errors.");
    }
  } catch (error) {
    console.error("\n--- EXECUTION ERROR ---");
    console.error(error);
  }
}

main();
