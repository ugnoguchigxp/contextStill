import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
} from "../../../src/modules/settings/settings.service.js";

type Status =
  | "waiting-capacity"
  | "deploying"
  | "probing"
  | "ready"
  | "SAAA利用中のため待機"
  | "再接続中"
  | "terminal error";

type SavedState = { id: string | null; reason: string | null };

async function savedState(sqlitePath: string | null, suffix: string): Promise<SavedState> {
  const empty = { id: null, reason: null };
  if (!sqlitePath) return empty;
  const parsed = path.parse(sqlitePath);
  const filename = path.join(parsed.dir, `${parsed.name}.${suffix}.json`);
  try {
    const value: unknown = JSON.parse(await readFile(filename, "utf8"));
    if (!value || typeof value !== "object") return empty;
    const state = value as Record<string, unknown>;
    return {
      id: typeof state.id === "string" && /^[A-Za-z0-9._:-]+$/.test(state.id) ? state.id : null,
      reason: typeof state.reason === "string" ? state.reason : null,
    };
  } catch {
    return empty;
  }
}

async function larmJson(origin: string, pathName: string): Promise<Record<string, unknown> | null> {
  const token = process.env.LARM_API_TOKEN;
  if (!token) return null;
  try {
    const response = await fetch(new URL(pathName, origin), {
      headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function localHealth(origin: string): Promise<boolean> {
  try {
    const url = new URL(origin);
    if (!matchesLocalHost(url.hostname) || url.protocol !== "http:") return false;
    const response = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return Boolean(body && typeof body === "object" && "ready" in body && body.ready === true);
  } catch {
    return false;
  }
}

function matchesLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

async function connectionStatus(
  origin: string,
  saved: SavedState,
  provider: string,
): Promise<Status> {
  if (!saved.id) {
    if (saved.reason === "provider_conflict" && provider === "llm") return "SAAA利用中のため待機";
    if (saved.reason === "transport" || saved.reason === "foreground_preempted") return "再接続中";
    if (saved.reason && !["provider_conflict", "http"].includes(saved.reason))
      return "terminal error";
    return "waiting-capacity";
  }
  const connection = await larmJson(origin, `/v1/agent-connections/${saved.id}`);
  if (!connection) return "再接続中";
  if (connection.status === "pending") return "deploying";
  if (connection.status === "probing") return "probing";
  if (connection.status === "ready") {
    const providers = Array.isArray(connection.providers) ? connection.providers : [];
    const required = providers.find(
      (entry) => entry && typeof entry === "object" && "name" in entry && entry.name === provider,
    );
    return required &&
      typeof required === "object" &&
      "readiness" in required &&
      required.readiness === "ready" &&
      "claimable" in required &&
      required.claimable === true
      ? "ready"
      : "probing";
  }
  if (connection.status === "failed") {
    const error = connection.error;
    return error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "foreground_preempted"
      ? "再接続中"
      : "terminal error";
  }
  return "再接続中";
}

export async function getLarmStatuses() {
  await ensureRuntimeSettingsLoaded();
  const settings = getRuntimeSettingsSnapshot();
  const configured = settings.providers["larm-agent-connection"].connections[0];
  if (!settings.providers["larm-agent-connection"].enabled || !configured) {
    return {
      llm: "waiting-capacity" as Status,
      embedding: "waiting-capacity" as Status,
      llmSource: "-",
      embeddingSource: "-",
    };
  }
  const sqlitePath =
    resolveDatabaseBackendConfig().sqlitePath ?? process.env.CONTEXT_STILL_SQLITE_CORE_PATH ?? null;
  const [llmState, embeddingState] = await Promise.all([
    savedState(sqlitePath, `larm-${configured.id}`),
    savedState(sqlitePath, "larm-embedding"),
  ]);
  let [llm, embedding] = await Promise.all([
    connectionStatus(configured.controlBaseUrl, llmState, "llm"),
    connectionStatus(configured.controlBaseUrl, embeddingState, "embedding"),
  ]);
  let llmSource = "LARM";
  let embeddingSource = "LARM";
  if (llm === "再接続中") {
    const ornith = settings.providers["local-llm"].models.find((model) =>
      model.model.startsWith("ornith-"),
    );
    if (ornith && (await localHealth(ornith.apiBaseUrl))) {
      llm = "ready";
      llmSource = "Mac";
    }
  }
  if (embedding !== "ready" && embedding !== "terminal error") {
    const daemonUrl = settings.embedding.daemonUrl;
    if (await localHealth(daemonUrl)) {
      embedding = "ready";
      embeddingSource = "Mac";
    }
  }
  return { llm, embedding, llmSource, embeddingSource };
}
