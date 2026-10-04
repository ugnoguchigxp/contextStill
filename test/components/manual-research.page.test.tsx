/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualResearchPage } from "../../web/src/modules/manual-research/manual-research.page";
import type { ManualResearchRun } from "../../src/modules/manual-research/manual-research.service";

const run: ManualResearchRun = {
  id: "876ef4da-5b44-4bcd-b4e3-af87d816aa47",
  topic: "再送の安全性",
  engine: "codex",
  codex: {
    neededInformation: "",
    knownInformation: "",
    searchScope: "",
    reasoningEffort: "low",
    wallMs: 180000,
    tokenBudget: 20000,
    maxCandidates: 6,
    maxWebSearches: 12,
  },
  status: "completed",
  syncError: null,
  cancelRequested: false,
  resultHash: "sha256:test",
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:10Z",
  lastSyncedAt: "2026-10-04T00:00:10Z",
  result: {
    report: null,
    claims: [{ id: "codex-0", text: "再送には冪等キーを使う", evidenceIds: ["source-0"] }],
    evidence: [
      {
        id: "source-0",
        quote: "retry key",
        sourceUrl: "https://example.com/docs",
        sourceTitle: "一次資料",
        snapshotHash: "",
      },
    ],
    usage: { queries: 1, tokens: 1000, urls: null, requests: null, costUsd: null },
    reason: "completed",
    exploration: {
      candidates: [
        {
          title: "冪等な再送",
          knowledge: "再送には冪等キーを使う",
          relevance: "二重処理を防ぐ",
          uncertainties: ["期間は不明"],
          contradictions: [],
          sources: [
            {
              url: "https://example.com/docs",
              title: "一次資料",
              verification: "search_summary",
              excerpt: "retry key",
              location: "",
              informationDate: null,
            },
          ],
        },
      ],
      limitations: [],
      termination: "completed",
      tokenUsage: {
        inputTokens: 900,
        cachedInputTokens: 400,
        outputTokens: 100,
        reasoningOutputTokens: 20,
      },
      usageComplete: true,
      elapsedMs: 10000,
      observedWebSearches: 1,
      threadId: "test",
      model: "gpt-6-luna",
      reasoningEffort: "low",
    },
  },
};
afterEach(() => vi.unstubAllGlobals());
function mount(existing = false) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        requests.push({ url: input, body: JSON.parse(String(options.body ?? "{}")) });
        return Response.json(input.endsWith("/candidates") ? { receipts: [] } : { run });
      }
      if (input.includes("/compare?")) return Response.json({ runs: [] });
      if (input.endsWith("/api/manual-research/"))
        return Response.json({ runs: existing ? [run] : [] });
      return Response.json({ run });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ManualResearchPage />
    </QueryClientProvider>,
  );
  return requests;
}

describe("manual research engine selection and candidate review", () => {
  it("keeps an empty history shallow and shows no empty result panel", async () => {
    mount();
    await screen.findByText("調査はまだありません。");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "調査結果" })).not.toBeInTheDocument();
  });

  it("keeps DeepStill as the default and posts no Codex options", async () => {
    const requests = mount();
    expect(screen.getByRole("button", { name: "DeepStill" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.change(screen.getByPlaceholderText("何を調べますか"), {
      target: { value: "再送の安全性" },
    });
    fireEvent.click(screen.getByRole("button", { name: "調査を開始" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body.engine).toBe("deepstill");
    expect(requests[0]?.body.codex).toBeUndefined();
  });

  it("offers only low and medium for Luna and sends the bounded brief", async () => {
    const requests = mount();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.queryByLabelText("補足（任意）")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /推論の強さ/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "詳細設定" }));
    const effort = screen.getByRole("combobox", { name: /推論の強さ/ });
    expect(Array.from(effort.querySelectorAll("option")).map((option) => option.value)).toEqual([
      "low",
      "medium",
    ]);
    fireEvent.change(effort, { target: { value: "medium" } });
    fireEvent.change(screen.getByLabelText("時間上限（秒）"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("トークン予算（目安）"), { target: { value: "15000" } });
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(screen.getByText("Luna 6.0 · 推論：中")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "条件を追加" }));
    fireEvent.change(screen.getByLabelText("補足（任意）"), {
      target: { value: "一次資料の仕様" },
    });
    fireEvent.click(screen.getByRole("button", { name: "補足を閉じる" }));
    fireEvent.change(screen.getByPlaceholderText("何を調べますか"), {
      target: { value: "再送の安全性" },
    });
    fireEvent.click(screen.getByRole("button", { name: "調査を開始" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body.codex).toMatchObject({
      reasoningEffort: "medium",
      neededInformation: "一次資料の仕様",
      wallMs: 120000,
      tokenBudget: 15000,
    });
  });

  it("dismisses settings with Escape and outside input without submitting", () => {
    const requests = mount();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    const settings = screen.getByRole("button", { name: "詳細設定" });
    fireEvent.click(settings);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(settings).toHaveAttribute("aria-expanded", "false");
    expect(settings).toHaveFocus();
    fireEvent.click(settings);
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "調査テーマ" }));
    expect(settings).toHaveAttribute("aria-expanded", "false");
    expect(requests).toHaveLength(0);
  });

  it("shows snippet provenance and only starts a comparison after an explicit submit", async () => {
    const requests = mount(true);
    await screen.findByText(/検索結果の要約のみ/);
    expect(screen.getByText(/不確実性: 期間は不明/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同じテーマを別の探索方法で入力する" }));
    expect(screen.getByPlaceholderText("何を調べますか")).toHaveValue(run.topic);
    expect(screen.getByRole("button", { name: "DeepStill" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(requests).toHaveLength(0);
  });

  it("sends only selected candidates to evaluation with an explicit scope", async () => {
    const requests = mount(true);
    const checkbox = await screen.findByRole("checkbox", { name: "冪等な再送" });
    expect(screen.getByRole("button", { name: "候補評価へ送る" })).toBeDisabled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "候補評価へ送る" }));
    await screen.findByText("候補評価へ送りました。");
    expect(requests[0]).toEqual({
      url: `/api/manual-research/${run.id}/candidates`,
      body: { claimIds: ["codex-0"], scope: "global" },
    });
  });
});
