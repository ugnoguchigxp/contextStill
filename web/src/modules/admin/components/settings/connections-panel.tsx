import { Button } from "@/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { connectionLabels } from "../../../../../../src/modules/settings/connection-contracts";
import {
  type ConnectionRow,
  fetchConnectionRuntime,
  fetchConnections,
  removeConnection,
  startTest,
} from "../../repositories/admin/connections-api";
import {
  fetchCodexAuthStatus,
  fetchCodexLoginCommand,
} from "../../repositories/admin/settings-api";
import { ConnectionModal, errorText, testText } from "./connection-modal";

export function ConnectionsPanel({ onSaved }: { onSaved: () => Promise<void> }) {
  const cache = useQueryClient();
  const modalTrigger = useRef<HTMLElement | null>(null);
  const query = useQuery({
    queryKey: ["settings-connections"],
    queryFn: fetchConnections,
    refetchInterval: 5000,
  });
  const [selected, setSelected] = useState("");
  const [modal, setModal] = useState<ConnectionRow | "new" | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [codex, setCodex] = useState("");
  const rows = query.data?.connections ?? [];
  const row = rows.find((r) => r.id === selected) ?? rows[0];
  const runtime = useQuery({
    queryKey: ["settings-provider-runtime", row?.id],
    queryFn: () =>
      row ? fetchConnectionRuntime(row.id) : Promise.reject(new Error("connection_not_found")),
    enabled: Boolean(row),
    refetchInterval: 10_000,
  });
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["settings-connections"] });
    await cache.invalidateQueries({ queryKey: ["settings-provider-runtime"] });
    await onSaved();
  };
  const test = row ? query.data?.tests[row.id] : undefined;
  return (
    <section className="config-connections">
      <div className="config-section-heading">
        <div>
          <h2>設定済みプロバイダー</h2>
          <p>接続先とモデルを登録し、処理に割り当てます。</p>
        </div>
        <Button
          onClick={(event) => {
            modalTrigger.current = event.currentTarget;
            setError("");
            setModal("new");
          }}
        >
          ＋ プロバイダーを追加
        </Button>
      </div>
      {error || query.isError ? (
        <p role="alert" className="config-error">
          {error || errorText(query.error)}
        </p>
      ) : null}
      {query.isPending ? (
        <output>接続一覧を取得中…</output>
      ) : (
        <div className="config-table-scroll">
          <table className="config-provider-table">
            <thead>
              <tr>
                <th>プロバイダー / 名前</th>
                <th>モデル</th>
                <th>状態</th>
                <th>認証</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const result = query.data?.tests[r.id];
                const pending =
                  starting.includes(r.id) || ["running", "queued"].includes(result?.status ?? "");
                return (
                  <tr key={r.id} className={r.id === row?.id ? "selected" : ""}>
                    <td>
                      <button
                        type="button"
                        className="config-provider-select"
                        aria-pressed={r.id === row?.id}
                        onClick={() => {
                          setSelected(r.id);
                          setConfirmDelete(false);
                          setCodex("");
                        }}
                      >
                        <strong>{r.name}</strong>
                        <span>{connectionLabels[r.kind]}</span>
                      </button>
                    </td>
                    <td>
                      {r.model}
                      <small>{r.endpoint}</small>
                    </td>
                    <td>
                      <span className={`config-status ${result?.status ?? "unknown"}`}>
                        {r.enabled ? testText(result) : "無効"}
                      </span>
                    </td>
                    <td>
                      {r.kind === "codex"
                        ? "SDK認証"
                        : r.credential.configured
                          ? `登録済み · ${r.credential.source}`
                          : "未登録"}
                    </td>
                    <td>
                      <div className="config-row-actions">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => {
                            setError("");
                            setStarting((v) => [...v, r.id]);
                            void startTest(r.id)
                              .then(refresh)
                              .catch((e) => setError(errorText(e)))
                              .finally(() => setStarting((v) => v.filter((id) => id !== r.id)));
                          }}
                        >
                          {pending ? "確認中…" : "接続を確認"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            modalTrigger.current = event.currentTarget;
                            setModal(r);
                          }}
                        >
                          編集
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? (
            <p className="config-empty">
              登録された接続はありません。プロバイダーを追加してください。
            </p>
          ) : null}
        </div>
      )}
      {row ? (
        <div className="config-detail-grid">
          <article className="config-card">
            <h3>利用状況</h3>
            <dl>
              <dt>接続</dt>
              <dd>{row.name}</dd>
              <dt>モデル</dt>
              <dd>{runtime.data?.model ?? row.model}</dd>
              <dt>Endpoint</dt>
              <dd>{runtime.data?.endpoint ?? row.endpoint}</dd>
              <dt>確認時刻</dt>
              <dd>
                {runtime.data?.observedAt
                  ? new Date(runtime.data.observedAt).toLocaleString()
                  : "未取得"}
              </dd>
            </dl>
            {row.kind === "larm-agent-connection" ? (
              <>
                <dl>
                  <dt>Runtime</dt>
                  <dd>
                    {(
                      {
                        ready: "利用可能",
                        refreshing: "更新・準備待ち",
                        unconfirmed: "未確認",
                        unavailable: "状態を取得できません",
                      } as Record<string, string>
                    )[runtime.data?.status ?? ""] ?? "未確認"}
                  </dd>
                  <dt>Profile</dt>
                  <dd>contextStill → {runtime.data?.canonicalProfile ?? "未取得"}</dd>
                  <dt>同時処理</dt>
                  <dd>
                    {runtime.data?.capacity
                      ? `${runtime.data.activeRequests ?? 0} / ${runtime.data.capacity} 枠`
                      : "未確認（1枠として扱う）"}
                  </dd>
                  <dt>ProviderのContext Window</dt>
                  <dd>
                    {runtime.data?.contextWindow
                      ? runtime.data.contextWindow.maxTokens.toLocaleString()
                      : "未取得"}
                  </dd>
                  <dt>Finding・Coveringの実効Window</dt>
                  <dd>{runtime.data?.effectiveWindow?.maxTokens.toLocaleString() ?? "未取得"}</dd>
                  <dt>入力の概算上限（出力・余白を除く）</dt>
                  <dd>{runtime.data?.inputEstimateCeiling?.toLocaleString() ?? "未取得"}</dd>
                  <dt>Connection期限</dt>
                  <dd>{runtime.data?.expiresAt ?? "未取得"}</dd>
                </dl>
                {runtime.data?.reason ? (
                  <p className="config-muted">
                    {runtime.data.reason === "Ready"
                      ? "採用中のProviderから取得しています。"
                      : runtime.data.reason}
                  </p>
                ) : null}
                <p className="config-muted">
                  Queueで要求するProviderはLLMです。未確認の値を利用可能として扱いません。
                </p>
              </>
            ) : (
              <p className="config-muted">
                表示は保存済みの接続先です。利用可否はこの行の接続確認で調べます。
              </p>
            )}
            {row.kind === "codex" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    void Promise.all([fetchCodexAuthStatus(), fetchCodexLoginCommand()])
                      .then(([auth, login]) =>
                        setCodex(
                          auth.recommendedAction === "ready"
                            ? "ログイン済み"
                            : `ログイン手順: ${login.command}`,
                        ),
                      )
                      .catch((e) => setError(errorText(e)));
                  }}
                >
                  ログイン状態と手順
                </Button>
                <p>{codex}</p>
              </>
            ) : null}
          </article>
          <article className="config-card">
            <h3>処理への割り当て</h3>
            {row.references.length ? (
              <ul>
                {row.references.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p>この接続を参照する処理はありません。</p>
            )}
            <Link to="/setting/$section" params={{ section: "assignments" }}>
              割り当てを変更する →
            </Link>
          </article>
          <article className="config-card">
            <h3>直近の接続確認</h3>
            <p className={`config-status ${test?.status ?? "unknown"}`}>{testText(test)}</p>
            {test ? (
              <dl>
                <dt>確認方式</dt>
                <dd>{test.method}</dd>
                <dt>開始</dt>
                <dd>{new Date(test.startedAt).toLocaleString()}</dd>
                <dt>終了</dt>
                <dd>{test.finishedAt ? new Date(test.finishedAt).toLocaleString() : "実行中"}</dd>
                <dt>対象モデル</dt>
                <dd>{test.model ?? "取得中"}</dd>
              </dl>
            ) : (
              <p className="config-muted">一覧の「接続を確認」から、この接続だけを確認できます。</p>
            )}
            <p className="config-muted">入力中の設定のテストはここには反映されません。</p>
          </article>
        </div>
      ) : null}
      {row ? (
        <div className="config-delete">
          <Button
            variant="ghost"
            disabled={Boolean(row.references.length) || deleting}
            onClick={() => setConfirmDelete(true)}
          >
            この接続を削除
          </Button>
          {row.references.length ? (
            <span>削除する前に処理・Poolの参照を解除してください。</span>
          ) : null}
          {confirmDelete ? (
            <div role="alert">
              <p>{row.name} を削除します。</p>
              <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                戻る
              </Button>
              <Button
                variant="destructive"
                disabled={deleting}
                onClick={() => {
                  setDeleting(true);
                  void removeConnection(row.id, query.data?.revision ?? 0, crypto.randomUUID())
                    .then(async () => {
                      setConfirmDelete(false);
                      setSelected("");
                      await refresh();
                    })
                    .catch((e) => setError(errorText(e)))
                    .finally(() => setDeleting(false));
                }}
              >
                削除を確定
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {modal ? (
        <ConnectionModal
          returnFocus={modalTrigger.current ?? undefined}
          row={modal === "new" ? undefined : modal}
          revision={query.data?.revision ?? 0}
          existing={rows}
          onClose={() => setModal(null)}
          onSaved={async (id) => {
            setSelected(id);
            await refresh();
          }}
        />
      ) : null}
    </section>
  );
}
