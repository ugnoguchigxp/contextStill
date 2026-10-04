import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(os.tmpdir(), "contextstill-codex-research-test-"));
process.env.NODE_ENV = "test";
process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(directory, "research-test.sqlite");
const executable = path.join(directory, "fake-codex");
process.env.CONTEXT_STILL_CODEX_CLI_PATH = executable;
const candidate = {
  title: "再送の安全性",
  knowledge: "再送では冪等キーを使う。",
  relevance: "二重処理を防ぐ。",
  sources: [
    {
      url: "https://example.com/docs",
      title: "一次資料",
      verification: "source_read",
      excerpt: "idempotency",
      location: "Retries",
      informationDate: null,
    },
  ],
  uncertainties: ["期間は不明"],
  contradictions: [],
};
// Uses the real installed SDK's process/JSONL transport, with no external service.
writeFileSync(
  executable,
  `#!/usr/bin/env bun
const prompt = await Bun.stdin.text();
const send = (event) => console.log(JSON.stringify(event));
send({type:"thread.started",thread_id:"fake-thread"});
send({type:"item.completed",item:{id:"answer",type:"agent_message",text:JSON.stringify(${JSON.stringify({ candidates: [candidate], limitations: [] })})}});
if (prompt.includes("FAIL research")) send({type:"turn.failed",error:{message:"fixture failure"}});
else if (prompt.includes("TIMEOUT")) await new Promise(() => setInterval(() => {}, 1000));
else send({type:"turn.completed",usage:{input_tokens:900,cached_input_tokens:400,output_tokens:100,reasoning_output_tokens:20}});
`,
  { mode: 0o700 },
);
chmodSync(executable, 0o700);

const service = await import("../src/modules/manual-research/manual-research.service.js");
const ingress = await import("../src/modules/manual-research/research-candidate-ingress.js");
const db = await service.manualResearchDatabase();
async function awaitRun(id: string) {
  for (let n = 0; n < 200; n++) {
    const run = await service.getManualResearch(id);
    if (
      run &&
      ["completed", "partial", "failed", "cancelled", "invalid_result"].includes(run.status)
    )
      return run;
    await Bun.sleep(20);
  }
  throw new Error("Research did not finish");
}
try {
  const key = randomUUID();
  const first = await service.createManualResearch({
    topic: "安全な再送",
    engine: "codex",
    clientRequestKey: key,
  });
  const replay = await service.createManualResearch({
    topic: "安全な再送",
    engine: "codex",
    clientRequestKey: key,
  });
  assert.equal(first.id, replay.id);
  await assert.rejects(
    service.createManualResearch({ topic: "安全な再送", clientRequestKey: key }),
    service.ManualResearchConflict,
  );
  const completed = await awaitRun(first.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result?.exploration?.model, "gpt-6-luna");
  assert.equal(completed.result?.exploration?.tokenUsage.cachedInputTokens, 400);
  assert.equal(
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM found_candidates").get()?.count,
    0,
  );
  const request = { claimIds: ["codex-0"], scope: "global" as const };
  const imported = await ingress.importResearchCandidates(first.id, request);
  const again = await ingress.importResearchCandidates(first.id, request);
  assert.deepEqual(again, imported);
  assert.equal(
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM found_candidates").get()?.count,
    1,
  );
  assert.equal(
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM covering_evidence_queue WHERE status='pending'",
      )
      .get()?.count,
    1,
  );
  const origin = db
    .query<{ origin: string; content: string }, []>("SELECT origin,content FROM found_candidates")
    .get();
  assert.ok(origin?.content.includes("https://example.com/docs"));
  assert.equal(
    JSON.parse(origin?.origin ?? "{}").metadata.research.resultHash,
    completed.resultHash,
  );
  const comparison = await ingress.compareResearch("安全な再送");
  assert.equal(comparison[0]?.selectedCount, 1);
  assert.equal(comparison[0]?.totalTokens, 1000);
  await assert.rejects(
    ingress.importResearchCandidates(first.id, { ...request, scope: "repo", repoPath: directory }),
    service.ManualResearchConflict,
  );
  const budgetRun = await service.createManualResearch({
    topic: "小さな予算",
    engine: "codex",
    codex: { tokenBudget: 1000 },
    clientRequestKey: randomUUID(),
  });
  const budgetResult = await awaitRun(budgetRun.id);
  assert.equal(budgetResult.status, "partial");
  assert.equal(budgetResult.result?.reason, "token_budget");
  assert.equal(budgetResult.result?.claims.length, 1);
  const failed = await service.createManualResearch({
    topic: "FAIL research",
    engine: "codex",
    clientRequestKey: randomUUID(),
  });
  const failedResult = await awaitRun(failed.id);
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.result?.claims.length, 1);
  const beforeReconcile = failedResult.resultHash;
  await service.reconcileManualResearch(failed.id);
  assert.equal((await service.getManualResearch(failed.id))?.resultHash, beforeReconcile);
  const timeoutRun = await service.createManualResearch({
    topic: "TIMEOUT research",
    engine: "codex",
    codex: { wallMs: 1000 },
    clientRequestKey: randomUUID(),
  });
  const timeoutResult = await awaitRun(timeoutRun.id);
  assert.equal(timeoutResult.status, "partial");
  assert.equal(timeoutResult.result?.reason, "timeout");
  assert.equal(timeoutResult.result?.claims.length, 1);
  assert.equal(timeoutResult.result?.usage.tokens, null);
  const cancelled = await service.createManualResearch({
    topic: "TIMEOUT cancel",
    engine: "codex",
    clientRequestKey: randomUUID(),
  });
  for (let n = 0; n < 100; n++) {
    if ((await service.getManualResearch(cancelled.id))?.result?.claims.length) break;
    await Bun.sleep(20);
  }
  await service.requestManualResearchCancel(cancelled.id);
  assert.equal((await awaitRun(cancelled.id)).status, "cancelled");
  // Simulate a persisted run whose prior API process disappeared. Reconciliation
  // must preserve acquired candidates and never start another Codex thread.
  db.query("UPDATE manual_research_runs SET status='running',result_hash=NULL WHERE id=?").run(
    first.id,
  );
  db.query(
    "UPDATE manual_research_explorations SET runtime_owner='old-process' WHERE run_id=?",
  ).run(first.id);
  await service.reconcileManualResearch(first.id);
  const restored = await service.getManualResearch(first.id);
  assert.equal(restored?.status, "partial");
  assert.equal(restored?.result?.reason, "interrupted");
  assert.equal(restored?.result?.claims.length, 1);
  assert.equal(
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM found_candidates").get()?.count,
    1,
  );
  console.log("Codex research SDK/SQLite smoke: passed (no external calls)");
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
