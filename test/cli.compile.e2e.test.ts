import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import { upsertSourceDocument } from "../src/modules/sources/source.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function parsePackJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const runIdMarker = trimmed.indexOf('"runId"');
  if (runIdMarker < 0) {
    throw new Error("runId not found in CLI output");
  }
  const jsonStart = trimmed.lastIndexOf("{", runIdMarker);
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error("JSON object not found in CLI output");
  }
  return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
}

describeDb("cli compile e2e", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("bun run compile --json returns parseable context pack JSON", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///cli/knowledge.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "CLI rule",
      body: "cli compile goal",
    });
    await upsertSourceDocument({
      sourceKind: "wiki",
      uri: "file:///cli/source.md",
      title: "CLI source",
      body: "cli compile goal source",
    });

    const run = spawnSync(
      "bun",
      ["run", "src/cli/compile.ts", "--goal", "cli compile goal", "--intent", "edit", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_ROUTER_RUN_DB_TESTS: "1",
        },
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(0);
    const output = run.stdout.trim();
    expect(output.length).toBeGreaterThan(0);
    const parsed = parsePackJson(output);
    expect(typeof parsed.runId).toBe("string");
    expect(
      parsed.status === "ok" || parsed.status === "degraded" || parsed.status === "failed",
    ).toBe(true);
    expect(typeof parsed.retrievalMode).toBe("string");
    expect(typeof parsed.diagnostics).toBe("object");
  });

  test("compile accepts includeDraft/files/tokenBudget flags", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///cli/draft-proc.md",
      type: "procedure",
      status: "draft",
      scope: "repo",
      title: "CLI Draft Procedure",
      body: "draft-mode command sequence",
    });

    const run = spawnSync(
      "bun",
      [
        "run",
        "src/cli/compile.ts",
        "--goal",
        "draft-mode command sequence",
        "--retrieval-mode",
        "procedure_context",
        "--include-draft",
        "true",
        "--file",
        "src/modules/context-compiler/context-compiler.service.ts",
        "--token-budget",
        "640",
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORY_ROUTER_RUN_DB_TESTS: "1",
        },
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(0);
    const parsed = parsePackJson(run.stdout) as {
      procedures?: Array<{ title?: string }>;
      codeContext?: Array<{ itemKind?: string; content?: string }>;
      diagnostics?: { retrievalStats?: { tokenBudget?: number } };
    };

    expect(parsed.procedures?.some((item) => item.title === "CLI Draft Procedure")).toBe(true);
    expect(
      parsed.codeContext?.some(
        (item) =>
          item.itemKind === "file_hint" &&
          item.content === "src/modules/context-compiler/context-compiler.service.ts",
      ),
    ).toBe(true);
    expect(parsed.diagnostics?.retrievalStats?.tokenBudget).toBe(640);
  });
});
