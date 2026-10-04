import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonSha256 } from "../../shared/utils/canonical-json.js";
import type { CodexResearchOutcome } from "./codex-research.contract.js";

const BASE_PATH = "/api/integrations/contextstill/manual/v1";
export const MANUAL_RESEARCH_BUDGET = {
  rounds: 4,
  queries: 25,
  urls: 50,
  documents: 15,
  inputTokens: 150_000,
  outputTokens: 30_000,
  requests: 150,
  costUsd: 1,
  depth: 4,
  wallMs: 900_000,
} as const;

const jobSchema = z.object({
  id: z.string().uuid(),
  topic: z.string(),
  mode: z.literal("live"),
  status: z.enum([
    "queued",
    "running",
    "finalizing",
    "completed",
    "partial",
    "failed",
    "cancel_requested",
    "cancelled",
  ]),
  reason: z.string().nullable(),
  integration: z.object({
    idempotencyKey: z.string(),
    requestHash: z.string(),
    disableKnowledge: z.literal(true),
  }),
  usage: z.object({
    queries: z.number(),
    urls: z.number(),
    tokens: z.number(),
    requests: z.number(),
    costUsd: z.number(),
  }),
});

const detailSchema = z.object({
  job: jobSchema,
  artifacts: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      title: z.string(),
      body: z.string(),
      claimIds: z.array(z.string()),
      limitations: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
    }),
  ),
  claims: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      accepted: z.boolean(),
      evidenceIds: z.array(z.string()),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      snapshotId: z.string(),
      quote: z.string(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  ),
  sources: z.array(
    z.object({
      id: z.string(),
      finalUrl: z.string(),
      title: z.string(),
      text: z.string(),
      hash: z.string(),
    }),
  ),
});

export type DeepStillJob = z.infer<typeof jobSchema>;
export type ManualResearchResult = {
  report: { title: string; body: string; limitations: string[]; openQuestions: string[] } | null;
  claims: Array<{ id: string; text: string; evidenceIds: string[] }>;
  evidence: Array<{
    id: string;
    quote: string;
    sourceTitle: string;
    sourceUrl: string;
    snapshotHash: string;
  }>;
  usage: {
    queries: number | null;
    urls: number | null;
    tokens: number | null;
    requests: number | null;
    costUsd: number | null;
  };
  reason: string | null;
  exploration?: CodexResearchOutcome;
};

function endpoint(): { url: URL; token: string } {
  const raw = process.env.CONTEXT_STILL_DEEPSTILL_URL?.trim() || "http://127.0.0.1:4310";
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new Error("DEEPSTILL_ENDPOINT_INVALID");
  }
  const token = process.env.DEEPSTILL_CONTEXTSTILL_TOKEN?.trim();
  if (!token || token.length < 32) throw new Error("DEEPSTILL_TOKEN_NOT_CONFIGURED");
  return { url, token };
}

async function call(path: string, init?: { method?: "POST"; body?: unknown }): Promise<unknown> {
  const { url, token } = endpoint();
  const response = await fetch(new URL(BASE_PATH + path, url), {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DEEPSTILL_HTTP_${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("DEEPSTILL_RESULT_TOO_LARGE");
  return JSON.parse(text) as unknown;
}

export async function submitDeepStill(input: {
  id: string;
  topic: string;
  requestHash: string;
}): Promise<DeepStillJob> {
  return jobSchema.parse(
    await call("/jobs", {
      method: "POST",
      body: {
        topic: input.topic,
        mode: "live",
        strategy: "balanced",
        budget: MANUAL_RESEARCH_BUDGET,
        integration: {
          idempotencyKey: input.id,
          requestHash: input.requestHash,
          disableKnowledge: true,
        },
      },
    }),
  );
}

export async function fetchDeepStillDetail(id: string) {
  return detailSchema.parse(await call(`/jobs/${encodeURIComponent(id)}`));
}

export async function cancelDeepStill(id: string): Promise<DeepStillJob> {
  return jobSchema.parse(await call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function projectDeepStillResult(detail: z.infer<typeof detailSchema>): {
  result: ManualResearchResult;
  resultHash: string;
} {
  const artifact = detail.artifacts[0] ?? null;
  const claimIds = new Set(
    artifact?.claimIds ?? detail.claims.filter((claim) => claim.accepted).map((claim) => claim.id),
  );
  const claims = detail.claims.filter((claim) => claim.accepted && claimIds.has(claim.id));
  if (claims.length !== claimIds.size) throw new Error("DEEPSTILL_REPORT_CLAIM_MISSING");
  const evidenceIds = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const evidence = detail.evidence
    .filter((item) => evidenceIds.has(item.id))
    .map((item) => {
      const source = detail.sources.find((candidate) => candidate.id === item.snapshotId);
      if (
        !source ||
        sha256(source.text) !== source.hash ||
        source.text.slice(item.start, item.end) !== item.quote
      ) {
        throw new Error("DEEPSTILL_EVIDENCE_INVALID");
      }
      let url: URL;
      try {
        url = new URL(source.finalUrl);
      } catch {
        throw new Error("DEEPSTILL_SOURCE_URL_INVALID");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.toString() !== source.finalUrl
      ) {
        throw new Error("DEEPSTILL_SOURCE_URL_INVALID");
      }
      return {
        id: item.id,
        quote: item.quote,
        sourceTitle: source.title,
        sourceUrl: source.finalUrl,
        snapshotHash: source.hash,
      };
    });
  if (
    claims.some((claim) => claim.evidenceIds.some((id) => !evidence.some((item) => item.id === id)))
  ) {
    throw new Error("DEEPSTILL_EVIDENCE_MISSING");
  }
  if (detail.job.status === "completed" && !artifact) throw new Error("DEEPSTILL_REPORT_MISSING");
  const result: ManualResearchResult = {
    report: artifact
      ? {
          title: artifact.title,
          body: artifact.body,
          limitations: artifact.limitations ?? [],
          openQuestions: artifact.openQuestions ?? [],
        }
      : null,
    claims: claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      evidenceIds: claim.evidenceIds,
    })),
    evidence,
    usage: detail.job.usage,
    reason: detail.job.reason,
  };
  return { result, resultHash: canonicalJsonSha256(result) };
}
