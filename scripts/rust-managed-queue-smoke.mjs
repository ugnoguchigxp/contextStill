import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-stilld-queue-smoke-"));
const env = {
  ...process.env,
  CONTEXT_STILL_APP_DATA_DIR: appDataDir,
  CONTEXT_STILL_PROJECT_ROOT: root,
  CONTEXT_STILL_DB_BACKEND: "sqlite",
  CONTEXT_STILL_SQLITE_CORE_PATH: path.join(appDataDir, "queue-smoke.sqlite"),
  CONTEXT_STILL_RESIDENT_QUEUE_MODE: "rust-managed-one-shot",
  CONTEXT_STILL_MCP_PORT: "0",
};
fs.closeSync(fs.openSync(env.CONTEXT_STILL_SQLITE_CORE_PATH, "w"));

function run(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${args.join(" ")} failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function cargo(...args) {
  return run(["cargo", "run", "-q", "-p", "context-stilld", "--", ...args]);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}\n${text}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

try {
  const run = parseJson(cargo("run", "--once", "--json"), "resident run once");
  const queueSurface = run.surfaces?.find((surface) => surface.name === "queue-supervisor");
  if (!queueSurface) {
    throw new Error(`resident run did not report queue surface: ${JSON.stringify(run)}`);
  }
  if (queueSurface.status !== "scheduled") {
    throw new Error(`unexpected Rust-managed queue surface: ${JSON.stringify(queueSurface)}`);
  }
  const queueLogPath = path.join(appDataDir, "logs", "queue-supervisor.log");
  const queueLog = fs.readFileSync(queueLogPath, "utf8");
  if (!queueLog.includes('"worker": "queue-supervisor"') || !queueLog.includes('"runs"')) {
    throw new Error(`resident queue tick did not invoke executor; log:\n${queueLog}`);
  }

  const status = parseJson(cargo("queue", "status", "--json"), "queue status");
  if (status.status !== "scheduled") {
    throw new Error(`queue supervisor should be Rust-scheduled, got: ${JSON.stringify(status)}`);
  }

  console.log(JSON.stringify({ ok: true, status: status.status, appDataDir }, null, 2));
} finally {
  try {
    cargo("queue", "stop", "--json");
  } catch {}
}
