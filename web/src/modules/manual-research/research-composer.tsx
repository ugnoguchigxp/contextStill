import { ArrowRight, ChevronDown, Plus, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CodexResearchOptions } from "../../../../src/modules/manual-research/codex-research.contract";
import { CodexResearchControls } from "./codex-research-controls";

export function ResearchComposer({
  topic,
  onTopicChange,
  engine,
  onEngineChange,
  codex,
  onCodexChange,
  onSubmit,
  pending,
  error,
}: {
  topic: string;
  onTopicChange: (topic: string) => void;
  engine: "deepstill" | "codex";
  onEngineChange: (engine: "deepstill" | "codex") => void;
  codex: CodexResearchOptions;
  onCodexChange: (options: CodexResearchOptions) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  error: Error | null;
}) {
  const [supplementOpen, setSupplementOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !settingsRef.current?.contains(event.target))
        setSettingsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        settingsButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [settingsOpen]);

  return (
    <form
      aria-label="調査を開始"
      onSubmit={onSubmit}
      className="mb-7 rounded-xl border bg-card shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <fieldset aria-label="探索方法" className="inline-flex rounded-lg bg-muted p-1">
          {(["deepstill", "codex"] as const).map((method) => (
            <button
              key={method}
              type="button"
              aria-pressed={engine === method}
              onClick={() => {
                onEngineChange(method);
                setSettingsOpen(false);
              }}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 ${engine === method ? "bg-blue-600 text-white shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {method === "codex" ? "Codex" : "DeepStill"}
            </button>
          ))}
        </fieldset>
        <span className="text-xs text-muted-foreground sm:text-sm">
          {engine === "codex"
            ? `Luna 6.0 · 推論：${codex.reasoningEffort === "low" ? "低" : "中"}`
            : "公開ウェブを探索"}
        </span>
        <div ref={settingsRef} className="relative ml-auto">
          <button
            ref={settingsButton}
            type="button"
            aria-expanded={settingsOpen}
            aria-controls="research-settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Settings2 className="size-3.5" aria-hidden="true" />
            詳細設定
          </button>
          {settingsOpen ? (
            <fieldset
              id="research-settings"
              aria-label="詳細設定"
              className="absolute right-0 top-full z-20 mt-2 w-[min(300px,calc(100vw-48px))] rounded-lg border bg-card p-4 shadow-lg"
            >
              {engine === "codex" ? (
                <CodexResearchControls value={codex} onChange={onCodexChange} />
              ) : (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  DeepStillの上限は15分・検索25回・費用1 USDです。
                </p>
              )}
              <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                失敗時に別の探索は自動実行しません。
              </p>
              <button
                type="button"
                onClick={() => {
                  setSettingsOpen(false);
                  settingsButton.current?.focus();
                }}
                className="mt-3 w-full rounded-md border py-1.5 text-sm hover:bg-muted"
              >
                閉じる
              </button>
            </fieldset>
          ) : null}
        </div>
      </div>
      <div className="px-4 pt-3">
        <label htmlFor="research-topic" className="mb-1.5 block text-sm font-medium">
          調査テーマ
        </label>
        <div className="flex items-center gap-3">
          <textarea
            id="research-topic"
            rows={2}
            value={topic}
            onChange={(event) => onTopicChange(event.target.value)}
            minLength={2}
            maxLength={400}
            required
            placeholder="何を調べますか"
            className="min-w-0 flex-1 resize-y rounded-lg border bg-background px-3 py-2.5 text-sm leading-5 placeholder:text-muted-foreground focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15"
          />
          <button
            type="submit"
            disabled={pending || topic.trim().length < 2}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-3 py-3 text-sm font-medium text-white hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 sm:px-5"
          >
            {pending ? "作成中…" : "調査を開始"}
            <ArrowRight className="hidden size-4 sm:block" aria-hidden="true" />
          </button>
        </div>
        {engine === "codex" && supplementOpen ? (
          <label htmlFor="research-supplement" className="mt-3 block text-sm font-medium">
            補足（任意）
            <textarea
              id="research-supplement"
              rows={2}
              maxLength={1600}
              value={codex.neededInformation}
              onChange={(event) =>
                onCodexChange({ ...codex, neededInformation: event.target.value })
              }
              placeholder="必要な情報、すでに分かっていること、対象や期間など"
              className="mt-1.5 block w-full resize-y rounded-lg border bg-background px-3 py-2.5 text-sm font-normal focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15"
            />
          </label>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
        {engine === "codex" ? (
          <button
            type="button"
            aria-expanded={supplementOpen}
            aria-controls="research-supplement"
            onClick={() => setSupplementOpen(!supplementOpen)}
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            {supplementOpen ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <Plus className="size-3.5" aria-hidden="true" />
            )}
            {supplementOpen
              ? "補足を閉じる"
              : codex.neededInformation
                ? "条件を編集（入力済み）"
                : "条件を追加"}
          </button>
        ) : (
          <span>DeepStillで調査します。</span>
        )}
        <span>結果を確認してから、候補評価へ送れます。</span>
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          開始できませんでした: {error.message}
        </p>
      ) : null}
    </form>
  );
}
