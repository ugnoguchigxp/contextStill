import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/index.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import { upsertSourceDocument } from "../src/modules/sources/source.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("context compiler integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("applies section token budget and keeps source refs on selected items", async () => {
    for (let i = 0; i < 6; i += 1) {
      await upsertKnowledgeFromSource({
        sourceUri: `file:///knowledge/rule-${i}.md`,
        contentHash: `rule-hash-${i}`,
        type: "rule",
        status: "active",
        scope: "repo",
        title: `Budget Rule ${i}`,
        body: `budget scenario integration source linkage repeated content ${"x".repeat(400)}`,
      });
    }

    await upsertSourceDocument({
      sourceKind: "wiki",
      uri: "file:///sources/budget.md",
      title: "Budget Source",
      contentHash: "budget-source-hash",
      body: "budget scenario integration source linkage proof",
    });

    const { pack } = await compileContextPack({
      goal: "budget scenario integration",
      intent: "edit",
      tokenBudget: 256,
    });

    expect(pack.diagnostics.degradedReasons).toContain("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
    expect(pack.rules.length).toBeGreaterThan(0);
    expect(pack.rules.length).toBeLessThan(6);
    expect(pack.rules.some((item) => item.sourceRefs.length > 0)).toBe(true);
  });

  test("distinguishes no-match degraded reasons from retrieval failures", async () => {
    const noMatch = await compileContextPack({
      goal: "utterly-unmatched-goal-string",
      intent: "edit",
      queryEmbedding: new Array(384).fill(0),
    });
    expect(noMatch.pack.diagnostics.degradedReasons).toContain("NO_ACTIVE_KNOWLEDGE_MATCH");
    expect(noMatch.pack.diagnostics.degradedReasons).toContain("NO_SOURCE_MATCH");
    expect(
      noMatch.pack.diagnostics.degradedReasons.some((reason) => reason.endsWith("_FAILED")),
    ).toBe(false);
    expect(noMatch.pack.sourceRefs.length).toBeGreaterThan(0);
    expect(noMatch.pack.sourceRefs[0]?.startsWith("memory-router://packs/run/")).toBe(true);

    const db = getDb();
    await db.execute(sql`alter table source_fragments rename to source_fragments_tmp`);
    try {
      const failure = await compileContextPack({
        goal: "still-unmatched-goal",
        intent: "edit",
        queryEmbedding: new Array(384).fill(0),
      });
      expect(failure.pack.diagnostics.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
      expect(failure.pack.diagnostics.degradedReasons).not.toContain("NO_SOURCE_MATCH");
    } finally {
      await db.execute(sql`alter table source_fragments_tmp rename to source_fragments`);
    }
  });

  test("procedure_context prioritizes procedure knowledge types", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///knowledge/procedure.md",
      contentHash: "procedure-hash",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "Deploy runbook",
      body: "runbook procedure context command sequence",
    });
    await upsertKnowledgeFromSource({
      sourceUri: "file:///knowledge/rule.md",
      contentHash: "rule-hash",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Deploy rule",
      body: "runbook procedure context command sequence",
    });

    const { pack } = await compileContextPack({
      goal: "runbook procedure context command",
      intent: "edit",
      retrievalMode: "procedure_context",
      tokenBudget: 4000,
    });

    expect(pack.retrievalMode).toBe("procedure_context");
    expect(pack.procedures.length).toBeGreaterThan(0);
    expect(pack.rules.length).toBe(0);
  });

  test("includeDraft includes draft procedures when requested", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///knowledge/draft-proc.md",
      contentHash: "draft-proc-hash",
      type: "procedure",
      status: "draft",
      scope: "repo",
      title: "Draft Procedure",
      body: "draft-mode command sequence",
    });

    const withoutDraft = await compileContextPack({
      goal: "draft-mode command sequence",
      retrievalMode: "procedure_context",
      includeDraft: false,
    });
    expect(withoutDraft.pack.procedures.some((item) => item.title === "Draft Procedure")).toBe(
      false,
    );

    const withDraft = await compileContextPack({
      goal: "draft-mode command sequence",
      retrievalMode: "procedure_context",
      includeDraft: true,
    });
    expect(withDraft.pack.procedures.some((item) => item.title === "Draft Procedure")).toBe(true);
  });

  test("builds code_context from input file hints when symbol index is empty", async () => {
    const { pack } = await compileContextPack({
      goal: "adjust compile behavior",
      intent: "edit",
      files: ["src/modules/context-compiler/context-compiler.service.ts"],
    });
    expect(pack.codeContext.length).toBeGreaterThan(0);
    expect(
      pack.codeContext.some(
        (item) => item.itemKind === "file_hint" && item.content.includes("src/"),
      ),
    ).toBe(true);
  });
});
