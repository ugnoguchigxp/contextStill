import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ManualResearchRun } from "../../../../src/modules/manual-research/manual-research.service";
import type { researchMetrics } from "../../../../src/modules/manual-research/research-candidate-ingress";

export function ResearchResultControls({ run }: { run: ManualResearchRun }) {
  const [scope, setScope] = useState<"global" | "repo">("global");
  const [repoPath, setRepoPath] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const compare = useQuery({
    queryKey: ["research-comparison", run.topic],
    queryFn: async () => {
      const response = await fetch(
        `/api/manual-research/compare?topic=${encodeURIComponent(run.topic)}`,
      );
      if (!response.ok) throw new Error("比較を取得できません");
      return (await response.json()) as { runs: ReturnType<typeof researchMetrics>[] };
    },
    refetchInterval: 5000,
  });
  const register = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/manual-research/${run.id}/candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claimIds: selected,
          scope,
          ...(scope === "repo" ? { repoPath } : {}),
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "候補を送れませんでした");
      return data;
    },
    onSuccess: () => {
      setSelected([]);
      void compare.refetch();
    },
  });
  const registerError =
    register.error?.message === "RESEARCH_IMPORT_UNCONFIRMED_CHECK_QUEUE"
      ? "登録の確認が必要です。候補キューを確認してください。重複防止のため自動再登録しません。"
      : register.error?.message;
  return (
    <div className="mt-5 space-y-5">
      {run.resultHash && run.result?.claims.length ? (
        <section className="rounded border p-3">
          <h3 className="font-semibold">有用な候補を評価へ送る</h3>
          <p className="my-2 text-xs text-muted-foreground">
            選んだ候補を既存の根拠評価・保存の流れへ送ります。採用は評価後に判断されます。
          </p>
          {run.result.claims.map((claim, i) => (
            <label className="my-2 flex gap-2 text-sm" key={claim.id}>
              <input
                type="checkbox"
                checked={selected.includes(claim.id)}
                disabled={register.isPending}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, claim.id]
                      : selected.filter((id) => id !== claim.id),
                  )
                }
              />
              {run.result?.exploration?.candidates[i]?.title ?? claim.text}
            </label>
          ))}
          <div className="mt-3 flex flex-wrap gap-3">
            <label className="text-sm">
              保存範囲{" "}
              <select
                aria-label="候補の保存範囲"
                value={scope}
                onChange={(e) => setScope(e.target.value as "global" | "repo")}
                className="rounded border bg-background p-1"
              >
                <option value="global">全体</option>
                <option value="repo">プロジェクト</option>
              </select>
            </label>
            {scope === "repo" ? (
              <input
                aria-label="プロジェクトの絶対パス"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="プロジェクトの絶対パス"
                className="rounded border bg-background p-1"
              />
            ) : null}
            <button
              type="button"
              disabled={
                !selected.length ||
                register.isPending ||
                (scope === "repo" && !repoPath.startsWith("/"))
              }
              onClick={() => register.mutate()}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              候補評価へ送る
            </button>
          </div>
          {register.isSuccess ? (
            <output className="mt-2 block text-sm">候補評価へ送りました。</output>
          ) : null}
          {register.error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {registerError}
            </p>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3 className="font-semibold">同じテーマの比較</h3>
        <p className="my-2 text-xs text-muted-foreground">
          有用として選んだ数は評価へ送った数です。資料確認数はCodexの申告、DeepStillは保存資料との照合です。DeepStillの時間は作成から最終同期までを含みます。追加条件・予算が異なる実行は単純比較できません。
        </p>
        {compare.error ? (
          <p role="alert" className="text-sm">
            {compare.error.message}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {[
                  "探索",
                  "状態",
                  "候補",
                  "資料確認あり",
                  "有用として選択",
                  "所要秒",
                  "入力",
                  "キャッシュ入力",
                  "出力",
                  "合計",
                ].map((label) => (
                  <th key={label} className="p-2">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {compare.data?.runs.map((item) => (
                <tr key={item.id} className="border-t">
                  {[
                    item.engine === "codex"
                      ? `Luna 6.0 / ${item.reasoningEffort === "medium" ? "中" : "低"}`
                      : "DeepStill",
                    item.termination ?? item.status,
                    item.candidateCount,
                    item.withReadEvidence,
                    item.selectedCount,
                    item.elapsedMs === null ? "不明" : (item.elapsedMs / 1000).toFixed(1),
                    item.tokenUsage.inputTokens ?? "不明",
                    item.tokenUsage.cachedInputTokens ?? "不明",
                    item.tokenUsage.outputTokens ?? "不明",
                    item.totalTokens ?? "不明",
                  ].map((value, index) => (
                    <td
                      key={
                        [
                          "engine",
                          "status",
                          "candidates",
                          "read",
                          "selected",
                          "elapsed",
                          "input",
                          "cached",
                          "output",
                          "total",
                        ][index]
                      }
                      className="p-2"
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          キャッシュ入力はモデル入力の内数です。ウェブ検索はliveを使用します。停止時の使用量は取得できないことがあります。
        </p>
      </section>
    </div>
  );
}
