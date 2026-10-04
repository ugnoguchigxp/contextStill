import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  type CredentialUpdate,
  type SectionPatch,
  fetchOperation,
  saveSection,
} from "../../repositories/admin/connections-api";
import { errorText } from "./connection-modal";
import { applyDiff, conflicts, objectDiff } from "./settings-fields";
export function SectionEditor({
  section,
  value,
  revision,
  title,
  onSaved,
  children,
}: {
  section: SectionPatch["section"];
  value: Record<string, unknown>;
  revision: number;
  title: string;
  onSaved: () => Promise<void>;
  children: (
    draft: Record<string, unknown>,
    change: (v: Record<string, unknown>) => void,
    secrets: Record<string, CredentialUpdate>,
    setSecrets: (v: Record<string, CredentialUpdate>) => void,
  ) => ReactNode;
}) {
  const [draft, setDraft] = useState(() => structuredClone(value));
  const [baseline, setBaseline] = useState(() => structuredClone(value));
  const [secrets, setSecrets] = useState<Record<string, CredentialUpdate>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const operation = useRef(crypto.randomUUID());
  const changes = objectDiff(baseline, draft);
  const dirty =
    Object.keys(changes).length > 0 ||
    Object.values(secrets).some(
      (s) => s.action !== "keep" && (s.action !== "set" || Boolean(s.value?.trim())),
    );
  const conflict = conflicts(baseline, value, changes);
  useEffect(() => {
    if (!dirty) {
      setDraft(structuredClone(value));
      setBaseline(structuredClone(value));
    }
  }, [value, dirty]);
  const edit = (next: Record<string, unknown>) => {
    setDraft(next);
    operation.current = crypto.randomUUID();
    setError("");
    setMessage("");
  };
  const editSecrets = (next: Record<string, CredentialUpdate>) => {
    setSecrets(next);
    operation.current = crypto.randomUUID();
    setError("");
    setMessage("");
  };
  return (
    <section
      id={["providerPools", "search", "embedding"].includes(section) ? section : undefined}
      className="config-card config-section-editor"
    >
      <h2>{title}</h2>
      {error ? (
        <p role="alert" className="config-error">
          {error}
        </p>
      ) : null}
      {message ? <output className="config-success">{message}</output> : null}
      {conflict ? (
        <div role="alert" className="config-notice">
          変更した項目が別の保存でも更新されています。最新の値を確認してから適用してください。
          <Button
            variant="outline"
            onClick={() => {
              setBaseline(structuredClone(value));
              setDraft(applyDiff(value, changes));
              operation.current = crypto.randomUUID();
            }}
          >
            最新の設定に変更を重ねる
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(structuredClone(value));
              setBaseline(structuredClone(value));
              setSecrets({});
            }}
          >
            最新の値に戻す
          </Button>
        </div>
      ) : null}
      <fieldset disabled={busy}>{children(draft, edit, secrets, editSecrets)}</fieldset>
      <div className="config-section-footer">
        <Button
          disabled={!dirty || busy || conflict}
          onClick={() => {
            setBusy(true);
            setError("");
            setMessage("");
            const input = {
              section,
              changes,
              expectedRevision: revision,
              operationId: operation.current,
              secrets: Object.fromEntries(
                Object.entries(secrets).map(([key, update]) => [
                  key,
                  update.action === "set" && !update.value?.trim()
                    ? { action: "keep" as const }
                    : update,
                ]),
              ),
            };
            void (async () => {
              try {
                try {
                  await saveSection(input);
                } catch (e) {
                  try {
                    await fetchOperation(operation.current);
                  } catch {
                    throw e;
                  }
                }
                setBaseline(structuredClone(draft));
                setSecrets({});
                await onSaved();
                setMessage("保存しました");
                operation.current = crypto.randomUUID();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? "保存中…" : `${title}を保存`}
        </Button>
        <Button
          variant="ghost"
          disabled={!dirty || busy}
          onClick={() => {
            setDraft(structuredClone(value));
            setBaseline(structuredClone(value));
            setSecrets({});
            setError("");
            setMessage("");
          }}
        >
          変更を取り消す
        </Button>
      </div>
    </section>
  );
}
export function CredentialField({
  label,
  value,
  onChange,
  configured,
}: {
  label: string;
  value?: CredentialUpdate;
  onChange: (value: CredentialUpdate) => void;
  configured?: boolean;
}) {
  const current = value ?? { action: "keep" };
  return (
    <fieldset className="config-subgroup">
      <legend>{label}</legend>
      <p className="config-muted">
        {configured === undefined
          ? "空欄では現在の認証を保持します。"
          : configured
            ? "登録済み"
            : "未登録"}
      </p>
      <Select
        aria-label={`${label}の変更`}
        value={current.action}
        onChange={(e) => onChange({ action: e.target.value as CredentialUpdate["action"] })}
      >
        <option value="keep">現在の認証を保持</option>
        <option value="set">認証キーを更新</option>
        <option value="clear">認証キーを削除</option>
        <option value="environment">環境設定を利用</option>
      </Select>
      {current.action === "set" ? (
        <Input
          aria-label={label}
          type="password"
          autoComplete="new-password"
          value={current.value ?? ""}
          onChange={(e) => onChange({ action: "set", value: e.target.value })}
        />
      ) : null}
    </fieldset>
  );
}
