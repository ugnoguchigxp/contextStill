import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useId } from "react";

const labels: Record<string, string> = {
  enabled: "有効にする",
  apiBaseUrl: "Endpoint URL",
  apiPath: "APIパス",
  apiVersion: "APIバージョン",
  model: "モデル / Deployment名",
  name: "表示名",
  id: "接続ID",
  region: "AWSリージョン",
  profile: "AWSプロファイル",
  controlBaseUrl: "LARM制御URL",
  audience: "接続先区分",
  availabilityPollMs: "状態確認の間隔（ms）",
  availabilityTimeoutMs: "状態確認の制限時間（ms）",
  controlTimeoutMs: "制御APIの制限時間（ms）",
  readyTimeoutMs: "準備待ちの制限時間（ms）",
  ttlSeconds: "Connectionの期限（秒）",
  requestTimeoutMs: "推論の制限時間（ms）",
  maxConcurrentRequests: "同時リクエストの上限（1〜4）",
  distillationPriority: "処理の優先順位",
  targetPriorityOrder: "優先する情報源（上から順）",
  providerOrder: "検索サービスの優先順位",
  maxProviderAttempts: "検索サービスの試行上限",
  resultCount: "検索結果の件数",
  timeoutMs: "制限時間（ms）",
  rateLimitCooldownSeconds: "レート制限後の待機（秒）",
  providers: "検索サービス",
  brave: "Brave",
  exa: "Exa",
  duckduckgo: "DuckDuckGo",
  provider: "プロバイダー",
  daemonUrl: "埋め込みサービスURL",
  openaiModel: "OpenAI埋め込みモデル",
  backgroundEnabled: "バックグラウンド処理",
  interactiveWindowSeconds: "操作中とみなす期間（秒）",
  recentBlockSeconds: "操作直後の待機（秒）",
  minIntervalSeconds: "最短間隔（秒）",
  mediumIntervalSeconds: "通常時の間隔（秒）",
  busyIntervalSeconds: "混雑時の間隔（秒）",
  maxIntervalSeconds: "最大間隔（秒）",
  jitterSeconds: "間隔のばらつき（秒）",
  candidateTimeoutMs: "候補処理の制限時間（ms）",
  maxToolRounds: "ツール往復の上限",
  findCandidateTimeoutMs: "Findingの制限時間（ms）",
  findCandidateMaxToolCalls: "Findingのツール呼び出し上限",
  coverEvidenceTimeoutMs: "Coveringの制限時間（ms）",
  coverEvidenceSearchMaxCalls: "Coveringの検索上限",
  coverEvidenceFetchMaxCalls: "Coveringの取得上限",
  coverEvidenceFetchMaxTokensPerSite: "1サイトから取得する上限（トークン）",
  toolTimeoutMs: "ツールの制限時間（ms）",
  toolResultMaxChars: "ツール結果の上限（文字）",
  failureRetryDelaySeconds: "失敗後の待機（秒）",
  readerMaxReads: "読み取り回数の上限",
  readerMaxCharsPerRead: "1回の読み取り上限（文字）",
  llmContextWindowTokens: "従来の処理で使うContext Window",
  llmMaxInputTokens: "従来の処理の入力上限（トークン）",
  llmInputSafetyMarginTokens: "従来の処理の安全余白（トークン）",
  lowImportanceRejectThreshold: "低重要度の除外しきい値",
  pipelineLockStaleSeconds: "処理ロックの失効（秒）",
  lockTtlSeconds: "ロックの期限（秒）",
  pipelineClaimLimit: "1巡で取得する処理の上限",
  findingQueueTaskIntervalSeconds: "Findingの開始間隔（秒）",
  coveringQueueTaskIntervalSeconds: "Coveringの開始間隔（秒）",
  continuousIdleSleepMs: "待機中の休止（ms）",
  continuousErrorSleepMs: "エラー後の休止（ms）",
  inventoryRefreshIntervalMs: "一覧更新の間隔（ms）",
  doctorFreshnessThresholdMinutes: "診断の鮮度（分）",
  doctorDegradedRateThreshold: "劣化率のしきい値",
  doctorKnowledgeZeroUseWarningMinActiveCount: "未利用の警告対象数",
  codexLogSyncEnabled: "Codex / Cursorログ同期",
  antigravityLogSyncEnabled: "Antigravityログ同期",
  claudeLogSyncEnabled: "Claude Codeログ同期",
  agentRuntime: "Finding・Coveringの探索",
  research: "DeepStill",
  baseUrl: "DeepStill URL",
  credentialKey: "DeepStill認証の参照名",
  gatewayCredentialKey: "Gateway認証の参照名",
  gatewayUrl: "Gateway URL",
  maxTokens: "出力上限（トークン）",
  localLlmModel: "固定モデル",
  fallback: "失敗時のプロバイダー（順番）",
  azureDeploymentSlots: "Azure Deploymentの対象番号",
  maxConcurrent: "Poolの同時処理上限",
  staleLeaseSeconds: "実行枠の失効（秒）",
  lowPriorityAgingSeconds: "低優先度を引き上げる待機（秒）",
  label: "Pool名",
};
export function fieldLabel(key: string) {
  return labels[key] ?? key;
}
export function Fields({
  value,
  onChange,
  prefix = "",
  exclude = [],
  readOnly = [],
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  prefix?: string;
  exclude?: string[];
  readOnly?: string[];
}) {
  const formId = useId();
  return (
    <div className="config-field-grid">
      {Object.entries(value)
        .filter(([k]) => !exclude.includes(k))
        .map(([key, item]) => {
          const label = fieldLabel(key);
          const path = `${formId}-${prefix}${key}`;
          const update = (v: unknown) => onChange({ ...value, [key]: v });
          if (item !== null && typeof item === "object" && !Array.isArray(item))
            return (
              <fieldset key={key} className="config-subgroup">
                <legend>{label}</legend>
                <Fields
                  value={item as Record<string, unknown>}
                  onChange={update}
                  prefix={`${path}.`}
                  exclude={exclude}
                />
              </fieldset>
            );
          if (Array.isArray(item))
            return (
              <fieldset key={key} className="config-subgroup">
                <legend>{label}</legend>
                {item.map((entry, index) => (
                  <div className="config-order-row" key={String(entry)}>
                    <span>
                      {index + 1}. {String(entry)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      aria-label={`${label} ${entry} を上へ`}
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...item];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        update(next);
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      aria-label={`${label} ${entry} を下へ`}
                      disabled={index === item.length - 1}
                      onClick={() => {
                        const next = [...item];
                        [next[index + 1], next[index]] = [next[index], next[index + 1]];
                        update(next);
                      }}
                    >
                      ↓
                    </Button>
                  </div>
                ))}
                {key === "providerOrder" ? (
                  <>
                    {item.length > 1
                      ? item.map((entry) => (
                          <Button
                            key={String(entry)}
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => update(item.filter((v) => v !== entry))}
                          >
                            {fieldLabel(String(entry))} を外す
                          </Button>
                        ))
                      : null}
                    {["brave", "exa", "duckduckgo"]
                      .filter((v) => !item.includes(v))
                      .map((entry) => (
                        <Button
                          key={entry}
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => update([...item, entry])}
                        >
                          {fieldLabel(entry)} を追加
                        </Button>
                      ))}
                  </>
                ) : null}
              </fieldset>
            );
          if (typeof item === "boolean")
            return (
              <label key={key} className="config-check">
                <input
                  type="checkbox"
                  checked={item}
                  onChange={(e) => update(e.target.checked)}
                  disabled={readOnly.includes(key)}
                />
                {label}
              </label>
            );
          if (item === null || item === undefined) return null;
          const options =
            key === "provider" && prefix === "embedding."
              ? ["auto", "daemon", "openai", "disabled"]
              : key === "audience"
                ? ["same-host", "saaa-desktop"]
                : null;
          return (
            <label key={key} className="config-field" htmlFor={path}>
              <span>{label}</span>
              {options ? (
                <Select
                  id={path}
                  value={String(item)}
                  disabled={readOnly.includes(key)}
                  onChange={(e) => update(e.target.value)}
                >
                  {options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={path}
                  value={String(item)}
                  type={typeof item === "number" ? "number" : "text"}
                  step={typeof item === "number" && String(item).includes(".") ? "any" : undefined}
                  readOnly={readOnly.includes(key)}
                  onChange={(e) =>
                    update(typeof item === "number" ? Number(e.target.value) : e.target.value)
                  }
                />
              )}
            </label>
          );
        })}
    </div>
  );
}
export function objectDiff(base: unknown, value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
    const before = (base as Record<string, unknown>)?.[key];
    if (JSON.stringify(before) === JSON.stringify(next)) continue;
    result[key] =
      next &&
      typeof next === "object" &&
      ((next as Record<string, unknown>).kind === "larm-agent-connection" ||
        ("provider" in next && "fallback" in next))
        ? next
        : next &&
            before &&
            typeof next === "object" &&
            typeof before === "object" &&
            !Array.isArray(next) &&
            !Array.isArray(before)
          ? objectDiff(before, next)
          : next;
  }
  return result;
}
export function applyDiff(
  base: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const value = { ...base };
  for (const [key, next] of Object.entries(changes))
    value[key] =
      next && typeof next === "object" && !Array.isArray(next)
        ? applyDiff((value[key] ?? {}) as Record<string, unknown>, next as Record<string, unknown>)
        : next;
  return value;
}
export function conflicts(
  base: Record<string, unknown>,
  current: Record<string, unknown>,
  changes: Record<string, unknown>,
): boolean {
  return Object.entries(changes).some(([key, next]) =>
    next && typeof next === "object" && !Array.isArray(next)
      ? conflicts(
          (base[key] ?? {}) as Record<string, unknown>,
          (current[key] ?? {}) as Record<string, unknown>,
          next as Record<string, unknown>,
        )
      : JSON.stringify(base[key]) !== JSON.stringify(current[key]),
  );
}
