import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { getRawTimezoneSetting, setTimezoneSetting, timezoneOptions } from "@/lib/timezone";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { runtimeSettingsEditableSchema } from "../../../../../../src/modules/settings/settings.types";
import { fetchAgentPolicy, fetchConnections } from "../../repositories/admin/connections-api";
import {
  fetchRuntimeSettings,
  reloadRuntimeSettingsCache,
} from "../../repositories/admin/settings-api";
import type {
  RuntimeProviderPool,
  RuntimeSettingsEditable,
} from "../../repositories/admin/settings-contracts";
import { errorText } from "./connection-modal";
import { ConnectionsPanel } from "./connections-panel";
import { PoolsEditor } from "./pools-editor";
import { AssignmentsEditor } from "./route-editor";
import { CredentialField, SectionEditor } from "./section-editor";
import { Fields } from "./settings-fields";
export const settingsTabs = [
  { path: "general", label: "一般" },
  { path: "connections", label: "接続とモデル" },
  { path: "assignments", label: "処理の割り当て" },
  { path: "execution", label: "並列処理と探索" },
  { path: "retrieval", label: "検索・埋め込み" },
  { path: "advanced", label: "詳細" },
];
export function SettingsPage() {
  const params = useParams({ strict: false }) as { section?: string };
  const tab = params.section ?? "general";
  const hash = useLocation({ select: (location) => location.hash });
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["runtime-settings"], queryFn: fetchRuntimeSettings });
  const connections = useQuery({ queryKey: ["settings-connections"], queryFn: fetchConnections });
  const policy = useQuery({
    queryKey: ["settings-agent-policy"],
    queryFn: fetchAgentPolicy,
    enabled: tab === "execution",
    retry: false,
  });
  useEffect(() => {
    if (!query.data || !hash) return;
    const frame = requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [query.data, hash]);
  const [timezone, setTimezone] = useState(getRawTimezoneSetting);
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(false);
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: ["runtime-settings"] });
    await cache.invalidateQueries({ queryKey: ["settings-connections"] });
  };
  let settings: RuntimeSettingsEditable | undefined;
  let parseError = "";
  if (query.data)
    try {
      settings = runtimeSettingsEditableSchema.parse(query.data.settings);
    } catch {
      parseError = "設定を読み取れませんでした。入力形式と接続の参照を確認してください。";
    }
  const revision = Math.max(query.data?.revision ?? 0, connections.data?.revision ?? 0);
  const rows = connections.data?.connections ?? [];
  const section = (
    name: keyof RuntimeSettingsEditable,
    title: string,
    children: Parameters<typeof SectionEditor>[0]["children"],
    value?: Record<string, unknown>,
  ) =>
    settings ? (
      <SectionEditor
        key={name}
        section={name as Parameters<typeof SectionEditor>[0]["section"]}
        title={title}
        value={value ?? (settings[name] as unknown as Record<string, unknown>)}
        revision={revision}
        onSaved={refresh}
      >
        {children}
      </SectionEditor>
    ) : null;
  return (
    <div className="config-page">
      <header className="config-page-header">
        <div>
          <h1>設定</h1>
          <p>接続先と処理の動きを管理</p>
        </div>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void refresh()}>
          状態を更新
        </Button>
      </header>
      <nav className="config-tabs" aria-label="設定タブ">
        {settingsTabs.map((t) => (
          <Link
            key={t.path}
            to="/setting/$section"
            params={{ section: t.path }}
            aria-current={t.path === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {query.isError || parseError ? (
        <p role="alert" className="config-error">
          {parseError || errorText(query.error)}
        </p>
      ) : null}
      {message ? <output>{message}</output> : null}
      {!settings && !query.isError && !parseError ? <output>設定を取得中…</output> : null}
      {settings ? (
        <div className="config-page-content">
          <div hidden={tab !== "connections"}>
            <ConnectionsPanel onSaved={refresh} />
          </div>
          <div hidden={tab !== "general"}>
            <>
              <section className="config-card">
                <h2>表示</h2>
                <label className="config-field">
                  <span>タイムゾーン</span>
                  <Select
                    value={timezone}
                    onChange={(e) => {
                      setTimezone(e.target.value);
                      setTimezoneSetting(e.target.value);
                      setMessage("表示タイムゾーンを変更しました");
                    }}
                  >
                    {timezoneOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </section>
              {section("general", "一般設定", (draft, change) => (
                <Fields value={draft} onChange={change} />
              ))}
            </>
          </div>
          <div hidden={tab !== "assignments"}>
            {section("taskRouting", "処理の割り当て", (draft, change) => (
              <AssignmentsEditor
                settings={{
                  ...settings,
                  taskRouting: draft as unknown as RuntimeSettingsEditable["taskRouting"],
                }}
                rows={rows}
                onChange={(v) => change(v as unknown as Record<string, unknown>)}
              />
            ))}{" "}
          </div>
          <div hidden={tab !== "execution"}>
            <>
              <section className="config-card">
                <h2>Finding・Coveringの探索予算</h2>
                {policy.data ? (
                  <>
                    <div className="config-policy-grid">
                      <div>
                        <span>Context Windowの上限</span>
                        <strong>{policy.data.windowCeiling.toLocaleString()}</strong>
                      </div>
                      <div>
                        <span>出力上限 / 最終化の予約</span>
                        <strong>
                          {policy.data.outputTokens.toLocaleString()} /{" "}
                          {policy.data.finalReserve.toLocaleString()}
                        </strong>
                      </div>
                      <div>
                        <span>1処理の目標 / 累積上限</span>
                        <strong>
                          {policy.data.runTarget.toLocaleString()} /{" "}
                          {policy.data.runHard.toLocaleString()}
                        </strong>
                      </div>
                      <div>
                        <span>DeepStill利用時の目標 / 上限</span>
                        <strong>
                          {policy.data.researchTarget.toLocaleString()} /{" "}
                          {policy.data.researchHard.toLocaleString()}
                        </strong>
                      </div>
                    </div>
                    <p>
                      LLMは最大{policy.data.maxCalls}回。進展が{policy.data.noGainLimit}
                      回ない場合、取得失敗が{policy.data.fetchFailureLimit}
                      回続いた場合は探索を打ち切ります。探索は最大{policy.data.explorationCalls}
                      回で最終確認へ移ります。DeepStillへの委譲は最大
                      {policy.data.maxDelegations}回です。
                    </p>
                    <p className="config-muted">
                      予算は実行中の共通ポリシーから取得しています。入力の見積もりはバイト数と余白による概算です。1回のContext
                      Windowと処理全体の累積予算は別に管理します。
                    </p>
                  </>
                ) : (
                  <p>
                    {policy.isError
                      ? "実行ポリシーを取得できません。residentの状態を確認してください。"
                      : "実行ポリシーを取得中…"}
                  </p>
                )}
              </section>
              {section("advanced", "探索とDeepStill", (draft, change, secrets, setSecrets) => {
                const agent = (draft.agentRuntime ?? { enabled: false }) as NonNullable<
                  RuntimeSettingsEditable["advanced"]["agentRuntime"]
                >;
                const research = agent.research;
                return (
                  <>
                    <Fields
                      value={agent as unknown as Record<string, unknown>}
                      exclude={["measurement", "research"]}
                      onChange={(v) => change({ ...draft, agentRuntime: { ...agent, ...v } })}
                    />
                    <label className="config-check">
                      <input
                        type="checkbox"
                        checked={Boolean(agent.research)}
                        onChange={(e) =>
                          change({
                            ...draft,
                            agentRuntime: {
                              ...agent,
                              research: e.target.checked
                                ? {
                                    baseUrl: "",
                                    gatewayUrl: "",
                                    credentialKey: "deepStillApiToken",
                                    gatewayCredentialKey: "deepStillGatewayToken",
                                  }
                                : null,
                            },
                          })
                        }
                      />
                      DeepStillで追加調査を行う
                    </label>
                    {agent.research ? (
                      <>
                        <Fields
                          value={agent.research}
                          onChange={(v) =>
                            change({ ...draft, agentRuntime: { ...agent, research: v } })
                          }
                        />
                        <CredentialField
                          label="DeepStill認証キー"
                          value={secrets[agent.research.credentialKey]}
                          onChange={(v) =>
                            setSecrets({ ...secrets, [research?.credentialKey ?? ""]: v })
                          }
                        />
                        <CredentialField
                          label="Gateway認証キー"
                          value={secrets[agent.research.gatewayCredentialKey]}
                          onChange={(v) =>
                            setSecrets({ ...secrets, [research?.gatewayCredentialKey ?? ""]: v })
                          }
                        />
                      </>
                    ) : null}
                    <h3>Queue開始間隔</h3>
                    <Fields
                      value={Object.fromEntries(
                        ["findingQueueTaskIntervalSeconds", "coveringQueueTaskIntervalSeconds"].map(
                          (k) => [k, draft[k]],
                        ),
                      )}
                      onChange={(v) => change({ ...draft, ...v })}
                    />
                  </>
                );
              })}
              {section("taskRouting", "Findingの実行間隔", (draft, change) => (
                <Fields
                  value={
                    (draft.findCandidate as Record<string, unknown>).throttling as Record<
                      string,
                      unknown
                    >
                  }
                  onChange={(v) =>
                    change({
                      ...draft,
                      findCandidate: { ...(draft.findCandidate as object), throttling: v },
                    })
                  }
                />
              ))}
              {section(
                "providerPools",
                "Provider Pool",
                (draft, change) => (
                  <PoolsEditor
                    settings={settings}
                    rows={rows}
                    pools={draft.value as RuntimeProviderPool[]}
                    onChange={(value) => change({ value })}
                  />
                ),
                { value: settings.providerPools },
              )}
              <section className="config-card">
                <h2>Poolの診断</h2>
                {query.data?.settings.diagnostics?.providerPools.length ? (
                  <ul>
                    {query.data?.settings.diagnostics.providerPools.map((d, i) => (
                      <li key={`${d.code}-${d.message}`}>{d.message}</li>
                    ))}
                  </ul>
                ) : (
                  <p>現在の設定にPoolの診断事項はありません。</p>
                )}
              </section>
            </>
          </div>
          <div hidden={tab !== "retrieval"}>
            <>
              {section("search", "検索", (draft, change, secrets, setSecrets) => (
                <>
                  <Fields value={draft} onChange={change} />
                  <div className="config-field-grid">
                    <CredentialField
                      label="Brave API Key"
                      configured={
                        query.data?.settings.search.providers.brave.apiKeySecret.configured
                      }
                      value={secrets.braveApiKey}
                      onChange={(v) => setSecrets({ ...secrets, braveApiKey: v })}
                    />
                    <CredentialField
                      label="Exa API Key"
                      configured={query.data?.settings.search.providers.exa.apiKeySecret.configured}
                      value={secrets.exaApiKey}
                      onChange={(v) => setSecrets({ ...secrets, exaApiKey: v })}
                    />
                  </div>
                </>
              ))}
              {section("embedding", "埋め込み", (draft, change) => (
                <Fields value={draft} onChange={change} prefix="embedding." />
              ))}
            </>
          </div>
          <div hidden={tab !== "advanced"}>
            <>
              {section("advanced", "詳細設定", (draft, change) => (
                <Fields
                  value={draft}
                  exclude={[
                    "agentRuntime",
                    "findingQueueTaskIntervalSeconds",
                    "coveringQueueTaskIntervalSeconds",
                  ]}
                  onChange={(v) => change({ ...draft, ...v })}
                />
              ))}
              {section("distillationRuntime", "従来の処理とツールの制限", (draft, change) => (
                <>
                  <p className="config-muted">
                    ここでの上限は従来の処理用です。Finding・Coveringの探索予算は「並列処理と探索」で確認できます。
                  </p>
                  <Fields value={draft} onChange={change} />
                </>
              ))}
              {section("taskRouting", "Compileの実行設定", (draft, change) => (
                <Fields
                  value={Object.fromEntries(
                    Object.entries(draft.agenticCompile as object).filter(([k]) =>
                      ["enabled", "timeoutMs", "maxTokens"].includes(k),
                    ),
                  )}
                  onChange={(v) =>
                    change({
                      ...draft,
                      agenticCompile: { ...(draft.agenticCompile as object), ...v },
                    })
                  }
                />
              ))}
              <section className="config-card">
                <h2>設定の再読み込み</h2>
                <p>保存済み設定をRuntimeへ読み直します。</p>
                <Button
                  variant="outline"
                  disabled={reload}
                  onClick={() => {
                    setReload(true);
                    void reloadRuntimeSettingsCache()
                      .then(async () => {
                        await refresh();
                        setMessage("Runtime設定を再読み込みしました");
                      })
                      .catch((e) => setMessage(errorText(e)))
                      .finally(() => setReload(false));
                  }}
                >
                  Runtime設定を再読み込み
                </Button>
              </section>
            </>
          </div>
        </div>
      ) : null}
    </div>
  );
}
