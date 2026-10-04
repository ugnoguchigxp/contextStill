import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useState } from "react";
import {
  localConnectionModel,
  routeEntries,
  setRoute,
} from "../../../../../../src/modules/settings/connection-contracts";
import type { ConnectionRow } from "../../repositories/admin/connections-api";
import type {
  RuntimeProviderPoolTarget,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "../../repositories/admin/settings-contracts";
export const routeLabels: Record<string, string> = {
  "findCandidate.source": "Finding · Source",
  "findCandidate.vibe": "Finding · Vibe Memory",
  "coverEvidence.sourceSupport": "Covering · Source Support",
  "coverEvidence.externalEvidence": "Covering · External Evidence",
  "coverEvidence.mcpEvidence": "Covering · MCP Evidence",
  webSourceResearch: "Web Source Research",
  deepStillManual: "DeepStill · 手動Research",
  episodeDistiller: "Episode Distiller",
  deadZoneMergeReview: "Merge Review",
  landscapeCuration: "Landscape Curation",
  finalizeDistille: "Finalize Distillation",
  mergeActivationFinalize: "Merge Activation",
  agenticCompile: "Context Compile",
};
const staticProviders = ["openai", "azure-openai", "bedrock", "local-llm", "codex"] as const;
export function routeWithProviderPool(
  _route: RuntimeSettingsRoute,
  id: string | undefined,
): RuntimeSettingsRoute {
  return id
    ? { provider: "auto", providerPoolId: id, fallback: [] }
    : { provider: "auto", fallback: [] };
}
export function requireConnection(rows: ConnectionRow[], id: string): ConnectionRow {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error("接続が見つかりません。一覧を更新してください。");
  return row;
}
export const localRouteValue = localConnectionModel;
export function routeForConnection(
  settings: RuntimeSettingsEditable,
  row: ConnectionRow,
): RuntimeSettingsRoute {
  if (row.kind === "larm-agent-connection")
    return { kind: "larm-agent-connection", connectionId: row.id };
  if (row.kind === "azure-openai")
    return {
      provider: row.kind,
      model: row.model,
      azureDeploymentSlots: [
        settings.providers[row.kind].deployments.findIndex((d) => d.id === row.id) + 1,
      ],
      fallback: [],
    };
  if (row.kind === "local-llm")
    return {
      provider: row.kind,
      model: localRouteValue(row),
      localLlmModel: localRouteValue(row),
      fallback: [],
    };
  return { provider: row.kind, model: row.model, fallback: [] };
}
export function selectedRoute(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
  rows: ConnectionRow[],
): string {
  if (route.kind === "larm-agent-connection") return route.connectionId;
  if (route.providerPoolId) return `pool:${route.providerPoolId}`;
  if (route.provider === "auto") return "auto";
  if (route.provider === "azure-openai")
    return (
      settings.providers["azure-openai"].deployments[(route.azureDeploymentSlots?.[0] ?? 1) - 1]
        ?.id ?? "custom"
    );
  if (route.provider === "local-llm") {
    const v = route.localLlmModel ?? route.model;
    let parsed: Record<string, string> | null = null;
    try {
      parsed = JSON.parse(v ?? "");
    } catch {}
    return (
      rows.find(
        (r) =>
          r.kind === "local-llm" &&
          (parsed
            ? parsed.model === r.model &&
              parsed.apiBaseUrl.replace(/\/+$/, "") === r.endpoint.replace(/\/+$/, "")
            : r.model === v),
      )?.id ?? "custom"
    );
  }
  return rows.find((r) => r.kind === route.provider)?.id ?? "custom";
}
export function AssignmentsEditor({
  settings,
  rows,
  onChange,
}: {
  settings: RuntimeSettingsEditable;
  rows: ConnectionRow[];
  onChange: (value: RuntimeSettingsEditable["taskRouting"]) => void;
}) {
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const update = (path: string, route: RuntimeSettingsRoute) => {
    const next = structuredClone(settings);
    setRoute(next, path, route);
    onChange(next.taskRouting);
  };
  return (
    <div className="config-route-list">
      <p className="config-muted">
        各処理の割り当ては独立しています。Finding・Coveringの別処理は変更されません。
      </p>
      {routeEntries(settings).map(([path, route]) => (
        <article className="config-route-card" key={path}>
          <h3>{routeLabels[path]}</h3>
          {path.startsWith("findCandidate.") || path.startsWith("coverEvidence.") ? (
            <>
              <Button variant="outline" size="sm" type="button" onClick={() => setCopyFrom(path)}>
                同じ種類の処理へコピー
              </Button>
              {copyFrom === path ? (
                <div className="config-subgroup">
                  <p>次の割り当てを変更します。保存前に各行で確認できます。</p>
                  <ul>
                    {routeEntries(settings)
                      .filter(
                        ([other]) => other !== path && other.split(".")[0] === path.split(".")[0],
                      )
                      .map(([other, before]) => (
                        <li key={other}>
                          {routeLabels[other]}：
                          {before.kind === "larm-agent-connection"
                            ? before.connectionId
                            : (before.providerPoolId ?? before.model ?? before.provider)}{" "}
                          →{" "}
                          {route.kind === "larm-agent-connection"
                            ? route.connectionId
                            : (route.providerPoolId ?? route.model ?? route.provider)}
                        </li>
                      ))}
                  </ul>
                  <Button
                    type="button"
                    onClick={() => {
                      const next = structuredClone(settings);
                      for (const [other] of routeEntries(next))
                        if (other !== path && other.split(".")[0] === path.split(".")[0])
                          setRoute(next, other, structuredClone(route));
                      onChange(next.taskRouting);
                      setCopyFrom(null);
                    }}
                  >
                    表示した処理へ適用
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setCopyFrom(null)}>
                    戻る
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
          <label className="config-field">
            <span>接続 / Pool</span>
            <Select
              value={selectedRoute(settings, route, rows)}
              aria-label={`${routeLabels[path]} の接続`}
              onChange={(e) => {
                const v = e.target.value;
                update(
                  path,
                  v === "auto"
                    ? {
                        provider: path === "agenticCompile" ? "openai" : "auto",
                        model: settings.providers.openai.model,
                        fallback: [],
                      }
                    : v.startsWith("pool:")
                      ? routeWithProviderPool(route, v.slice(5))
                      : routeForConnection(settings, requireConnection(rows, v)),
                );
              }}
            >
              {path !== "agenticCompile" ? <option value="auto">自動選択</option> : null}
              <option value="custom" disabled>
                現在の設定（個別指定）
              </option>
              {rows
                .filter((r) => path !== "agenticCompile" || r.kind !== "larm-agent-connection")
                .map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.enabled}>
                    {r.name} · {r.model}
                  </option>
                ))}
              {path !== "agenticCompile"
                ? settings.providerPools.map((p) => (
                    <option key={p.id} value={`pool:${p.id}`} disabled={!p.enabled}>
                      Pool · {p.label}
                    </option>
                  ))
                : null}
            </Select>
          </label>
          {route.kind !== "larm-agent-connection" && !route.providerPoolId ? (
            <details>
              <summary>個別のモデル・失敗時の接続</summary>
              <label className="config-field">
                <span>モデルの指定</span>
                <Input
                  value={
                    route.provider === "local-llm"
                      ? (rows.find(
                          (r) => r.kind === "local-llm" && localRouteValue(r) === route.model,
                        )?.model ??
                        route.model ??
                        "")
                      : (route.model ?? "")
                  }
                  readOnly={route.provider === "local-llm" || route.provider === "azure-openai"}
                  onChange={(e) => update(path, { ...route, model: e.target.value || undefined })}
                />
              </label>
              <label className="config-field">
                <span>Local LLMの対象（任意）</span>
                <Select
                  value={
                    rows.find(
                      (r) =>
                        r.kind === "local-llm" &&
                        (localRouteValue(r) === route.localLlmModel ||
                          r.model === route.localLlmModel),
                    )?.id ?? ""
                  }
                  onChange={(e) =>
                    update(path, {
                      ...route,
                      localLlmModel: e.target.value
                        ? localRouteValue(requireConnection(rows, e.target.value))
                        : undefined,
                    })
                  }
                >
                  <option value="">既定のモデル</option>
                  {rows
                    .filter((r) => r.kind === "local-llm")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="config-field">
                <span>Azureの対象（複数可）</span>
                <Input
                  value={route.azureDeploymentSlots?.join(",") ?? ""}
                  placeholder="例: 1,2"
                  onChange={(e) =>
                    update(path, {
                      ...route,
                      azureDeploymentSlots: e.target.value.trim()
                        ? e.target.value.split(",").map(Number)
                        : undefined,
                    })
                  }
                />
              </label>
              <fieldset>
                <legend>失敗時のプロバイダー（上から順）</legend>
                {route.fallback.map((p, i) => (
                  <div className="config-order-row" key={p}>
                    <span>{p}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!i}
                      onClick={() => {
                        const f = [...route.fallback];
                        [f[i - 1], f[i]] = [f[i], f[i - 1]];
                        update(path, { ...route, fallback: f });
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update(path, {
                          ...route,
                          fallback: route.fallback.filter((_, n) => n !== i),
                        })
                      }
                    >
                      削除
                    </Button>
                  </div>
                ))}
                <Select
                  aria-label={`${routeLabels[path]} の失敗時プロバイダーを追加`}
                  value=""
                  onChange={(e) =>
                    update(path, {
                      ...route,
                      fallback: [
                        ...route.fallback,
                        e.target.value as (typeof staticProviders)[number],
                      ],
                    })
                  }
                >
                  <option value="">追加する接続の種類</option>
                  {staticProviders
                    .filter((p) => !route.fallback.includes(p))
                    .map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                </Select>
              </fieldset>
            </details>
          ) : null}
          {path === "agenticCompile" ? (
            <p className="config-muted">
              Compileの有効・制限時間・出力上限は「詳細」から変更します。
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}
export function poolTarget(
  settings: RuntimeSettingsEditable,
  row: ConnectionRow,
): RuntimeProviderPoolTarget {
  if (row.kind === "larm-agent-connection") return { provider: row.kind, connectionId: row.id };
  if (row.kind === "local-llm") return { provider: row.kind, localLlmModelId: row.id };
  if (row.kind === "azure-openai")
    return {
      provider: row.kind,
      deploymentSlot:
        settings.providers[row.kind].deployments.findIndex((d) => d.id === row.id) + 1,
    };
  return { provider: row.kind, targetId: row.id, model: row.model };
}
