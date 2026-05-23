import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  disableWindowsTask,
  enableWindowsTask,
  installWindowsTask,
  printWindowsTaskStatus,
  uninstallWindowsTask,
} from "./automation/windows-task.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const plistDir = path.resolve(projectRoot, "scripts/automation");
const launchAgentsDir = path.resolve(os.homedir(), "Library/LaunchAgents");
const plist = "com.memory-router.distill-pipeline.plist";
const label = "com.memory-router.distill-pipeline";
const windowsTaskTemplatePath = path.resolve(
  projectRoot,
  "scripts/automation/windows/com.memory-router.distill-pipeline.task.xml",
);
const windowsTaskName = "\\memory-router\\distill-pipeline";
const legacyLabels = [
  "com.memory-router.vibe-distillation",
  "com.memory-router.source-distillation",
];

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function ensureDarwinForLaunchCtl(action: string): void {
  if (!isDarwin()) {
    throw new Error(
      `${action} is only supported on macOS. Use run-once or run-continuous for Windows/Linux.`,
    );
  }
}

function getUid(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("uid is unavailable on this platform.");
  }
  return String(process.getuid());
}

function resolveBunPath(): string {
  return process.execPath || "bun";
}

function buildPipelineArgs(continuous: boolean): string[] {
  const pipelineKind = process.env.MEMORY_ROUTER_DISTILL_PIPELINE_KIND ?? "auto";
  const pipelineLimit = process.env.MEMORY_ROUTER_DISTILL_PIPELINE_LIMIT ?? "1";
  const pipelineRefresh = process.env.MEMORY_ROUTER_DISTILL_PIPELINE_REFRESH ?? "1";
  const pipelineProvider = process.env.MEMORY_ROUTER_DISTILL_PIPELINE_PROVIDER ?? "";
  const pipelineVersion = process.env.MEMORY_ROUTER_DISTILL_PIPELINE_VERSION ?? "";

  const args = [
    "run",
    "src/cli/distill-pipeline.ts",
    "--write",
    "--limit",
    pipelineLimit,
    "--kind",
    pipelineKind,
  ];
  if (continuous) args.push("--continuous");
  if (pipelineRefresh === "0") args.push("--no-refresh");
  if (pipelineProvider) args.push("--provider", pipelineProvider);
  if (pipelineVersion) args.push("--version", pipelineVersion);
  return args;
}

function install(): void {
  if (process.platform === "win32") {
    const intervalSeconds = Number(
      process.env.MEMORY_ROUTER_DISTILL_PIPELINE_INTERVAL_SECONDS ?? "120",
    );
    const intervalMinutes = Number.isFinite(intervalSeconds)
      ? Math.max(1, Math.floor(intervalSeconds / 60))
      : 2;
    installWindowsTask({
      taskName: windowsTaskName,
      description: "Run memory-router distillation pipeline on schedule",
      templatePath: windowsTaskTemplatePath,
      command: resolveBunPath(),
      arguments: `run ${path.resolve(projectRoot, "src/cli/distill-pipeline-automation.ts")} run-once`,
      workingDirectory: projectRoot,
      intervalMinutes,
    });
    return;
  }
  ensureDarwinForLaunchCtl("install");
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(path.resolve(projectRoot, "logs"), { recursive: true });
  const template = readFileSync(path.resolve(plistDir, plist), "utf8");
  const rendered = template
    .replaceAll("{{PROJECT_ROOT}}", projectRoot)
    .replaceAll("{{BUN_PATH}}", resolveBunPath());
  const target = path.resolve(launchAgentsDir, plist);
  writeFileSync(target, rendered, { encoding: "utf8", mode: 0o644 });
  console.log(`installed: ${target}`);
}

function launchctl(...args: string[]): void {
  execFileSync("launchctl", args, { stdio: "inherit" });
}

function launchctlQuiet(...args: string[]): void {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    // no-op
  }
}

function disableLegacyJobs(uid: string): void {
  for (const legacy of legacyLabels) {
    launchctlQuiet("bootout", `gui/${uid}/${legacy}`);
  }
}

function loadJob(): void {
  if (process.platform === "win32") {
    enableWindowsTask(windowsTaskName);
    return;
  }
  ensureDarwinForLaunchCtl("load");
  const target = path.resolve(launchAgentsDir, plist);
  if (!existsSync(target)) install();
  const uid = getUid();
  disableLegacyJobs(uid);
  launchctlQuiet("bootout", `gui/${uid}`, target);
  launchctl("bootstrap", `gui/${uid}`, target);
  console.log(`loaded: ${label}`);
}

function unloadJob(): void {
  if (process.platform === "win32") {
    disableWindowsTask(windowsTaskName);
    return;
  }
  ensureDarwinForLaunchCtl("unload");
  const target = path.resolve(launchAgentsDir, plist);
  const uid = getUid();
  launchctlQuiet("bootout", `gui/${uid}`, target);
  console.log(`unloaded: ${label}`);
}

function uninstall(): void {
  if (process.platform === "win32") {
    uninstallWindowsTask(windowsTaskName);
    return;
  }
  ensureDarwinForLaunchCtl("uninstall");
  unloadJob();
  const target = path.resolve(launchAgentsDir, plist);
  rmSync(target, { force: true });
  console.log(`removed: ${target}`);
}

function status(): void {
  if (process.platform === "win32") {
    printWindowsTaskStatus(windowsTaskName);
    return;
  }
  ensureDarwinForLaunchCtl("status");
  const target = path.resolve(launchAgentsDir, plist);
  if (!existsSync(target)) {
    console.log(`${label}: not installed`);
    return;
  }

  const uid = getUid();
  try {
    const output = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
    });
    console.log(`${label}: loaded`);
    console.log(output);
  } catch {
    console.log(`${label}: installed but not loaded`);
  }
}

function runOnce(): void {
  const args = buildPipelineArgs(false);
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${label} run started`);
  const result = spawnSync(resolveBunPath(), args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  const endStamp = new Date().toISOString();
  const exitCode = result.status ?? 1;
  console.log(`[${endStamp}] ${label} run finished exit_code=${exitCode}`);
  process.exitCode = exitCode;
}

function runContinuous(): void {
  const args = buildPipelineArgs(true);
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${label} continuous run started`);
  const result = spawnSync(resolveBunPath(), args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
}

function main(): void {
  const action = process.argv[2] ?? "";
  try {
    switch (action) {
      case "install":
        install();
        break;
      case "load":
        loadJob();
        break;
      case "unload":
        unloadJob();
        break;
      case "uninstall":
        uninstall();
        break;
      case "status":
        status();
        break;
      case "run-once":
        runOnce();
        break;
      case "run-continuous":
        runContinuous();
        break;
      default:
        console.error(
          "Usage: bun run src/cli/distill-pipeline-automation.ts -- {install|load|unload|uninstall|status|run-once|run-continuous}",
        );
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
