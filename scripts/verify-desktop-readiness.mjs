import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const tasks = [
  { label: "docs:check-links", command: ["bun", "run", "docs:check-links"] },
  { label: "typecheck", command: ["bun", "run", "typecheck"] },
  { label: "test:sqlite-core", command: ["bun", "run", "test:sqlite-core"] },
  { label: "test:sqlite-knowledge", command: ["bun", "run", "test:sqlite-knowledge"] },
  { label: "test:sqlite-migration", command: ["bun", "run", "test:sqlite-migration"] },
  { label: "test:sqlite-runtime", command: ["bun", "run", "test:sqlite-runtime"] },
  { label: "mcp:smoke:sqlite", command: ["bun", "run", "mcp:smoke:sqlite"] },
];

function formatDuration(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function runCommand(task, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const [bin, ...args] = task.command;
    console.log(`[verify:desktop-readiness] ${task.label} ...`);
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ["inherit", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({
        task,
        code: 1,
        duration: formatDuration(startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}\n`,
      });
    });
    child.on("close", (code) => {
      resolve({
        task,
        code: code ?? 1,
        duration: formatDuration(startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function printFailure(result) {
  console.error(`[verify:desktop-readiness] ${result.task.label} failed (${result.duration})`);
  if (result.stdout.trim()) {
    console.error(`\n--- ${result.task.label} stdout ---`);
    console.error(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    console.error(`\n--- ${result.task.label} stderr ---`);
    console.error(result.stderr.trimEnd());
  }
}

async function runDesktopDoctorSmoke() {
  const dir = await mkdtemp(path.join(tmpdir(), "context-still-desktop-"));
  const sqlitePath = path.join(dir, "context-still.sqlite");
  try {
    const result = await runCommand(
      {
        label: "doctor:sqlite-desktop",
        command: ["bun", "run", "src/cli/doctor.ts", "--json"],
      },
      {
        CONTEXT_STILL_DB_BACKEND: "sqlite",
        CONTEXT_STILL_SQLITE_CORE_PATH: sqlitePath,
      },
    );
    if (result.code !== 0) return result;
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch (error) {
      return {
        ...result,
        code: 1,
        stderr: `${result.stderr}\nDoctor output was not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      };
    }
    const desktopReadiness = report.desktopReadiness;
    const reasons = Array.isArray(report.reasons) ? report.reasons : [];
    if (!desktopReadiness || desktopReadiness.backendCategory !== "sqlite-local") {
      return {
        ...result,
        code: 1,
        stderr: `${result.stderr}\nDoctor did not report sqlite-local desktop readiness.\n`,
      };
    }
    if (reasons.includes("VECTOR_EXTENSION_MISSING")) {
      return {
        ...result,
        code: 1,
        stderr: `${result.stderr}\nDoctor reported pgvector remediation in sqlite desktop mode.\n`,
      };
    }
    console.log(`[verify:desktop-readiness] doctor:sqlite-desktop ok (${result.duration})`);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const task of tasks) {
  const result = await runCommand(task);
  if (result.code !== 0) {
    printFailure(result);
    process.exit(result.code);
  }
  console.log(`[verify:desktop-readiness] ${task.label} ok (${result.duration})`);
}

const doctorResult = await runDesktopDoctorSmoke();
if (doctorResult.code !== 0) {
  printFailure(doctorResult);
  process.exit(doctorResult.code);
}
