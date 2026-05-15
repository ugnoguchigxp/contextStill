import { runDoctor } from "../../modules/doctor/doctor.service.js";

function buildInitialInstructionsText(): string {
  return [
    "## 常用ルール",
    "- 常に日本語で返答する。",
    "- まず `context_compile` を呼び、作業の主導線とする。呼び出し時は必ず以下の情報を入力に含めること:",
    "  - `goal`: 達成したい具体的な目標（何を作るか、何を直すか）",
    "  - `intent`: タスクの性質 (plan, edit, debug, review, finish)",
    "  - `technologies`: 使用技術 (例: ['typescript', 'nextjs', 'drizzle'])",
    "  - `files`: 作業対象または参考にするファイルのパス",
    "  - `changeTypes`: (任意) 変更の種類 (例: ['refactoring', 'feature', 'bugfix'])",
    "  - `lastErrorContext`: (debug時) 発生しているエラー内容やスタックトレース",
    "- `memory_search` / `memory_fetch` は必要根拠の確認時だけ使う。",
    "- `search_knowledge` は raw 候補確認用。通常は `context_compile` を優先する。",
    "- draft backlog の整理や status 更新が必要な場合は `list_knowledge` / `update_knowledge` を使う。",
    "- ユーザーに情報を提示する際、それが本当に有用（ゴールに直接的・具体的に関係する）であるかを厳格に評価すること。不確実な情報やノイズでコンテキストを圧迫してはならない。",
    "- 毎回の長文ルール再出力はしない。必要最小限のみ返す。",
    "- 作業中に再利用可能なルールや手順を発見・確立した場合は、`register_knowledge` を使って積極的に知識ベースへ登録する。",
    "- `context_compile` の結果が `degraded` / `failed` の場合や、期待した情報が得られない場合は `doctor` を呼び、システム状態（DB/同期/Embedding）を確認する。",
    "",
    "## MCPツール種別",
    "- `context_compile`: 作業前の最小コンテキスト生成（主導線）。",
    "- `search_knowledge`: knowledge 候補の直接検索（補助）。",
    "- `register_knowledge`: 新しいルールや手順（スキル）の登録。",
    "- `list_knowledge` / `update_knowledge`: backlog 一覧と status/本文の更新（運用補助）。",
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
