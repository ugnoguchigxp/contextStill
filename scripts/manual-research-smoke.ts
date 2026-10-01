import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(os.tmpdir(), "context-still-manual-research-smoke-"));
process.env.NODE_ENV = "test";
process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(directory, "research-test.sqlite");
process.env.CONTEXT_STILL_DEEPSTILL_URL = "http://127.0.0.1:4310";
process.env.DEEPSTILL_CONTEXTSTILL_TOKEN = "test-token-".padEnd(32, "x");

const { createManualResearch, getManualResearch, reconcileManualResearch } = await import(
  "../src/modules/manual-research/manual-research.service.js"
);
const jobId = randomUUID();
const sourceText = "根拠となる引用。補足。";
const quote = "根拠となる引用。";
const snapshotHash = createHash("sha256").update(sourceText).digest("hex");
let requestCount = 0;
let integration:
  | { idempotencyKey: string; requestHash: string; disableKnowledge: true }
  | undefined;
const job = () => ({
  id: jobId,
  topic: "安全な再試行を調査する",
  mode: "live",
  status: "completed",
  reason: null,
  integration,
  usage: { queries: 1, urls: 1, tokens: 100, requests: 2, costUsd: 0.01 },
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  requestCount++;
  if (init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { integration: typeof integration };
    integration = body.integration;
    return Response.json(job(), { status: 201 });
  }
  return Response.json({
    job: job(),
    artifacts: [
      {
        id: "report-1",
        version: 1,
        title: "調査結果",
        body: "確認した内容",
        claimIds: ["claim-1"],
        limitations: [],
        openQuestions: [],
      },
    ],
    claims: [
      { id: "claim-1", text: "確認できた主張", accepted: true, evidenceIds: ["evidence-1"] },
    ],
    evidence: [{ id: "evidence-1", snapshotId: "source-1", quote, start: 0, end: quote.length }],
    sources: [
      {
        id: "source-1",
        title: "一次資料",
        finalUrl: "https://example.com/source",
        text: sourceText,
        hash: snapshotHash,
      },
    ],
  });
};

try {
  const clientRequestKey = randomUUID();
  const first = await createManualResearch({ topic: "安全な再試行を調査する", clientRequestKey });
  const replay = await createManualResearch({ topic: "安全な再試行を調査する", clientRequestKey });
  assert.equal(first.id, replay.id);
  let saved = await getManualResearch(first.id);
  for (let attempt = 0; attempt < 50 && saved?.status !== "completed"; attempt++) {
    await reconcileManualResearch(first.id);
    await Bun.sleep(20);
    saved = await getManualResearch(first.id);
  }
  assert.equal(saved?.status, "completed");
  assert.equal(saved.result?.report?.title, "調査結果");
  assert.equal(saved.result?.evidence[0]?.quote, quote);
  assert.ok(saved.resultHash?.startsWith("sha256:"));
  assert.equal(requestCount, 2);
  console.log("manual research smoke: passed");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
}
