import { runDoctor } from "../../modules/doctor/doctor.service.js";

function buildInitialInstructionsText(): string {
  return [
    "## 常用ルール",
    "- 常に日本語で返答する。",
    "- まず `context_compile` を呼び、主導線として使う。",
    "- `memory_search` / `memory_fetch` は必要根拠の確認時だけ使う。",
    "- `search_knowledge` は raw 候補確認用。通常は `context_compile` を優先する。",
    "- 毎回の長文ルール再出力はしない。必要最小限のみ返す。",
    "- 作業中に再利用可能なルールや手順を発見・確立した場合は、`register_knowledge` を使って積極的に知識ベースへ登録する。",
    "- `context_compile` の結果が `degraded` / `failed` の場合や、期待した情報が得られない場合は `doctor` を呼び、システム状態（DB/同期/Embedding）を確認する。",
    "",
    "## MCPツール種別",
    "- `context_compile`: 作業前の最小コンテキスト生成（主導線）。",
    "- `search_knowledge`: knowledge 候補の直接検索（補助）。",
    "- `register_knowledge`: 新しいルールや手順（スキル）の登録。",
    "- `memory_search` / `memory_fetch`: 過去会話・差分の参照（補助）。",
    "- `doctor`: DB / embedding / automation / run health の診断。",
  ].join("\n");
}

export const initialInstructionsTool = {
  name: "initial_instructions",
  description: "Get concise MCP operating guidance and the recommended tool flow.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    return {
      content: [{ type: "text", text: buildInitialInstructionsText() }],
    };
  },
};

export const doctorTool = {
  name: "doctor",
  description: "Run diagnostic checks on the memory-router system (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async () => {
    const report = await runDoctor();
    return {
      content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
    };
  },
};
