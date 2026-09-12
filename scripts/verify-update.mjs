import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createIsolatedRuntime } from "./testing/isolated-runtime.mjs";
import { callIsolatedMcp } from "./testing/isolated-mcp.mjs";

// A caller-supplied baseline binary only ever receives this synthetic temporary profile.
const baseline = process.argv[2];
assert.ok(
  baseline && path.isAbsolute(baseline),
  "Pass an absolute baseline context-stilld binary path",
);
const baselineSha256 = createHash("sha256")
  .update(await readFile(baseline))
  .digest("hex");
const runtime = await createIsolatedRuntime();
try {
  await runtime.run("cargo", ["build", "--locked", "-q", "-p", "context-stilld"], {}, 600_000);
  await runtime.initialize(baseline);
  const id = randomUUID();
  await runtime.writer(
    "INSERT INTO knowledge_items(id, type, status, scope, classification_status, title, body, applies_to, metadata) VALUES (?, 'rule', 'active', 'global', 'classified', 'Update rehearsal', 'Verify update workflow and restore persisted evidence.', '{}', '{}')",
    [id],
  );
  const baselineCompile = await callIsolatedMcp(runtime, "context_compile", {
    goal: "update workflow",
    changeTypes: ["docs"],
    domains: ["workflow"],
  });
  assert.ok(
    JSON.stringify(baselineCompile).includes(
      "Verify update workflow and restore persisted evidence.",
    ),
    "baseline must compile seeded evidence",
  );
  const before = (await runtime.writer("SELECT id FROM context_compile_runs", [], "all")).rows;
  assert.equal(before.length, 1);
  await callIsolatedMcp(runtime, "compile_eval", {
    runId: before[0].id,
    outcome: "useful",
    body: "Synthetic update rehearsal evidence.",
    relevance: 100,
    actionability: 100,
    coverage: 100,
    clarity: 100,
    specificity: 100,
  });
  await runtime.stopWriter();
  const backup = JSON.parse(await runtime.run(baseline, ["backup", "create", "--json"]));
  await runtime.startWriter();
  assert.equal(
    (await runtime.writer("SELECT id FROM knowledge_items WHERE id = ?", [id], "all")).rows.length,
    1,
  );
  assert.equal(
    (
      await runtime.writer(
        "SELECT id FROM context_compile_runs WHERE id = ?",
        [before[0].id],
        "all",
      )
    ).rows.length,
    1,
  );
  const evals = (
    await runtime.writer("SELECT COUNT(*) AS count FROM context_compile_evals", [], "all")
  ).rows[0].count;
  assert.equal(evals, 1);
  const candidateCompile = await callIsolatedMcp(runtime, "context_compile", {
    goal: "update workflow",
    changeTypes: ["docs"],
    domains: ["workflow"],
  });
  assert.ok(
    JSON.stringify(candidateCompile).includes(
      "Verify update workflow and restore persisted evidence.",
    ),
    "candidate must compile seeded evidence",
  );
  assert.equal(
    (await runtime.writer("SELECT COUNT(*) AS count FROM context_compile_runs", [], "all")).rows[0]
      .count,
    2,
  );
  await runtime.stopWriter();
  await runtime.cli("backup", "verify", "--path", backup.output, "--json");
  // Supported recovery: restore the pre-update snapshot using the secret-aware candidate.
  await copyFile(backup.output, runtime.env.CONTEXT_STILL_SQLITE_CORE_PATH);
  await runtime.startWriter();
  assert.equal(
    (await runtime.writer("SELECT COUNT(*) AS count FROM context_compile_runs", [], "all")).rows[0]
      .count,
    1,
  );
  assert.equal(
    (await runtime.writer("SELECT COUNT(*) AS count FROM context_compile_evals", [], "all")).rows[0]
      .count,
    1,
  );
  assert.equal(
    (await runtime.writer("SELECT id FROM knowledge_items WHERE id = ?", [id], "all")).rows.length,
    1,
  );
  const result = {
    ok: true,
    baselineSha256,
    candidateSha256: createHash("sha256")
      .update(await readFile(runtime.binary))
      .digest("hex"),
    upgrade: "knowledge/run/eval preserved; new compile persisted",
    recovery: "pre-update backup restored with candidate; knowledge/run/eval preserved",
    syntheticProfileOnly: true,
    secrets:
      "No secrets in old-version fixture; Keychain migration and profile binding covered by verify:secrets",
    schemaRevision: 8,
  };
  await writeFile(
    new URL(
      "../spec/docs/assets/validated-improvements-2026-09-12/update-rehearsal.json",
      import.meta.url,
    ),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await runtime.cleanup();
}
