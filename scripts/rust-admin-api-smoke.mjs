import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-stilld-admin-api-smoke-"));
const port = String(42000 + Math.floor(Math.random() * 10000));
const env = {
  ...process.env,
  CONTEXT_STILL_APP_DATA_DIR: appDataDir,
  CONTEXT_STILL_PROJECT_ROOT: root,
  CONTEXT_STILL_DB_BACKEND: "sqlite",
  CONTEXT_STILL_SQLITE_CORE_PATH: path.join(appDataDir, "admin-api-smoke.sqlite"),
  CONTEXT_STILL_ADMIN_API_READY_TIMEOUT_MS: "10000",
  PORT: port,
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

try {
  const start = parseJson(cargo("admin-api", "start", "--json"), "admin-api start");
  if (start.status !== "started" && start.status !== "already_running") {
    throw new Error(`unexpected admin-api start status: ${JSON.stringify(start)}`);
  }
  const status = parseJson(cargo("admin-api", "status", "--json"), "admin-api status");
  if (status.status !== "running") {
    throw new Error(`admin-api should be running: ${JSON.stringify(status)}`);
  }
  console.log(JSON.stringify({ ok: true, port, pid: status.pid, appDataDir }, null, 2));
} finally {
  try {
    cargo("admin-api", "stop", "--json");
  } catch {}
}
