import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCodexExecutable } from "../src/modules/codex/spark-runtime.js";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("resolves npm wrappers to native binaries even without Node on PATH", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-native-test-"));
  dirs.push(root);
  const triples: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
  };
  const cli = path.join(root, "bin/codex.js");
  const native = path.join(
    root,
    "vendor",
    triples[`${process.platform}-${process.arch}`],
    "codex/codex",
  );
  mkdirSync(path.dirname(cli), { recursive: true });
  mkdirSync(path.dirname(native), { recursive: true });
  writeFileSync(cli, "#!/usr/bin/env node\n");
  writeFileSync(native, "native fixture");
  chmodSync(cli, 0o755);
  chmodSync(native, 0o755);
  vi.stubEnv("CONTEXT_STILL_CODEX_CLI_PATH", cli);
  vi.stubEnv("PATH", "/nonexistent");
  expect(resolveCodexExecutable()).toBe(realpathSync(native));
});
it("does not silently replace an invalid explicit CLI override", () => {
  vi.stubEnv("CONTEXT_STILL_CODEX_CLI_PATH", "/nonexistent/codex");
  expect(() => resolveCodexExecutable()).toThrow();
});
