/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialField,
  SectionEditor,
} from "../../../web/src/modules/admin/components/settings/section-editor";
import {
  Fields,
  conflicts,
  objectDiff,
} from "../../../web/src/modules/admin/components/settings/settings-fields";
const api = vi.hoisted(() => ({ saveSection: vi.fn(), fetchOperation: vi.fn() }));
vi.mock("../../../web/src/modules/admin/repositories/admin/connections-api", () => api);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("scoped settings editors", () => {
  it("detects only conflicting edited paths and preserves agentRuntime", () => {
    const base = {
      pipelineClaimLimit: 1,
      agentRuntime: { enabled: true, research: { credentialKey: "one" } },
    };
    const next = { ...base, pipelineClaimLimit: 2 };
    const diff = objectDiff(base, next);
    expect(diff).toEqual({ pipelineClaimLimit: 2 });
    expect(
      conflicts(
        base,
        { ...base, agentRuntime: { enabled: false, research: { credentialKey: "two" } } },
        diff,
      ),
    ).toBe(false);
    expect(conflicts(base, { ...base, pipelineClaimLimit: 3 }, diff)).toBe(true);
  });
  it("retains input and requires explicit reconciliation of a conflicting refetch", async () => {
    api.saveSection.mockResolvedValue({ revision: 3 });
    const props = {
      section: "advanced" as const,
      title: "詳細",
      revision: 1,
      value: { pipelineClaimLimit: 1 },
      onSaved: async () => {},
    };
    const child = (value: any, change: any) => <Fields value={value} onChange={change} />;
    const page = render(<SectionEditor {...props}>{child}</SectionEditor>);
    fireEvent.change(screen.getByLabelText("1巡で取得する処理の上限"), { target: { value: "2" } });
    page.rerender(
      <SectionEditor {...props} revision={2} value={{ pipelineClaimLimit: 3 }}>
        {child}
      </SectionEditor>,
    );
    expect(screen.getByLabelText("1巡で取得する処理の上限")).toHaveValue(2);
    expect(screen.getByRole("button", { name: "詳細を保存" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "最新の設定に変更を重ねる" }));
    fireEvent.click(screen.getByRole("button", { name: "詳細を保存" }));
    await waitFor(() => expect(api.saveSection).toHaveBeenCalled());
    expect(api.saveSection.mock.calls[0][0]).toMatchObject({
      expectedRevision: 2,
      changes: { pipelineClaimLimit: 2 },
    });
  });
  it("keeps an unknown save receipt id for safe retry", async () => {
    api.saveSection.mockRejectedValue(new Error("network"));
    api.fetchOperation.mockRejectedValue(new Error("not found"));
    const page = render(
      <SectionEditor
        section="advanced"
        title="詳細"
        revision={1}
        value={{ pipelineClaimLimit: 1 }}
        onSaved={async () => {}}
      >
        {(value, change) => <Fields value={value} onChange={change} />}
      </SectionEditor>,
    );
    fireEvent.change(screen.getByLabelText("1巡で取得する処理の上限"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "詳細を保存" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("button", { name: "詳細を保存" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "詳細を保存" }));
    await waitFor(() => expect(api.saveSection).toHaveBeenCalledTimes(2));
    expect(api.saveSection.mock.calls[0][0].operationId).toEqual(
      api.saveSection.mock.calls[1][0].operationId,
    );
    page.unmount();
  });
});

it("empty replacement key keeps credentials when saving another field", async () => {
  api.saveSection.mockResolvedValue({ revision: 2 });
  render(
    <SectionEditor
      section="search"
      title="検索"
      revision={1}
      value={{ resultCount: 5 }}
      onSaved={async () => {}}
    >
      {(value, change, secrets, setSecrets) => (
        <>
          <Fields value={value} onChange={change} />
          <CredentialField
            label="検索認証"
            value={secrets.braveApiKey}
            onChange={(v) => setSecrets({ ...secrets, braveApiKey: v })}
          />
        </>
      )}
    </SectionEditor>,
  );
  fireEvent.change(screen.getByLabelText("検索認証の変更"), { target: { value: "set" } });
  fireEvent.change(screen.getByLabelText("検索結果の件数"), { target: { value: "6" } });
  fireEvent.click(screen.getByRole("button", { name: "検索を保存" }));
  await waitFor(() => expect(api.saveSection).toHaveBeenCalled());
  expect(api.saveSection.mock.calls[0][0].secrets.braveApiKey).toEqual({ action: "keep" });
});
