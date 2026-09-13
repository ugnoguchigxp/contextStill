import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAuditRegistryRelay } from "./audit-registry-relay.mjs";
import { classifyAudit } from "./testing/audit-policy.mjs";
const directory = await mkdtemp(path.join(tmpdir(), "contextstill-audit-"));
const output = path.resolve("artifacts/dependency-audit");
await mkdir(output, { recursive: true });
const exceptions = JSON.parse(await readFile("scripts/testing/audit-exceptions.json", "utf8"));
const auditEnv = Object.fromEntries(
  ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR", "SystemRoot"]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
async function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: auditEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ code: null, error: true, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
try {
  for (const name of ["package.json", "bun.lock", "Cargo.lock"])
    await copyFile(name, path.join(directory, name));
  const reports = [];
  for (const [tool, command, args] of [
    ["bun", "bun", ["audit", "--json"]],
    ["cargo", "cargo", ["audit", "--json", "--file", "Cargo.lock"]],
  ]) {
    let execution = await run(command, args, tool === "bun" ? 30_000 : 120_000);
    let transport = "direct";
    let directFailure;
    if (tool === "bun" && (execution.signal || execution.error)) {
      directFailure = classifyAudit(tool, execution, exceptions);
      await writeFile(path.join(output, "bun-direct-stderr.txt"), execution.stderr);
      await writeFile(path.join(output, "bun-direct-raw.json"), execution.stdout);
      const relay = startAuditRegistryRelay(auditEnv);
      try {
        await writeFile(
          path.join(directory, "bunfig.toml"),
          `[install]\nregistry = "${relay.registry}"\n`,
        );
        execution = await run(command, args, 45_000);
        if (relay.requests() !== 1) execution.error = true;
        transport = "curl-https-relay";
      } finally {
        relay.close();
      }
    }
    await writeFile(path.join(output, `${tool}-raw.json`), execution.stdout);
    await writeFile(path.join(output, `${tool}-stderr.txt`), execution.stderr);
    const report = {
      tool,
      transport,
      ...(directFailure ? { directFailure } : {}),
      ...classifyAudit(tool, execution, exceptions),
    };
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  await writeFile(path.join(output, "summary.json"), `${JSON.stringify(reports, null, 2)}\n`);
  if (reports.some((r) => r.fail)) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
