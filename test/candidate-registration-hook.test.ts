import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function countOccurrences(value: string, needle: string) {
  return value.split(needle).length - 1;
}

describe("candidate registration hook setup", () => {
  test("global hooks do not duplicate managed local reminder hooks", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "context-still-hook-test-"));
    try {
      const scriptsDir = join(projectRoot, "scripts");
      const homeDir = join(projectRoot, "home");
      const globalHookDir = join(projectRoot, "global-hooks");
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });

      copyFileSync(
        join(process.cwd(), "scripts/setup-candidate-registration-hook.sh"),
        join(scriptsDir, "setup-candidate-registration-hook.sh"),
      );
      copyFileSync(
        join(process.cwd(), "scripts/post-commit-candidate-reminder.sh"),
        join(scriptsDir, "post-commit-candidate-reminder.sh"),
      );
      chmodSync(join(scriptsDir, "setup-candidate-registration-hook.sh"), 0o755);
      chmodSync(join(scriptsDir, "post-commit-candidate-reminder.sh"), 0o755);

      run("git", ["init", "-b", "main"], projectRoot);
      run("git", ["config", "user.email", "test@example.com"], projectRoot);
      run("git", ["config", "user.name", "Test User"], projectRoot);
      writeFileSync(join(projectRoot, "README.md"), "test\n");
      run("git", ["add", "README.md"], projectRoot);
      run("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "initial"], projectRoot);

      run("bash", ["scripts/setup-candidate-registration-hook.sh", "install"], projectRoot);
      run("bash", ["scripts/setup-candidate-registration-hook.sh", "install-global"], projectRoot, {
        CONTEXT_STILL_CANDIDATE_GLOBAL_HOOK_DIR: globalHookDir,
        HOME: homeDir,
      });

      run("sh", ["-n", join(globalHookDir, "pre-commit")], projectRoot);
      run("sh", ["-n", join(globalHookDir, "post-commit")], projectRoot);

      const preCommitOutput = run(join(globalHookDir, "pre-commit"), [], projectRoot);
      expect(countOccurrences(preCommitOutput, "[context-still] pre-commit reminder")).toBe(1);

      const postCommitOutput = run(join(globalHookDir, "post-commit"), [], projectRoot, {
        CONTEXT_STILL_CANDIDATE_HOOK_QUIET: "0",
      });
      expect(
        countOccurrences(postCommitOutput, "[context-still] post-commit candidate reminder"),
      ).toBe(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
