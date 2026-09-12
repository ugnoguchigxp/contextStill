import { spawn } from "node:child_process";
import { constants, accessSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const SPARK_MODEL = "gpt-5.3-codex-spark";
export type SparkAvailability = { available: boolean; retryAt?: number };

type LimitWindow = { usedPercent?: number; resetsAt?: number };
export function sparkQuotaAvailability(
  limits: Record<string, any>,
  now = Date.now() / 1000,
): SparkAvailability {
  const bucket = Object.entries(limits.rateLimitsByLimitId ?? {}).find(
    ([id, item]) =>
      id === "codex_bengalfox" ||
      (item as Record<string, unknown>)?.limitName === "GPT-5.3-Codex-Spark" ||
      (item as Record<string, unknown>)?.limitId === "codex_bengalfox",
  )?.[1] as { primary?: LimitWindow | null; secondary?: LimitWindow | null } | undefined;
  if (!bucket) throw new Error("Spark quota information is unavailable");
  const windows = [bucket.primary, bucket.secondary].filter((w): w is LimitWindow => w != null);
  if (
    !windows.length ||
    windows.some((w) => !Number.isFinite(w.usedPercent) || (w.usedPercent ?? -1) < 0)
  )
    throw new Error("Spark quota windows are unavailable");
  const exhausted = windows.filter((w) => (w.usedPercent ?? 0) >= 100);
  if (!exhausted.length) return { available: true };
  // Integer seconds are shared with Rust and persisted in SQLite.
  const current = Math.ceil(now);
  return {
    available: false,
    retryAt: Math.max(
      current + 60,
      ...exhausted.map((w) =>
        typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)
          ? Math.ceil(w.resetsAt)
          : current + 300,
      ),
    ),
  };
}

export function resolveCodexExecutable(): string {
  const override = process.env.CONTEXT_STILL_CODEX_CLI_PATH?.trim();
  if (override) return nativeCodexExecutable(override);
  // Use the installed CLI consistently for preflight and SDK execution. The SDK's
  // bundled CLI may lag behind the account's available model catalog.
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // `bun run` prepends node_modules/.bin. Prefer the installed CLI over that
  // implicitly injected SDK bundle, regardless of the caller's launch method.
  directories.sort(
    (a, b) => Number(a.includes("node_modules")) - Number(b.includes("node_modules")),
  );
  for (const directory of directories) {
    const executable = path.join(directory, "codex");
    try {
      return nativeCodexExecutable(executable);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("@openai/codex/package.json"));
  return nativeCodexExecutable(path.join(root, "bin", "codex.js"));
}

// npm's CLI entrypoint needs Node on PATH. LaunchAgent PATH commonly lacks Node;
// resolve the same package's native executable before launching either SDK or preflight.
function nativeCodexExecutable(executable: string): string {
  accessSync(executable, constants.X_OK);
  if (!statSync(executable).isFile()) throw new Error("Codex executable is not a file");
  const real = realpathSync(executable);
  if (!real.endsWith(`${path.sep}bin${path.sep}codex.js`)) return real;
  const platforms: Record<string, [string, string]> = {
    "darwin-arm64": ["darwin-arm64", "aarch64-apple-darwin"],
    "darwin-x64": ["darwin-x64", "x86_64-apple-darwin"],
    "linux-arm64": ["linux-arm64", "aarch64-unknown-linux-musl"],
    "linux-x64": ["linux-x64", "x86_64-unknown-linux-musl"],
  };
  const platform = platforms[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error("Unsupported Codex queue platform");
  const codexRequire = createRequire(real);
  const packageRoot = path.resolve(path.dirname(real), "..");
  let root = packageRoot;
  try {
    root = path.dirname(codexRequire.resolve(`@openai/codex-${platform[0]}/package.json`));
  } catch {
    /* Older npm packages keep vendor binaries inside @openai/codex. */
  }
  for (const layout of ["bin", "codex"]) {
    const native = path.join(root, "vendor", platform[1], layout, "codex");
    try {
      accessSync(native, constants.X_OK);
      if (statSync(native).isFile()) return native;
    } catch {
      /* Try the other supported bundle layout. */
    }
  }
  throw new Error("Codex native executable is unavailable");
}

/** Read account, catalog and quota without starting a thread or generation. */
export async function readSparkAvailability(executable: string): Promise<SparkAvailability> {
  const child = spawn(executable, ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: sparkEnvironment(),
  });
  let buffer = "";
  let bytes = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  let terminalError: Error | undefined;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const fail = (error: Error) => {
    terminalError ??= error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => {
    fail(new Error("Spark availability check timed out"));
    child.kill();
  }, 15_000);
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("Codex availability process exited")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2_000_000) {
      fail(new Error("Codex availability response too large"));
      child.kill();
      return;
    }
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(line);
        const item = pending.get(event.id);
        if (item) {
          pending.delete(event.id);
          event.error
            ? item.reject(new Error("Codex availability RPC failed"))
            : item.resolve(event.result);
        }
      } catch {
        fail(new Error("Invalid Codex availability response"));
      }
      index = buffer.indexOf("\n");
    }
  });
  let sequence = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    if (terminalError) return Promise.reject(terminalError);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  try {
    await rpc("initialize", { clientInfo: { name: "contextstill_spark_queue", version: "1.0.0" } });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const { account } = await rpc("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt" || account.planType !== "pro")
      throw new Error("Spark queue requires ChatGPT Pro authentication");
    let cursor: string | undefined;
    let found = false;
    do {
      const result = await rpc("model/list", {
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      });
      found ||=
        result.data?.some((model: { model: string }) => model.model === SPARK_MODEL) ?? false;
      cursor = result.nextCursor ?? undefined;
    } while (cursor && !found);
    if (!found) throw new Error("Spark is not available in the configured Codex CLI catalog");
    return sparkQuotaAvailability(await rpc("account/rateLimits/read"));
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await closed;
  }
}

export function sparkEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete env[key];
  return env;
}
