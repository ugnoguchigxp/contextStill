import { APP_CONSTANTS } from "../../../constants.js";
import { redactSecrets } from "../../../shared/utils/secret-redaction.js";
import { validateFetchContentUrl } from "../../distillation/distillation-tools.service.js";
import { enqueueFindingJob, findFindingJob } from "../../queue/core/index.js";

export type WebSourceQueueItem = {
  url: string;
  normalizedUrl: string;
  state: {
    id: string;
    status: string;
    priority: number;
    attemptCount: number;
    distillationVersion: string;
    sourceKind: "web_ingest";
    sourceKey: string;
    sourceUri: string;
    createdAt: string;
    updatedAt: string;
  };
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

  const distillationVersion = params.distillationVersion ?? APP_CONSTANTS.distillationTargetVersion;
  const redactedUrl = redactSecrets(normalized.url);
  const redactedNormalizedUrl = redactSecrets(normalized.normalizedUrl);
  const existing = await findFindingJob({
    inputKind: "source_target",
    sourceKind: "web_ingest",
    sourceKey: redactedNormalizedUrl,
    distillationVersion,
  });
  const state = await enqueueFindingJob({
    inputKind: "source_target",
    sourceKind: "web_ingest",
    sourceKey: redactedNormalizedUrl,
    sourceUri: redactedNormalizedUrl,
    distillationVersion,
    payload: {
      sourceType: "web_research",
      sourceUrl: redactedUrl,
      normalizedUrl: redactedNormalizedUrl,
      importedVia: "sources.webIngest",
      registeredAt: new Date().toISOString(),
    },
    metadata: {
      sourceType: "web_research",
      sourceUrl: redactedUrl,
      normalizedUrl: redactedNormalizedUrl,
      importedVia: "sources.webIngest",
    },
    priority: 80,
  });

  return {
    ok: true,
    item: {
      url: redactedUrl,
      normalizedUrl: redactedNormalizedUrl,
      state: {
        id: state.id,
        status: state.status,
        priority: state.priority,
        attemptCount: state.attemptCount,
        distillationVersion: state.distillationVersion,
        sourceKind: "web_ingest",
        sourceKey: state.sourceKey,
        sourceUri: state.sourceUri,
        createdAt: state.createdAt.toISOString(),
        updatedAt: state.updatedAt.toISOString(),
      },
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
