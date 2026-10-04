import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useState } from "react";
import type { ConnectionRow } from "../../repositories/admin/connections-api";
import type {
  RuntimeProviderPool,
  RuntimeSettingsEditable,
} from "../../repositories/admin/settings-contracts";
import { poolTarget, requireConnection } from "./route-editor";
import { Fields } from "./settings-fields";
export function PoolsEditor({
  settings,
  rows,
  pools,
  onChange,
}: {
  settings: RuntimeSettingsEditable;
  rows: ConnectionRow[];
  pools: RuntimeProviderPool[];
  onChange: (pools: RuntimeProviderPool[]) => void;
}) {
  const [error, setError] = useState("");
  const patch = (index: number, next: RuntimeProviderPool) =>
    onChange(pools.map((p, i) => (i === index ? next : p)));
  return (
    <div className="config-pools">
      <p className="config-muted">
        Poolの枠は固定プロバイダー向けです。LARMの実効枠はConnectionの提供容量で制限されます。
      </p>
      {error ? (
        <p role="alert" className="config-error">
          {error}
        </p>
      ) : null}
      {pools.map((pool, index) => (
        <article className="config-subgroup" key={pool.id}>
          <h3>{pool.label}</h3>
          <Fields
            value={pool as unknown as Record<string, unknown>}
            exclude={["targets"]}
            readOnly={["id"]}
            onChange={(v) => patch(index, v as unknown as RuntimeProviderPool)}
          />
          <fieldset>
            <legend>対象接続（上から順）</legend>
            {pool.targets.map((target, i) => {
              const row = rows.find(
                (r) => JSON.stringify(poolTarget(settings, r)) === JSON.stringify(target),
              );
              return (
                <div className="config-order-row" key={JSON.stringify(target)}>
                  <span>
                    {row?.name ??
                      (target.provider === "local-llm"
                        ? target.localLlmModelId
                        : target.provider === "azure-openai"
                          ? `Azure ${target.deploymentSlot}`
                          : target.provider === "larm-agent-connection"
                            ? target.connectionId
                            : target.targetId)}
                  </span>
                  {target.provider === "openai" ||
                  target.provider === "bedrock" ||
                  target.provider === "codex" ? (
                    <Fields
                      value={{ model: target.model ?? "" }}
                      onChange={(value) =>
                        patch(index, {
                          ...pool,
                          targets: pool.targets.map((entry, n) =>
                            n === i
                              ? {
                                  ...target,
                                  model:
                                    typeof value.model === "string" && value.model.trim()
                                      ? value.model.trim()
                                      : undefined,
                                }
                              : entry,
                          ),
                        })
                      }
                    />
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!i}
                    onClick={() => {
                      const t = [...pool.targets];
                      [t[i - 1], t[i]] = [t[i], t[i - 1]];
                      patch(index, { ...pool, targets: t });
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      patch(index, { ...pool, targets: pool.targets.filter((_, n) => n !== i) })
                    }
                  >
                    削除
                  </Button>
                </div>
              );
            })}
            <Select
              aria-label={`${pool.label} に接続を追加`}
              value=""
              onChange={(e) => {
                const target = poolTarget(settings, requireConnection(rows, e.target.value));
                if (!pool.targets.some((t) => JSON.stringify(t) === JSON.stringify(target)))
                  patch(index, { ...pool, targets: [...pool.targets, target] });
              }}
            >
              <option value="">接続を追加</option>
              {rows
                .filter((r) => r.enabled)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          </fieldset>
          <Button
            variant="ghost"
            onClick={() => {
              const used = JSON.stringify(settings.taskRouting).includes(
                `"providerPoolId":"${pool.id}"`,
              );
              if (used) {
                setError("処理の割り当てを解除してからPoolを削除してください。");
                return;
              }
              onChange(pools.filter((_, i) => i !== index));
            }}
          >
            Poolを削除
          </Button>
        </article>
      ))}
      <Button
        variant="outline"
        onClick={() =>
          onChange([
            ...pools,
            {
              id: `pool-${crypto.randomUUID().slice(0, 8)}`,
              label: "新しいPool",
              targets: [],
              maxConcurrent: 1,
              staleLeaseSeconds: 600,
              enabled: true,
              lowPriorityAgingSeconds: 1800,
            },
          ])
        }
      >
        ＋ Poolを追加
      </Button>
    </div>
  );
}
