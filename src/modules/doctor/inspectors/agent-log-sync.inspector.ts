import { inArray } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { getDb } from "../../../db/index.js";
import { syncStates } from "../../../db/schema.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import {
  cursorFileCount,
  metadataSkipped,
  metadataSyncedAt,
  metadataWarnings,
  minutesSince,
} from "../doctor.utils.js";
import { inspectLaunchAgent, pathExists } from "../launch-agent.util.js";

type AgentLogSyncInspectorOptions = {
  canQueryDb: boolean;
  syncStatesTableAvailable: boolean;
};

export async function inspectAgentLogSync({
  canQueryDb,
  syncStatesTableAvailable,
}: AgentLogSyncInspectorOptions): Promise<DoctorReport["agentLogSync"]> {
  const codexSessionDirExists = await pathExists(groupedConfig.codex.sessionDir);
  const codexArchivedSessionDirExists = await pathExists(groupedConfig.codex.archivedSessionDir);
  const antigravityConfigured = groupedConfig.antigravity.logDir.trim().length > 0;
  const antigravityExists = antigravityConfigured
    ? await pathExists(groupedConfig.antigravity.logDir)
    : false;
  const launchAgent = await inspectLaunchAgent("com.memory-router.agent-log-sync");
  const states: DoctorReport["agentLogSync"]["states"] = [];

  if (canQueryDb && syncStatesTableAvailable) {
    try {
      const rows = await getDb()
        .select()
        .from(syncStates)
        .where(inArray(syncStates.id, ["codex_logs", "antigravity_logs"]));
      for (const row of rows) {
        const lastSyncedAt = row.lastSyncedAt?.toISOString() ?? null;
        const lastCheckedAt =
          metadataSyncedAt(row.metadata) ?? row.updatedAt?.toISOString() ?? null;
        states.push({
          id: row.id,
          lastSyncedAt,
          lastSyncedAgeMinutes: lastSyncedAt ? minutesSince(lastSyncedAt) : null,
          lastCheckedAt,
          lastCheckedAgeMinutes: lastCheckedAt ? minutesSince(lastCheckedAt) : null,
          cursorFiles: cursorFileCount(row.cursor),
          skipped: metadataSkipped(row.metadata),
          warnings: metadataWarnings(row.metadata),
        });
      }
    } catch {
      // Keep the doctor report structured even when DB query fails.
    }
  }

  const nextActions: string[] = [];
  if (!codexSessionDirExists) {
    nextActions.push("MEMORY_ROUTER_CODEX_SESSION_DIR を実在する Codex sessions root に設定する");
  }
  if (!antigravityConfigured) {
    nextActions.push("MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR に Antigravity workspace root を設定する");
  } else if (!antigravityExists) {
    nextActions.push("MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR のパスを確認する");
  }
  if (!states.some((state) => state.id === "codex_logs")) {
    nextActions.push("bun run sync:agent-logs を実行して Codex ログ同期を初期化する");
  }
  if (!launchAgent.installed) {
    nextActions.push("bun run automation:agent-log-sync -- install で LaunchAgent を配置する");
  } else if (!launchAgent.loaded) {
    nextActions.push("bun run automation:agent-log-sync -- load で LaunchAgent を読み込む");
  }

  return {
    codex: {
      sessionDir: groupedConfig.codex.sessionDir,
      sessionDirExists: codexSessionDirExists,
      archivedSessionDir: groupedConfig.codex.archivedSessionDir,
      archivedSessionDirExists: codexArchivedSessionDirExists,
    },
    antigravity: {
      logDir: groupedConfig.antigravity.logDir,
      configured: antigravityConfigured,
      exists: antigravityExists,
    },
    states,
    launchAgent,
    nextActions,
  };
}
