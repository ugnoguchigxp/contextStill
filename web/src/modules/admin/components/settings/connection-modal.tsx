import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  connectionKinds,
  connectionLabels,
} from "../../../../../../src/modules/settings/connection-contracts";
import {
  type ConnectionKind,
  type ConnectionRow,
  type CredentialUpdate,
  type ProviderTestResult,
  cancelTest,
  fetchOperation,
  fetchTest,
  saveConnection,
  startTest,
} from "../../repositories/admin/connections-api";
import { Fields } from "./settings-fields";

export const connectionDefaults: Record<
  ConnectionKind,
  Record<string, string | number | boolean>
> = {
  openai: { enabled: true, apiBaseUrl: "https://api.openai.com/v1", model: "" },
  "azure-openai": {
    enabled: true,
    name: "",
    apiBaseUrl: "",
    apiPath: "/openai/deployments",
    apiVersion: "2024-10-21",
    model: "",
  },
  bedrock: { enabled: true, region: "us-east-1", profile: "", model: "" },
  "local-llm": {
    enabled: true,
    name: "",
    apiBaseUrl: "",
    apiPath: "/v1/chat/completions",
    model: "",
  },
  "larm-agent-connection": {
    enabled: true,
    id: "",
    controlBaseUrl: "",
    audience: "saaa-desktop",
    availabilityPollMs: 5000,
    availabilityTimeoutMs: 2000,
    controlTimeoutMs: 5000,
    readyTimeoutMs: 180000,
    ttlSeconds: 900,
    requestTimeoutMs: 300000,
    maxConcurrentRequests: 4,
  },
  codex: { enabled: true, model: "codex-sdk-agent" },
};
export function testText(result?: ProviderTestResult) {
  if (!result) return "未確認";
  return {
    queued: "確認待ち",
    running: "確認中",
    success: "接続確認済み",
    failed: result.error ?? "接続を確認できません",
    cancelled: "取消済み",
    stale: "設定変更前の結果",
  }[result.status];
}
export function errorText(error: unknown): string {
  const e = error as {
    payload?: { error?: { issues?: Array<{ path: string; message: string }>; code?: string } };
    message?: string;
  };
  const detail = e?.payload?.error;
  if (detail?.issues?.length)
    return detail.issues.map((i) => `${i.path}: ${i.message}`).join(" / ");
  if (detail?.code === "settings_revision_conflict")
    return "設定が変更されました。最新の設定を取得して、変更箇所を確認してください。";
  return e?.message ?? "処理を完了できませんでした";
}
export function ConnectionModal({
  row,
  returnFocus,
  revision,
  existing,
  onClose,
  onSaved,
}: {
  row?: ConnectionRow;
  returnFocus?: HTMLElement;
  revision: number;
  existing: ConnectionRow[];
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [kind, setKind] = useState<ConnectionKind>(row?.kind ?? "azure-openai");
  const [fields, setFields] = useState(() =>
    row
      ? Object.fromEntries(
          Object.entries(row.fields).filter(
            ([k]) => k !== "credentialMode" && (row.kind === "larm-agent-connection" || k !== "id"),
          ),
        )
      : connectionDefaults["azure-openai"],
  );
  const [credential, setCredential] = useState<CredentialUpdate>({ action: "keep" });
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<ProviderTestResult>();
  const [testSubmitting, setTestSubmitting] = useState(false);
  const active = useRef(true);
  const testing = testSubmitting || test?.status === "running" || test?.status === "queued";
  useEffect(() => {
    active.current = true;
    trigger.current = returnFocus ?? (document.activeElement as HTMLElement);
    if (dialog.current?.showModal) dialog.current.showModal();
    else dialog.current?.setAttribute("open", "");
    return () => {
      active.current = false;
      const origin = trigger.current;
      dialog.current?.close?.();
      queueMicrotask(() => origin?.focus());
    };
  }, [returnFocus]);
  const testId = test?.id;
  useEffect(() => {
    if (!testing || !testId) return;
    let disposed = false;
    const timer = setInterval(() => {
      void fetchTest(testId)
        .then((value) => {
          if (!disposed) setTest(value);
        })
        .catch((e) => {
          if (!disposed) {
            setError(errorText(e));
          }
        });
    }, 500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [testId, testing]);
  const editFields = (value: Record<string, unknown>) => {
    setFields(value as typeof fields);
    setOperationId(crypto.randomUUID());
    setTest(undefined);
    setError("");
  };
  const close = () => {
    if (busy) return;
    if (testing && test) void cancelTest(test.id);
    onClose();
  };
  const input = () => ({
    kind,
    fields,
    credential:
      credential.action === "set" && !credential.value?.trim()
        ? { action: "keep" as const }
        : credential,
    expectedRevision,
    operationId,
  });
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      let result: Awaited<ReturnType<typeof fetchOperation>>;
      try {
        result = await saveConnection(input(), row?.id);
      } catch (e) {
        try {
          result = await fetchOperation(operationId);
        } catch {
          throw e;
        }
      }
      if (result.value.id) {
        await onSaved(result.value.id);
        onClose();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const supportsKey = kind !== "bedrock" && kind !== "codex";
  return createPortal(
    <dialog
      ref={dialog}
      className="config-dialog"
      aria-labelledby="connection-modal-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header>
          <div>
            <h2 id="connection-modal-title">{row ? "プロバイダーを編集" : "プロバイダーを登録"}</h2>
            <p>この接続の設定だけを保存します。</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            disabled={busy}
            aria-label="モーダルを閉じる"
          >
            ×
          </Button>
        </header>
        <div className="config-dialog-body">
          {error ? (
            <p role="alert" className="config-error">
              {error}
            </p>
          ) : null}
          {expectedRevision !== revision ? (
            <div className="config-notice">
              最新の設定が取得されました。変更する項目を確認してください。
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setExpectedRevision(revision);
                  setOperationId(crypto.randomUUID());
                  setError("");
                }}
              >
                最新の設定に合わせる
              </Button>
            </div>
          ) : null}
          <fieldset disabled={busy || testing}>
            <label className="config-field">
              <span>種類</span>
              <Select
                value={kind}
                disabled={Boolean(row)}
                onChange={(e) => {
                  const k = e.target.value as ConnectionKind;
                  setKind(k);
                  setFields({ ...connectionDefaults[k] });
                  setCredential({ action: "keep" });
                  setOperationId(crypto.randomUUID());
                  setTest(undefined);
                }}
              >
                {connectionKinds.map((k) => (
                  <option
                    key={k}
                    value={k}
                    disabled={
                      !row &&
                      ["openai", "bedrock", "codex"].includes(k) &&
                      existing.some((r) => r.kind === k)
                    }
                  >
                    {connectionLabels[k]}
                  </option>
                ))}
              </Select>
            </label>
            <p className="config-notice">
              有効・無効の切り替えは、同じ種類の接続すべてに適用されます。
            </p>
            <Fields
              value={fields}
              onChange={editFields}
              readOnly={row && kind === "larm-agent-connection" ? ["id"] : []}
            />
            {kind === "larm-agent-connection" ? (
              <p className="config-notice">
                contextStillプロファイルのLLMを要求します。実効並列数はLARMの提供枠と指定上限の小さい方です。状態が未確認のときは1枠で扱います。
              </p>
            ) : null}
            {supportsKey ? (
              <fieldset className="config-subgroup">
                <legend>認証</legend>
                <p>
                  {row?.credential.configured ? `登録済み（${row.credential.source}）` : "未登録"} ·
                  空欄では現在の認証を保持します。
                </p>
                <label className="config-field">
                  <span>認証の変更</span>
                  <Select
                    value={credential.action}
                    onChange={(e) => {
                      setCredential({ action: e.target.value as CredentialUpdate["action"] });
                      setOperationId(crypto.randomUUID());
                      setTest(undefined);
                    }}
                  >
                    <option value="keep">現在の認証を保持</option>
                    <option value="set">新しい認証キーを登録</option>
                    <option value="clear">認証キーを削除</option>
                    <option value="environment">環境設定を利用</option>
                    {kind === "azure-openai" &&
                    existing.some((r) => r.kind === "azure-openai") &&
                    row?.credentialKey !== "azureOpenAiApiKey" ? (
                      <option value="inherit">最初のAzure接続のキーを共有</option>
                    ) : null}
                  </Select>
                </label>
                {credential.action === "set" ? (
                  <label className="config-field">
                    <span>認証キー</span>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={credential.value ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setCredential({ action: "set", value });
                        setOperationId(crypto.randomUUID());
                        setTest(undefined);
                      }}
                    />
                  </label>
                ) : null}
              </fieldset>
            ) : (
              <p className="config-notice">
                {kind === "bedrock"
                  ? "認証はAWSの環境設定・プロファイルを利用します。"
                  : "認証はCodex SDKのログイン状態を利用します。接続一覧からログイン手順を確認できます。"}
              </p>
            )}
          </fieldset>
          {test ? (
            <output className="config-test-result">
              <strong>入力中の設定の確認</strong>
              <p>{testText(test)}</p>
              {test.finishedAt ? <time>{new Date(test.finishedAt).toLocaleString()}</time> : null}
            </output>
          ) : null}
        </div>
        <footer>
          <Button
            type="button"
            variant="outline"
            disabled={busy || testing}
            onClick={() => {
              setError("");
              setTestSubmitting(true);
              void startTest(row?.id, input())
                .then(setTest)
                .catch((e) => setError(errorText(e)))
                .finally(() => setTestSubmitting(false));
            }}
          >
            入力中の設定を確認
          </Button>
          <span />
          <Button type="button" variant="outline" onClick={close} disabled={busy}>
            キャンセル
          </Button>
          <Button type="submit" disabled={busy || testing}>
            {busy ? "保存中…" : row ? "変更を保存" : "登録"}
          </Button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
