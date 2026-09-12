import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function discoverBunTests(directory, prefix = "test") {
  const tests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      tests.push(...(await discoverBunTests(path.join(directory, entry.name), name)));
    } else if (entry.isFile() && entry.name.endsWith(".bun.ts")) {
      tests.push(name);
    }
  }
  return tests.sort();
}

export function validateSqliteManifest(manifest, discovered) {
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.tests) ||
    manifest.tests.length === 0 ||
    manifest.tests.some((name) => typeof name !== "string")
  ) {
    throw new Error("Invalid SQLite test manifest");
  }
  const errors = [];
  const registered = new Set(manifest.tests);
  if (registered.size !== manifest.tests.length) errors.push("Duplicate SQLite test entries");
  for (const name of discovered) {
    if (!registered.has(name)) errors.push(`Unregistered Bun test: ${name}`);
  }
  for (const name of registered) {
    if (!discovered.includes(name)) errors.push(`Missing Bun test: ${name}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return [...registered].sort();
}

export function sqliteTestEnvironment(inherited, directory) {
  // Do not forward provider credentials, live DB paths, endpoint descriptors or .env settings.
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "RUSTUP_TOOLCHAIN",
      "SystemRoot",
    ]
      .filter((key) => inherited[key] !== undefined)
      .map((key) => [key, inherited[key]]),
  );
  return {
    ...env,
    NODE_ENV: "test",
    DOTENV_CONFIG_PATH: path.join(directory, "empty.env"),
    CONTEXT_STILL_APP_DATA_DIR: directory,
    CONTEXT_STILL_DB_BACKEND: "sqlite",
    CONTEXT_STILL_SQLITE_CORE_PATH: path.join(directory, "core.sqlite"),
    CONTEXT_STILL_MCP_ENDPOINT_PATH: path.join(directory, "mcp-endpoint.json"),
    CONTEXT_STILL_SOURCE_CONTENT_ROOT: path.join(directory, "sources"),
    CONTEXT_STILL_EMBEDDING_PROVIDER: "disabled",
    DATABASE_URL: "postgres://test:test@127.0.0.1:1/disabled",
  };
}

export function runTestProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      timeout: 180_000,
      killSignal: "SIGKILL",
    });
    child.on("error", () => resolve(1));
    child.on("close", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--check", "--coverage"].includes(args[0]))) {
    throw new Error("Usage: bun scripts/testing/sqlite-test-suite.mjs [--check|--coverage]");
  }
  const manifest = JSON.parse(
    await readFile(new URL("./sqlite-test-manifest.json", import.meta.url), "utf8"),
  );
  const tests = validateSqliteManifest(
    manifest,
    await discoverBunTests(path.join(projectRoot, "test")),
  );
  console.log(`[sqlite] manifest covers ${tests.length} Bun test files`);
  if (args[0] === "--check") return;

  if (args[0] === "--coverage")
    await rm(
      path.resolve(
        projectRoot,
        process.env.CONTEXT_STILL_COVERAGE_DIR ?? "artifacts/coverage",
        "bun",
      ),
      { recursive: true, force: true },
    );
  const failures = [];
  for (const test of tests) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "context-still-sqlite-suite-"));
    try {
      await writeFile(path.join(directory, "empty.env"), "");
      console.log(`[sqlite] ${test}`);
      const coverage =
        args[0] === "--coverage"
          ? [
              "--coverage",
              "--coverage-reporter=lcov",
              `--coverage-dir=${path.resolve(projectRoot, process.env.CONTEXT_STILL_COVERAGE_DIR ?? "artifacts/coverage", "bun", path.basename(test, ".bun.ts"))}`,
            ]
          : [];
      if (coverage.length)
        await mkdir(
          path.resolve(
            projectRoot,
            process.env.CONTEXT_STILL_COVERAGE_DIR ?? "artifacts/coverage",
            "bun",
          ),
          { recursive: true },
        );
      const code = await runTestProcess(
        process.execPath,
        ["--no-env-file", "test", ...coverage, `./${test}`],
        {
          cwd: projectRoot,
          env: sqliteTestEnvironment(process.env, directory),
        },
      );
      if (code !== 0) failures.push(test);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (failures.length) {
    throw new Error(
      `SQLite suite failed (${failures.length}/${tests.length}): ${failures.join(", ")}`,
    );
  }
  console.log(`[sqlite] all ${tests.length} test files passed`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
