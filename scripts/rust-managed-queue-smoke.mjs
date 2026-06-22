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
};

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
  const start = parseJson(cargo("queue", "start", "--json"), "queue start");
  if (!["started", "already_running"].includes(start.status)) {
    throw new Error(`unexpected queue start status: ${JSON.stringify(start)}`);
  }

  let status;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    status = parseJson(cargo("queue", "status", "--json"), "queue status");
    if (status.status === "running") break;
    sleep(250);
  }
  if (status?.status !== "running") {
    throw new Error(`queue supervisor did not stay running: ${JSON.stringify(status)}`);
  }

  console.log(JSON.stringify({ ok: true, pid: status.pid, appDataDir }, null, 2));
} finally {
  try {
    cargo("queue", "stop", "--json");
  } catch {}
}
