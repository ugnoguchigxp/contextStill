import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { callIsolatedMcp } from "./testing/isolated-mcp.mjs";
import { TEST_ADMIN_KEY, createIsolatedRuntime, freePort } from "./testing/isolated-runtime.mjs";
const runtime = await createIsolatedRuntime();
const report = [];
try {
  await runtime.initialize();
  const port = await freePort();
  await runtime.startApi(port);
  const origin = `http://127.0.0.1:${port}`;
  const request = async (route, input) => {
    const response = await fetch(`${origin}/api${route}`, {
      method: "POST",
      headers: { "x-admin-api-key": TEST_ADMIN_KEY, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  const goal = "sqlite onboarding workflow";
  for (const populated of [false, true]) {
    let sourcePath;
    if (populated) {
      await request("/sources/pages", {
        slug: "compile-parity-proof",
        title: "Compile parity proof",
        body: "Verify sqlite onboarding workflow and backup before completion.",
      });
      const source = await fetch(`${origin}/api/sources/pages/compile-parity-proof`, {
        headers: { "x-admin-api-key": TEST_ADMIN_KEY },
      });
      sourcePath = (await source.json()).path;
    }
    if (populated)
      await request("/knowledge", {
        type: "rule",
        status: "active",
        scope: "global",
        general: true,
        title: "sqlite onboarding workflow",
        body: "Verify sqlite onboarding workflow and backup before completion.",
        metadata: { sourceRefs: [sourcePath] },
        confidence: 95,
        importance: 95,
      });
    const before = await runtime.writer("SELECT id FROM context_compile_runs", [], "all");
    const ts = await request("/context/compile", {
      goal,
      changeTypes: ["docs"],
      domains: ["onboarding"],
    });
    const native = await callIsolatedMcp(runtime, "context_compile", {
      goal,
      changeTypes: ["docs"],
      domains: ["onboarding"],
    });
    const after = await runtime.writer(
      "SELECT id,pack_snapshot FROM context_compile_runs",
      [],
      "all",
    );
    const previous = new Set(before.rows.map((r) => r.id));
    const rows = after.rows.filter((r) => !previous.has(r.id));
    assert.equal(rows.length, 2, "each engine must persist exactly once");
    const nativeRun = rows.find((r) => r.id !== ts.pack.runId);
    assert.ok(nativeRun);
    const pack = JSON.parse(nativeRun.pack_snapshot);
    const ids = (p) => [...p.rules, ...p.procedures].map((r) => r.itemId ?? r.id).sort();
    const refs = (p) => [...p.rules, ...p.procedures].flatMap((r) => r.sourceRefs ?? []).sort();
    assert.deepEqual(ids(ts.pack), ids(pack));
    assert.deepEqual(refs(ts.pack), refs(pack));
    assert.equal(ts.markdown, native.content[0].text);
    if (populated) assert.ok(refs(pack).length > 0);
    report.push({
      fixture: populated ? "global-rule" : "empty",
      tsIds: ids(ts.pack),
      rustIds: ids(pack),
      selectedIdsEqual: JSON.stringify(ids(ts.pack)) === JSON.stringify(ids(pack)),
      sourceRefsEqual: JSON.stringify(refs(ts.pack)) === JSON.stringify(refs(pack)),
      tsNoContent: ts.markdown === "No Content",
      rustNoContent: native.content[0].text === "No Content",
      markdownEqual: ts.markdown === native.content[0].text,
      persistCount: rows.length,
    });
  }
  const metadata = JSON.parse(await readFile(runtime.env.CONTEXT_STILL_MCP_ENDPOINT_PATH, "utf8"));
  const token = (await readFile(metadata.writerTokenPath, "utf8")).trim();
  const endpoint = new URL("/internal/context-compile", metadata.writerUrl);
  const internal = (payload, headers = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(payload),
    });
  const payload = {
    contractVersion: 1,
    databaseFingerprint: metadata.effectiveDatabaseFingerprint,
    input: { goal },
    options: {
      source: "cli",
      sessionId: "parity-session",
      retrievalMode: "architecture_context",
      tokenBudget: 128,
    },
  };
  const startCount = (
    await runtime.writer("SELECT count(*) AS n FROM context_compile_runs", [], "get")
  ).rows[0].n;
  assert.equal((await internal(payload, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await internal(payload, { origin: "https://example.invalid" })).status, 403);
  assert.equal((await internal({ ...payload, databaseFingerprint: "wrong" })).status, 422);
  assert.equal((await internal({ ...payload, contractVersion: 2 })).status, 422);
  assert.equal(
    (await runtime.writer("SELECT count(*) AS n FROM context_compile_runs", [], "get")).rows[0].n,
    startCount,
  );
  const budgetResponse = await internal(payload);
  assert.equal(budgetResponse.status, 200);
  const envelope = (await budgetResponse.json()).envelope;
  assert.ok(Buffer.byteLength(envelope.markdown) <= 128);
  const metadataRow = (
    await runtime.writer(
      "SELECT source,session_id,token_budget FROM context_compile_runs WHERE id=?",
      [envelope.runId],
      "get",
    )
  ).rows[0];
  assert.deepEqual(metadataRow, { source: "cli", session_id: "parity-session", token_budget: 128 });
  await runtime.stopWriter();
  const unavailable = await fetch(`${origin}/api/context/compile`, {
    method: "POST",
    headers: { "x-admin-api-key": TEST_ADMIN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  assert.equal(unavailable.status, 503);
  await mkdir("spec/docs/assets/validated-improvements-2026-09-12", { recursive: true });
  await writeFile(
    "spec/docs/assets/validated-improvements-2026-09-12/compile-parity.json",
    `${JSON.stringify({ fixtureVersion: 1, mode: "split_legacy_rank", provider: "disabled", cases: report, cutoverApproved: true, transport: { auth: true, origin: true, dbBinding: true, version: true, rejectedRequestsPersisted: 0, budget128: true, sourceAndSession: true, unavailable503: true }, rankingPromotion: false, compatibility: "Postgres and explicit securityIntelligenceShadow retain legacy-only semantics" }, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
} finally {
  await runtime.cleanup();
}
