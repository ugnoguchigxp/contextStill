import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("cli eval-context e2e", () => {
  test("fails when neither --from-replay nor --cases is specified", () => {
    const run = spawnSync("bun", ["run", "src/cli/eval-context.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Either --from-replay or --cases <path> must be specified.");
  });

  test("fails when both --from-replay and --cases are specified", () => {
    const run = spawnSync(
      "bun",
      ["run", "src/cli/eval-context.ts", "--from-replay", "--cases", "spec/context-eval-cases.example.jsonl"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Cannot specify both --from-replay and --cases <path> simultaneously.");
  });

  test("fails with validation / file not found if cases file does not exist", () => {
    const run = spawnSync("bun", ["run", "src/cli/eval-context.ts", "--cases", "nonexistent-file.jsonl"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ENOENT");
  });

  test("runs successfully and outputs JSON when --json option is used with example cases", () => {
    const run = spawnSync(
      "bun",
      ["run", "src/cli/eval-context.ts", "--cases", "spec/context-eval-cases.example.jsonl", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.source.mode).toBe("cases");
    expect(parsed.source.path).toBe("spec/context-eval-cases.example.jsonl");
    expect(parsed.summary.status).toBe("failed"); // Example IDs won't match local DB items usually
    expect(parsed.cases).toHaveLength(2);
  });

  test("runs successfully and outputs text summary when no --json option is used", () => {
    const run = spawnSync(
      "bun",
      ["run", "src/cli/eval-context.ts", "--cases", "spec/context-eval-cases.example.jsonl"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Context Eval (cases, cases=2");
    expect(run.stdout).toContain("Summary: failed");
    expect(run.stdout).toContain("Failed cases:");
  });
});
