import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const tasks = [
  { label: "cargo fmt", command: ["cargo", "fmt", "--check"] },
  { label: "cargo test", command: ["cargo", "test", "--workspace"] },
  {
    label: "context-stilld paths",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "paths", "--json"],
  },
  {
    label: "context-stilld status",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "status", "--json"],
  },
  {
    label: "context-stilld resident run once",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "run", "--once", "--json"],
  },
  {
    label: "context-stilld bootstrap preflight",
    command: [
      "cargo",
      "run",
      "-q",
      "-p",
      "context-stilld",
      "--",
      "bootstrap",
      "preflight",
      "--json",
    ],
  },
  {
    label: "context-stilld doctor summary",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "doctor", "summary", "--json"],
  },
  {
    label: "context-stilld backup preflight",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "backup", "preflight", "--json"],
  },
  {
    label: "context-stilld queue status",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "queue", "status", "--json"],
  },
  {
    label: "context-stilld mcp endpoint",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "mcp", "endpoint", "--json"],
  },
  {
    label: "context-stilld mcp sessions",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "mcp", "sessions", "--json"],
  },
  {
    label: "context-stilld mcp smoke",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "mcp", "smoke", "--json"],
  },
  { label: "rust managed mcp smoke", command: ["bun", "scripts/rust-managed-mcp-smoke.mjs"] },
  { label: "rust managed queue smoke", command: ["bun", "scripts/rust-managed-queue-smoke.mjs"] },
  { label: "rust admin api smoke", command: ["bun", "scripts/rust-admin-api-smoke.mjs"] },
  {
    label: "rust agent log sync smoke",
    command: ["bun", "scripts/rust-agent-log-sync-smoke.mjs"],
  },
  { label: "typescript unit tests", command: ["bun", "run", "test:unit"] },
];

function formatDuration(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function runTask(task) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const [bin, ...args] = task.command;
    console.log(`[verify:rust-daemon] ${task.label} ...`);
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTEXT_STILL_APP_DATA_DIR:
          process.env.CONTEXT_STILL_APP_DATA_DIR ?? ".tmp/context-stilld-verify",
      },
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
  console.error(`[verify:rust-daemon] ${result.task.label} failed (${result.duration})`);
  if (result.stdout.trim()) {
    console.error(`\n--- ${result.task.label} stdout ---`);
    console.error(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    console.error(`\n--- ${result.task.label} stderr ---`);
    console.error(result.stderr.trimEnd());
  }
}

function assertJsonLine(result, expectedField) {
  try {
    const json = JSON.parse(result.stdout);
    if (!(expectedField in json)) {
      return {
        ...result,
        code: 1,
        stderr: `${result.stderr}\nMissing expected field: ${expectedField}\n`,
      };
    }
  } catch (error) {
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}\nOutput was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    };
  }
  return result;
}

for (const task of tasks) {
  let result = await runTask(task);
  if (task.label === "context-stilld paths" && result.code === 0) {
    result = assertJsonLine(result, "appDataDir");
  }
  if (task.label === "context-stilld status" && result.code === 0) {
    result = assertJsonLine(result, "runtimeHost");
  }
  if (task.label === "context-stilld resident run once" && result.code === 0) {
    result = assertJsonLine(result, "surfaces");
  }
  if (task.label === "context-stilld bootstrap preflight" && result.code === 0) {
    result = assertJsonLine(result, "overallStatus");
  }
  if (task.label === "context-stilld doctor summary" && result.code === 0) {
    result = assertJsonLine(result, "delegatedFullDoctor");
  }
  if (task.label === "context-stilld backup preflight" && result.code === 0) {
    result = assertJsonLine(result, "delegatedBackupCommand");
  }
  if (task.label === "context-stilld queue status" && result.code === 0) {
    result = assertJsonLine(result, "process");
  }
  if (task.label === "context-stilld mcp endpoint" && result.code === 0) {
    result = assertJsonLine(result, "url");
  }
  if (task.label === "context-stilld mcp sessions" && result.code === 0) {
    result = assertJsonLine(result, "activeSessionCount");
  }
  if (task.label === "context-stilld mcp smoke" && result.code === 0) {
    result = assertJsonLine(result, "ok");
  }
  if (task.label.startsWith("rust ") && result.code === 0) {
    result = assertJsonLine(result, "ok");
  }
  if (result.code !== 0) {
    printFailure(result);
    process.exit(result.code);
  }
  console.log(`[verify:rust-daemon] ${task.label} ok (${result.duration})`);
}
