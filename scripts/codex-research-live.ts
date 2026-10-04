import { exploreWithCodex } from "../src/modules/manual-research/codex-research.js";
import { codexResearchOptionsSchema } from "../src/modules/manual-research/codex-research.contract.js";

if (!process.argv.includes("--live")) {
  console.error("外部消費を伴う検証です。実行する場合は --live を指定してください。");
  process.exit(2);
}
const result = await exploreWithCodex(
  "Codex SDKのTypeScriptで使用量を取得する方法",
  codexResearchOptionsSchema.parse({
    neededInformation: "公式資料を一つ確認し、使用量の取得タイミングについて候補を一件返す。",
    searchScope: "OpenAI公式の公開ドキュメントだけ。検索は一回を目安とする。",
    wallMs: 45_000,
    tokenBudget: 6000,
    maxWebSearches: 3,
    maxCandidates: 1,
  }),
);
console.log(JSON.stringify(result, null, 2));
if (!["completed", "insufficient_evidence", "token_budget"].includes(result.termination))
  process.exitCode = 1;
