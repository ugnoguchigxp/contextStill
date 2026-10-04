import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import type { ManualResearchRun } from "../../../../src/modules/manual-research/manual-research.service";
import type { CodexResearchOptions } from "../../../../src/modules/manual-research/codex-research.contract";
import { defaultCodexResearchOptions } from "./codex-research-controls";
import { ResearchComposer } from "./research-composer";
import { ResearchResultControls } from "./research-result-controls";

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
  const [engine, setEngine] = useState<"deepstill" | "codex">("deepstill");
  const [codex, setCodex] = useState(defaultCodexResearchOptions);
  type CreateInput = {
    topic: string;
    engine: "deepstill" | "codex";
    codex?: CodexResearchOptions;
    clientRequestKey: string;
  };
  const pendingRequest = useRef<{ signature: string; input: CreateInput } | null>(null);
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
    mutationFn: (input: CreateInput) =>
      api<{ run: ManualResearchRun }>("/", {
        method: "POST",
        body: JSON.stringify(input),
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
      const input = { topic: value, engine, ...(engine === "codex" ? { codex } : {}) };
      const signature = JSON.stringify(input);
      if (pendingRequest.current?.signature !== signature)
        pendingRequest.current = {
          signature,
          input: { ...input, clientRequestKey: crypto.randomUUID() },
        };
      create.mutate(pendingRequest.current.input);
    }
  };
  const run = detail.data?.run ?? null;

  return (
    <div className="mx-auto max-w-[1500px] p-6">
      <header className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">調査</h1>
        <p className="text-sm text-muted-foreground">テーマから候補と出典を集める</p>
      </header>
      <ResearchComposer
        topic={topic}
        onTopicChange={setTopic}
        engine={engine}
        onEngineChange={setEngine}
        codex={codex}
        onCodexChange={setCodex}
        onSubmit={submit}
        pending={create.isPending}
        error={create.error}
      />
      <section aria-label="調査履歴" className="mb-5">
        <h2 className="mb-3 text-sm font-semibold">調査履歴</h2>
        {runs.error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            履歴を読み込めません: {runs.error.message}
          </p>
        ) : null}
        <div className="max-h-64 overflow-auto rounded-lg border bg-card">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="sticky top-0 border-b bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="whitespace-nowrap px-4 py-2.5 font-medium">
                  テーマ
                </th>
                <th scope="col" className="w-28 whitespace-nowrap px-4 py-2.5 font-medium">
                  探索方法
                </th>
                <th scope="col" className="w-28 whitespace-nowrap px-4 py-2.5 font-medium">
                  状態
                </th>
                <th scope="col" className="w-48 whitespace-nowrap px-4 py-2.5 font-medium">
                  開始日時
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {runs.data?.runs.map((item) => (
                <tr
                  key={item.id}
                  className={
                    selected === item.id ? "bg-blue-50/70 dark:bg-blue-950/30" : "hover:bg-muted/30"
                  }
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      aria-current={selected === item.id ? "true" : undefined}
                      onClick={() => setSelectedId(item.id)}
                      className="block text-left font-medium hover:text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      {item.topic}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {item.engine === "codex" ? "Codex" : "DeepStill"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="rounded-md bg-muted px-2 py-1 text-xs">
                      {statusLabels[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString("ja-JP")}
                  </td>
                </tr>
              ))}
              {!runs.data?.runs.length ? (
                <tr>
                  <td colSpan={4} className="px-4 py-5 text-center text-sm text-muted-foreground">
                    {runs.isLoading
                      ? "読み込み中…"
                      : runs.error
                        ? "履歴を表示できません。"
                        : "調査はまだありません。"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      {selected ? (
        <section aria-label="調査結果" className="rounded-lg border bg-card p-5">
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
                    {run.engine === "codex" ? "Codex / Luna 6.0" : "DeepStill"} ·{" "}
                    {statusLabels[run.status] ?? run.status}
                    {run.lastSyncedAt
                      ? ` · 最終確認 ${new Date(run.lastSyncedAt).toLocaleString("ja-JP")}`
                      : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setTopic(run.topic);
                      setEngine(run.engine === "codex" ? "deepstill" : "codex");
                      setCodex(run.codex ?? defaultCodexResearchOptions);
                    }}
                    className="mt-2 text-sm underline"
                  >
                    同じテーマを別の探索方法で入力する
                  </button>
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
                  {terminal.has(run.status) ? "終了理由・結果の問題" : "探索の状態を確認できません"}
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
                        {run.result.claims.map((claim, index) => (
                          <div key={claim.id} className="rounded-md border p-3">
                            <p className="text-sm">{claim.text}</p>
                            {run.result?.exploration?.candidates[index] ? (
                              <div className="mt-2 text-xs text-muted-foreground">
                                <p>関連性: {run.result.exploration.candidates[index].relevance}</p>
                                <p>
                                  不確実性:{" "}
                                  {run.result.exploration.candidates[index].uncertainties.join(
                                    " / ",
                                  ) || "記載なし"}
                                </p>
                                <p>
                                  反証・食い違い:{" "}
                                  {run.result.exploration.candidates[index].contradictions.join(
                                    " / ",
                                  ) || "記載なし"}
                                </p>
                                {run.result.exploration.candidates[index].sources.map((source) => (
                                  <p key={source.url}>
                                    {source.title}:{" "}
                                    {source.verification === "source_read"
                                      ? "資料を読んで確認（Codex申告）"
                                      : "検索結果の要約のみ"}{" "}
                                    · 情報時点: {source.informationDate ?? "不明"}
                                    {source.location ? ` · 箇所: ${source.location}` : ""}
                                  </p>
                                ))}
                              </div>
                            ) : null}
                            {claim.evidenceIds.length === 0 ? (
                              <p className="mt-2 text-xs text-amber-700">
                                対応する引用はありません。
                              </p>
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
                    {run.engine === "codex"
                      ? "資料の確認状態・抜粋はCodexの申告です。ContextStillで原文との照合は行っていません。"
                      : "引用はDeepStillの保存済みsourceと照合しました。ContextStillによる原文サイトの再取得は行っていません。"}
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
              <ResearchResultControls key={run.id} run={run} />
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
