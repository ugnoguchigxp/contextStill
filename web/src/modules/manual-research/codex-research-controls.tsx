import type { CodexResearchOptions } from "../../../../src/modules/manual-research/codex-research.contract";

export const defaultCodexResearchOptions: CodexResearchOptions = {
  neededInformation: "",
  knownInformation: "",
  searchScope: "",
  reasoningEffort: "low",
  wallMs: 180_000,
  tokenBudget: 20_000,
  maxWebSearches: 12,
  maxCandidates: 6,
};

export function CodexResearchControls({
  value,
  onChange,
}: {
  value: CodexResearchOptions;
  onChange: (next: CodexResearchOptions) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="text-sm">
        推論の強さ
        <select
          value={value.reasoningEffort}
          onChange={(e) =>
            onChange({ ...value, reasoningEffort: e.target.value as "low" | "medium" })
          }
          className="mt-1 block w-full rounded-md border bg-background px-3 py-2"
        >
          <option value="low">低</option>
          <option value="medium">中</option>
        </select>
      </label>
      <label className="text-sm">
        時間上限（秒）
        <input
          type="number"
          min={1}
          max={300}
          value={value.wallMs / 1000}
          onChange={(e) => onChange({ ...value, wallMs: Number(e.target.value) * 1000 })}
          className="mt-1 block w-full rounded-md border bg-background px-3 py-2"
        />
      </label>
      <label className="text-sm">
        トークン予算（目安）
        <input
          type="number"
          min={1000}
          max={100000}
          value={value.tokenBudget}
          onChange={(e) => onChange({ ...value, tokenBudget: Number(e.target.value) })}
          className="mt-1 block w-full rounded-md border bg-background px-3 py-2"
        />
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        トークン予算は目安です。使用量はターン完了時に確認します。時間上限で中断を要求し、取得済みの候補を残します。
      </p>
    </div>
  );
}
