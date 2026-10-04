/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionRow } from "../../../src/modules/settings/connection-contracts";
import { SettingsPage } from "../../../web/src/modules/admin/components/settings.page";
import { buildSnapshot } from "./settings.fixture";
const state = vi.hoisted(() => ({ tab: "connections" }));
const api = vi.hoisted(() => ({
  fetchRuntimeSettings: vi.fn(),
  reloadRuntimeSettingsCache: vi.fn(),
  fetchConnections: vi.fn(),
  fetchConnectionRuntime: vi.fn(),
  saveConnection: vi.fn(),
  startTest: vi.fn(),
  fetchTest: vi.fn(),
  cancelTest: vi.fn(),
  fetchOperation: vi.fn(),
  saveSection: vi.fn(),
  removeConnection: vi.fn(),
  fetchAgentPolicy: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ section: state.tab }),
  useLocation: () => "",
  Link: ({ children, params, ...props }: any) => (
    <a {...props} href={`/setting/${params.section}`}>
      {children}
    </a>
  ),
}));
vi.mock("../../../web/src/modules/admin/repositories/admin/settings-api", () => ({
  ...api,
  fetchCodexAuthStatus: vi.fn(),
  fetchCodexLoginCommand: vi.fn(),
}));
vi.mock("../../../web/src/modules/admin/repositories/admin/connections-api", () => api);
const row: ConnectionRow = {
  id: "worker-a",
  kind: "local-llm",
  name: "Worker A",
  model: "test-model",
  endpoint: "http://127.0.0.1:12345",
  enabled: true,
  fields: {
    name: "Worker A",
    model: "test-model",
    apiBaseUrl: "http://127.0.0.1:12345",
    apiPath: "/v1/chat/completions",
    enabled: true,
    id: "worker-a",
  },
  credentialKey: "localLlmApiKey",
  credential: { configured: true, source: "db", maskedValue: null, updatedAt: null },
  references: [],
};
let snapshot = buildSnapshot();
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  state.tab = "connections";
  snapshot = buildSnapshot();
  snapshot.settings.advanced.agentRuntime = {
    enabled: true,
    research: {
      baseUrl: "http://127.0.0.1:9001",
      gatewayUrl: "http://127.0.0.1:9002",
      credentialKey: "researchKey",
      gatewayCredentialKey: "gatewayKey",
    },
  };
  api.fetchRuntimeSettings.mockImplementation(async () => structuredClone(snapshot));
  api.fetchConnections.mockResolvedValue({ connections: [row], revision: 1, tests: {} });
  api.fetchConnectionRuntime.mockResolvedValue({
    status: "configured",
    observedAt: "2026-10-04T00:00:00Z",
  });
  api.fetchAgentPolicy.mockRejectedValue(new Error("offline"));
  api.saveConnection.mockResolvedValue({ revision: 2, value: { id: row.id } });
  api.saveSection.mockResolvedValue({ revision: 2 });
  api.fetchOperation.mockRejectedValue(new Error("not_found"));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}
describe("new settings screen", () => {
  it("shows per-row tests, opens edit modal, preserves auth and saves only the selected connection", async () => {
    mount();
    await screen.findByRole("button", { name: "編集" });
    expect(screen.queryByRole("button", { name: "Save Settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("表示名"), {
      target: { value: "Updated worker" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "変更を保存" }));
    await waitFor(() => expect(api.saveConnection).toHaveBeenCalledOnce());
    const [input, id] = api.saveConnection.mock.calls[0];
    expect(id).toBe(row.id);
    expect(input.fields.name).toBe("Updated worker");
    expect(input.fields.id).toBeUndefined();
    expect(input.credential).toEqual({ action: "keep" });
    expect(input.expectedRevision).toBe(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps modal edits on refetch, and cancelling does not save", async () => {
    mount();
    await screen.findByRole("button", { name: "編集" });
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("表示名"), { target: { value: "Unsaved" } });
    await client.invalidateQueries({ queryKey: ["settings-connections"] });
    expect(within(dialog).getByLabelText("表示名")).toHaveValue("Unsaved");
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(api.saveConnection).not.toHaveBeenCalled();
  });
  it("uses saved ID for table tests and keeps draft test results inside the modal", async () => {
    api.startTest.mockResolvedValue({
      id: "test-1",
      status: "failed",
      scope: "draft",
      error: "HTTP 401",
      startedAt: "2026-10-04T00:00:00Z",
    });
    mount();
    await screen.findByRole("button", { name: "編集" });
    fireEvent.click(screen.getByRole("button", { name: "接続を確認" }));
    await waitFor(() => expect(api.startTest).toHaveBeenCalledWith(row.id));
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.click(screen.getByRole("button", { name: "入力中の設定を確認" }));
    await screen.findByText("HTTP 401");
    expect(api.startTest.mock.calls[1][1].fields.model).toBe(row.model);
    expect(screen.getByRole("dialog")).toHaveTextContent("HTTP 401");
    expect(api.saveConnection).not.toHaveBeenCalled();
  });
  it("keeps Finding routes independent and sends a taskRouting diff", async () => {
    state.tab = "assignments";
    mount();
    const select = await screen.findByRole("combobox", { name: "Finding · Vibe Memory の接続" });
    fireEvent.change(select, { target: { value: row.id } });
    fireEvent.click(screen.getByRole("button", { name: "処理の割り当てを保存" }));
    await waitFor(() => expect(api.saveSection).toHaveBeenCalledOnce());
    const patch = api.saveSection.mock.calls[0][0];
    expect(patch.section).toBe("taskRouting");
    expect(patch.changes.findCandidate.vibe.provider).toBe("local-llm");
    expect(patch.changes.findCandidate.source).toBeUndefined();
    expect(patch.changes.coverEvidence).toBeUndefined();
  });
  it("preserves an unsaved draft when moving through the provider tab", async () => {
    state.tab = "advanced";
    const page = mount();
    const input = await screen.findByLabelText("処理ロックの失効（秒）");
    fireEvent.change(input, { target: { value: "999" } });
    state.tab = "connections";
    page.rerender(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
    await client.invalidateQueries({ queryKey: ["runtime-settings"] });
    state.tab = "advanced";
    page.rerender(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("処理ロックの失効（秒）")).toHaveValue(999);
    fireEvent.click(screen.getByRole("button", { name: "詳細設定を保存" }));
    await waitFor(() => expect(api.saveSection).toHaveBeenCalled());
    expect(api.saveSection.mock.calls[0][0].changes).toEqual({ pipelineLockStaleSeconds: 999 });
  });
  it("adds every provider kind through the modal with current LARM limits", async () => {
    mount();
    await screen.findByRole("button", { name: /プロバイダーを追加/ });
    fireEvent.click(screen.getByRole("button", { name: /プロバイダーを追加/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("種類"), {
      target: { value: "larm-agent-connection" },
    });
    expect(within(dialog).getByLabelText("同時リクエストの上限（1〜4）")).toHaveValue(4);
    expect(within(dialog).getByLabelText("Connectionの期限（秒）")).toHaveValue(900);
    expect(within(dialog).getByLabelText("推論の制限時間（ms）")).toHaveValue(300000);
  });
});
