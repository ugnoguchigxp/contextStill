import { createIsolatedRuntime } from "./testing/isolated-runtime.mjs";
const runtime = await createIsolatedRuntime();
try {
  await runtime.run("bun", ["run", "typecheck"]);
  await runtime.run("bun", ["run", "test:sqlite-all"], {}, 600_000);
  await runtime.initialize();
  console.log(await runtime.run("bun", ["--no-env-file", "src/cli/mcp-http-smoke.ts"]));
} finally {
  await runtime.cleanup();
}
