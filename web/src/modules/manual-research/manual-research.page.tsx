import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { ManualResearchRun } from "../../../../src/modules/manual-research/manual-research.service";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/manual-research${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

const statusLabels: Record<string, string> = {
  created: "送信待ち",
  queued: "待機中",
  running: "探索中",
  finalizing: "結果生成中",
  cancel_requested: "停止処理中",
  completed: "完了",
  partial: "部分成果",
  failed: "失敗",
  cancelled: "停止済み",
  invalid_result: "結果を確認できません",
  unavailable: "接続設定が必要",
};

const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "invalid_result",
  "unavailable",
]);

export function ManualResearchPage() {
  const queryClient = useQueryClient();
  const [topic, setTopic] = useState("");
  const pendingRequest = useRef<{ topic: string; key: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ["manual-research"],
    queryFn: () => api<{ runs: ManualResearchRun[] }>("/"),
    refetchInterval: 5000,
  });
  const selected = selectedId ?? runs.data?.runs[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["manual-research", selected],
    queryFn: () => api<{ run: ManualResearchRun }>(`/${selected}`),
    enabled: Boolean(selected),
    refetchInterval: (query) => (terminal.has(query.state.data?.run.status ?? "") ? false : 3000),
  });
  const create = useMutation({
    mutationFn: (input: { topic: string; key: string }) =>
      api<{ run: ManualResearchRun }>("/", {
        method: "POST",
        body: JSON.stringify({ topic: input.topic, clientRequestKey: input.key }),
      }),
    onSuccess: async ({ run }) => {
      pendingRequest.current = null;
      setSelectedId(run.id);
      setTopic("");
      await queryClient.invalidateQueries({ queryKey: ["manual-research"] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<{ run: ManualResearchRun }>(`/${id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["manual-research"] }),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = topic.trim();
    if (value.length >= 2 && value.length <= 400) {
      if (pendingRequest.current?.topic !== value)
        pendingRequest.current = { topic: value, key: crypto.randomUUID() };
      create.mutate(pendingRequest.current);
    }
  };
  const run = detail.data?.run ?? null;

  return (
    <div className="mx-auto max-w-[1500px] p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">調査</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          テーマを指定してDeepStillで探索し、結果と出典を確認します。
        </p>
      </header>
      <form
        onSubmit={submit}
        className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4"
      >
        <label className="min-w-[280px] flex-1 text-sm font-medium">
          調査テーマ
          <textarea
            className="mt-2 min-h-20 w-full rounded-md border bg-background p-3 text-sm"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            minLength={2}
            maxLength={400}
            required
            placeholder="何を調べますか"
          />
        </label>
        <button
          type="submit"
          disabled={create.isPending || topic.trim().length < 2}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {create.isPending ? "作成中…" : "調査を開始"}
        </button>
        <p className="w-full text-xs text-muted-foreground">
          実調査を実行します。上限は15分・検索25回・費用1 USDです。
        </p>
        {create.error ? (
          <p role="alert" className="w-full text-sm text-destructive">
            開始できませんでした: {create.error.message}
          </p>
        ) : null}
      </form>
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-lg border bg-card p-3">
          <h2 className="mb-3 px-2 text-sm font-semibold">調査履歴</h2>
          {runs.isLoading ? <p className="px-2 text-sm">読み込み中…</p> : null}
          {runs.error ? (
            <p role="alert" className="px-2 text-sm text-destructive">
              履歴を読み込めません: {runs.error.message}
            </p>
          ) : null}
          {!runs.data?.runs.length && !runs.isLoading ? (
            <p className="px-2 text-sm text-muted-foreground">調査はまだありません。</p>
          ) : null}
          <div className="space-y-1">
            {runs.data?.runs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${selected === item.id ? "bg-accent" : "hover:bg-muted"}`}
              >
                <span className="block truncate font-medium">{item.topic}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {statusLabels[item.status] ?? item.status} ·{" "}
                  {new Date(item.createdAt).toLocaleString("ja-JP")}
                </span>
              </button>
            ))}
          </div>
        </aside>
        <section className="min-h-[420px] rounded-lg border bg-card p-5">
          {!selected ? (
            <p className="text-sm text-muted-foreground">
              テーマを入力して調査を開始してください。
            </p>
          ) : null}
          {selected && detail.isLoading ? <p className="text-sm">調査を読み込み中…</p> : null}
          {detail.error ? (
            <p role="alert" className="text-sm text-destructive">
              調査を読み込めません: {detail.error.message}
            </p>
          ) : null}
          {run ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                <div>
                  <h2 className="text-xl font-semibold">{run.topic}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {statusLabels[run.status] ?? run.status}
                    {run.lastSyncedAt
                      ? ` · 最終確認 ${new Date(run.lastSyncedAt).toLocaleString("ja-JP")}`
                      : ""}
                  </p>
                </div>
                {!terminal.has(run.status) ? (
                  <button
                    type="button"
                    disabled={run.cancelRequested || cancel.isPending}
                    onClick={() => cancel.mutate(run.id)}
                    className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {run.cancelRequested ? "停止を要求しました" : "調査を停止"}
                  </button>
                ) : null}
              </div>
              {run.syncError ? (
                <output className="mt-4 block rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  {terminal.has(run.status)
                    ? "終了理由・結果の問題"
                    : "DeepStillとの同期を確認できません"}
                  : {run.syncError}
                </output>
              ) : null}
              {cancel.error ? (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  停止を要求できません: {cancel.error.message}
                </p>
              ) : null}
              {run.result ? (
                <article className="mt-6 space-y-5">
                  {run.result.reason ? (
                    <p className="text-sm text-muted-foreground">終了理由: {run.result.reason}</p>
                  ) : null}
                  {run.result.report ? (
                    <div>
                      <h3 className="text-lg font-semibold">{run.result.report.title}</h3>
                      <div className="mt-3 whitespace-pre-wrap text-sm leading-7">
                        {run.result.report.body}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      レポートはありません。取得できた根拠を以下に示します。
                    </p>
                  )}
                  {run.result.report?.limitations.length ? (
                    <section>
                      <h4 className="font-semibold">調査の限界</h4>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {run.result.report.limitations.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {run.result.report?.openQuestions.length ? (
                    <section>
                      <h4 className="font-semibold">残された問い</h4>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {run.result.report.openQuestions.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {run.result.claims.length ? (
                    <section>
                      <h4 className="font-semibold">主張と根拠</h4>
                      <div className="mt-3 space-y-4">
                        {run.result.claims.map((claim) => (
                          <div key={claim.id} className="rounded-md border p-3">
                            <p className="text-sm">{claim.text}</p>
                            {claim.evidenceIds.length === 0 ? (
                              <p className="mt-2 text-xs text-amber-700">対応する引用はありません。</p>
                            ) : null}
                            <ul className="mt-2 space-y-2">
                              {claim.evidenceIds.map((id) => {
                                const evidence = run.result?.evidence.find(
                                  (item) => item.id === id,
                                );
                                return evidence ? (
                                  <li key={id} className="text-xs text-muted-foreground">
                                    <blockquote className="border-l-2 pl-2">
                                      {evidence.quote}
                                    </blockquote>
                                    <a
                                      href={evidence.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="mt-1 inline-block underline"
                                    >
                                      {evidence.sourceTitle || evidence.sourceUrl}
                                    </a>
                                  </li>
                                ) : null;
                              })}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    引用はDeepStillの保存済みsourceと照合しました。ContextStillによる原文サイトの再取得は行っていません。
                  </p>
                </article>
              ) : terminal.has(run.status) ? (
                <p className="mt-5 text-sm text-muted-foreground">
                  表示できるレポートはありません。
                </p>
              ) : (
                <p className="mt-5 text-sm text-muted-foreground">
                  調査の結果を待っています。画面を閉じても調査は続きます。
                </p>
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
