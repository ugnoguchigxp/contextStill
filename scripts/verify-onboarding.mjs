import assert from "node:assert/strict";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { callIsolatedMcp } from "./testing/isolated-mcp.mjs";
import {
  TEST_ADMIN_KEY,
  createIsolatedRuntime,
  freePort,
  projectRoot,
  waitUntil,
} from "./testing/isolated-runtime.mjs";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../spec/docs/assets/validated-improvements-2026-09-12/onboarding-fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const guide = await readFile(
  new URL("../spec/docs/pub/getting-started.md", import.meta.url),
  "utf8",
);
for (const command of fixture.requiredCommands)
  assert.ok(guide.includes(command), `Getting Started must document ${command}`);
assert.ok(guide.includes(`--goal "${fixture.goal}"`));
assert.ok(guide.includes(`--change-types ${fixture.changeTypes.join(",")}`));
assert.ok(guide.includes(`--domains ${fixture.domains.join(",")}`));
const runtime = await createIsolatedRuntime();
try {
  await runtime.initialize();
  const preflight = JSON.parse(await runtime.cli("bootstrap", "preflight", "--json"));
  assert.equal(preflight.overallStatus, "ready");
  const port = await freePort();
  await runtime.startApi(port);
  const origin = `http://127.0.0.1:${port}`;
  const api = (route, options = {}) =>
    fetch(`${origin}/api${route}`, {
      ...options,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "x-admin-api-key": TEST_ADMIN_KEY,
        "content-type": "application/json",
        ...options.headers,
      },
    });
  assert.equal((await fetch(`${origin}/api/knowledge`)).status, 401);
  const compileArgs = [
    "--no-env-file",
    "src/cli/compile.ts",
    "--goal",
    fixture.goal,
    "--repo-path",
    projectRoot,
    "--change-types",
    fixture.changeTypes.join(","),
    "--domains",
    fixture.domains.join(","),
    "--json",
  ];
  const empty = JSON.parse(await runtime.run("bun", compileArgs));
  assert.equal(empty.rules.length + empty.procedures.length, 0);
  assert.ok(empty.runId);

  const sourceResponse = await api("/sources/pages", {
    method: "POST",
    body: JSON.stringify({
      slug: "onboarding-proof",
      title: "Onboarding workflow evidence",
      body: "For onboarding workflow changes, run the isolated onboarding smoke and confirm backup verification before declaring the workflow ready.",
    }),
  });
  assert.equal(sourceResponse.status, 200, await sourceResponse.clone().text());
  const sourcePage = await (await api("/sources/pages/onboarding-proof")).json();
  assert.ok(sourcePage.path);
  const created = await api("/knowledge", {
    method: "POST",
    body: JSON.stringify({
      type: "rule",
      status: "active",
      scope: "global",
      general: true,
      title: "Verify the development workflow before onboarding",
      body: "For onboarding workflow changes, run the isolated onboarding smoke and confirm backup verification before declaring the workflow ready.",
      domains: ["onboarding", "workflow"],
      changeTypes: ["docs", "plan"],
      metadata: { sourceRefs: [sourcePage.path] },
      confidence: 95,
      importance: 95,
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const knowledge = (await created.json()).item;
  const pack = JSON.parse(await runtime.run("bun", compileArgs));
  assert.ok(
    [...pack.rules, ...pack.procedures].some(
      (item) => item.itemId === knowledge.id || item.id === knowledge.id,
    ),
    "first populated compile must retrieve the saved knowledge",
  );
  const evalResult = await callIsolatedMcp(runtime, "compile_eval", {
    runId: pack.runId,
    outcome: "useful",
    body: "The saved source-backed onboarding rule was retrieved.",
    relevance: 100,
    actionability: 100,
    coverage: 100,
    clarity: 100,
    specificity: 100,
  });
  assert.ok(evalResult.content.length);
  const detailBefore = await (await api(`/context/runs/${pack.runId}`)).json();
  assert.equal(detailBefore.detail.evaluations.length, 1);
  assert.ok(JSON.stringify(detailBefore.detail).includes(sourcePage.path));
  const persisted = await runtime.writer(
    "SELECT id FROM context_compile_runs WHERE id = ?",
    [pack.runId],
    "all",
  );
  assert.equal(persisted.rows.length, 1);
  const usage = await runtime.writer("SELECT COUNT(*) AS count FROM llm_usage_logs", [], "all");
  assert.equal(usage.rows[0].count, 0, "onboarding must not call providers");
  await assert.rejects(
    runtime.cli("backup", "create", "--json"),
    /requires the resident Writer to be stopped/,
  );
  await runtime.stopWriter();
  await waitUntil(
    async () => (await fetch(`${origin}/api/health/ready`)).status === 503,
    "writer outage readiness",
  );
  assert.equal((await fetch(`${origin}/api/health/live`)).status, 200);
  await runtime.startWriter();
  await waitUntil(
    async () => (await fetch(`${origin}/api/health/ready`)).status === 200,
    "writer recovery readiness",
  );
  const detailAfter = await (await api(`/context/runs/${pack.runId}`)).json();
  assert.equal(detailAfter.detail.evaluations.length, 1);
  assert.equal((await (await api("/sources/pages/onboarding-proof")).json()).body, sourcePage.body);
  await runtime.stopWriter();
  const backup = JSON.parse(await runtime.cli("backup", "create", "--json"));
  const verified = JSON.parse(
    await runtime.cli("backup", "verify", "--path", backup.output, "--json"),
  );
  assert.equal(verified.knowledgeItems, 1);
  const restoredPath = path.join(runtime.directory, "restored.sqlite");
  await copyFile(backup.output, restoredPath);
  const restored = JSON.parse(
    await runtime.cli("backup", "verify", "--path", restoredPath, "--json"),
  );
  assert.equal(restored.sha256, verified.sha256);
  const recovered = JSON.parse(
    await runtime.run("bun", [
      "--no-env-file",
      "-e",
      'const {Database}=await import("bun:sqlite"); const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify({knowledge:db.query("SELECT id, body FROM knowledge_items").all(),runs:db.query("SELECT id FROM context_compile_runs").all()})); db.close();',
      restoredPath,
    ]),
  );
  assert.equal(recovered.knowledge[0].id, knowledge.id);
  assert.ok(recovered.knowledge[0].body.includes("isolated onboarding smoke"));
  assert.ok(recovered.runs.some((run) => run.id === pack.runId));
  console.log(
    JSON.stringify(
      {
        ok: true,
        bootstrap: "ready",
        compile: { emptyRunPersisted: true, savedKnowledgeRetrieved: true },
        readiness: "ready -> not_ready -> ready",
        providerCalls: 0,
        backup: {
          writeLockEnforced: true,
          sha256: verified.sha256,
          restoredKnowledge: verified.knowledgeItems,
          restoredRuns: recovered.runs.length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.cleanup();
}
