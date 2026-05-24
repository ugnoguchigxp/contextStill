import { and, eq } from "drizzle-orm";
import { APP_CONSTANTS } from "../../../constants.js";
import { db } from "../../../db/index.js";
import { distillationTargetStates } from "../../../db/schema.js";
import { validateFetchContentUrl } from "../../distillation/distillation-tools.service.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
  getDistillationTargetStateById,
  requeueDistillationTargetState,
  updateDistillationTargetSource,
  upsertDistillationTargetState,
} from "../../selectDistillationTarget/repository.js";

export type WebSourceQueueItem = {
  url: string;
  normalizedUrl: string;
  state: DistillationTargetStateRow;
  existing: boolean;
};

export type QueueWebSourceResult =
  | { ok: true; item: WebSourceQueueItem }
  | { ok: false; url: string; reason: string };

function normalizeWebUrl(raw: string): { url: string; normalizedUrl: string } {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("protocol must be http or https");
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  if (!parsed.pathname) parsed.pathname = "/";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return {
    url: raw.trim(),
    normalizedUrl: parsed.toString(),
  };
}

async function findExistingWebIngestTarget(params: {
  normalizedUrl: string;
  distillationVersion: string;
}): Promise<DistillationTargetStateRow | null> {
  const [row] = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.targetKind, "web_ingest"),
        eq(distillationTargetStates.targetKey, params.normalizedUrl),
        eq(distillationTargetStates.distillationVersion, params.distillationVersion),
      ),
    )
    .limit(1);
  return row ?? null;
}

function shouldResetExistingWebIngest(status: string): boolean {
  return status === "completed" || status === "skipped" || status === "failed";
}

export async function queueWebSourceUrl(params: {
  url: string;
  distillationVersion?: string;
}): Promise<QueueWebSourceResult> {
  let normalized: { url: string; normalizedUrl: string };
  try {
    normalized = normalizeWebUrl(params.url);
  } catch (error) {
    return {
      ok: false,
      url: params.url,
      reason: error instanceof Error ? error.message : "invalid url",
    };
  }
  const safety = validateFetchContentUrl(normalized.normalizedUrl);
  if (!safety.safe) {
    return {
      ok: false,
      url: params.url,
      reason: safety.reason,
    };
  }

  const distillationVersion = params.distillationVersion ?? DEFAULT_DISTILLATION_TARGET_VERSION;
  const existing = await findExistingWebIngestTarget({
    normalizedUrl: normalized.normalizedUrl,
    distillationVersion,
  });

  let state = await upsertDistillationTargetState({
    candidate: {
      targetKind: "web_ingest",
      targetKey: normalized.normalizedUrl,
      sourceUri: normalized.normalizedUrl,
      status: "pending",
      sortKey: normalized.normalizedUrl.toLowerCase(),
    },
    distillationVersion,
    metadata: {
      sourceType: "web_research",
      sourceUrl: normalized.url,
      normalizedUrl: normalized.normalizedUrl,
      importedVia: "sources.webIngest",
      registeredAt: new Date().toISOString(),
    },
  });

  if (existing && shouldResetExistingWebIngest(existing.status)) {
    const resetReason = "web_source_requeued";
    const requeued = await requeueDistillationTargetState({
      id: existing.id,
      reason: resetReason,
      allowCompleted: true,
    });
    if (requeued) state = requeued;
    await updateDistillationTargetSource({
      id: existing.id,
      sourceUri: normalized.normalizedUrl,
      metadata: {
        sourceType: "web_research",
        sourceUrl: normalized.url,
        normalizedUrl: normalized.normalizedUrl,
        importedVia: "sources.webIngest",
        registeredAt: new Date().toISOString(),
        savedWikiSlug: null,
        savedWikiTargetKey: null,
        savedWikiPath: null,
        researchGeneratedAt: null,
        llmProvider: null,
        llmModel: null,
        fetchFinalUrl: null,
      },
    });
    const refreshed = await getDistillationTargetStateById(existing.id);
    if (refreshed) state = refreshed;
  }

  return {
    ok: true,
    item: {
      url: normalized.url,
      normalizedUrl: normalized.normalizedUrl,
      state,
      existing: Boolean(existing),
    },
  };
}

export async function queueWebSourceUrls(params: {
  urls: string[];
  distillationVersion?: string;
}): Promise<{
  total: number;
  queued: number;
  invalid: number;
  duplicateInRequest: number;
  items: QueueWebSourceResult[];
}> {
  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  const items: QueueWebSourceResult[] = [];
  const seen = new Set<string>();
  let queued = 0;
  let invalid = 0;
  let duplicateInRequest = 0;

  for (const rawUrl of params.urls) {
    const trimmed = rawUrl.trim();
    if (!trimmed) continue;
    let normalizedUrl = "";
    try {
      normalizedUrl = normalizeWebUrl(trimmed).normalizedUrl;
    } catch {
      // pass through to queueWebSourceUrl for reason details
    }
    if (normalizedUrl && seen.has(normalizedUrl)) {
      duplicateInRequest += 1;
      items.push({
        ok: false,
        url: rawUrl,
        reason: "duplicate url in request",
      });
      continue;
    }
    if (normalizedUrl) seen.add(normalizedUrl);
    const result = await queueWebSourceUrl({
      url: rawUrl,
      distillationVersion,
    });
    items.push(result);
    if (result.ok) queued += 1;
    else invalid += 1;
  }

  return {
    total: params.urls.length,
    queued,
    invalid,
    duplicateInRequest,
    items,
  };
}
