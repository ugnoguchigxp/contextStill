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
const plist = "com.memory-router.agent-log-sync.plist";
const label = "com.memory-router.agent-log-sync";
const windowsTaskTemplatePath = path.resolve(
  projectRoot,
  "scripts/automation/windows/com.memory-router.agent-log-sync.task.xml",
);
const windowsTaskName = "\\memory-router\\agent-log-sync";

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function ensureDarwinForLaunchCtl(action: string): void {
  if (!isDarwin()) {
    throw new Error(`${action} is only supported on macOS. Use run-once on Windows/Linux.`);
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

function install(): void {
  if (process.platform === "win32") {
    const intervalSeconds = Number(
      process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS ?? "3600",
    );
    const intervalMinutes = Number.isFinite(intervalSeconds)
      ? Math.max(1, Math.floor(intervalSeconds / 60))
      : 60;
    installWindowsTask({
      taskName: windowsTaskName,
      description: "Sync Codex and Antigravity logs into memory-router vibe memories",
      templatePath: windowsTaskTemplatePath,
      command: resolveBunPath(),
      arguments: `run ${path.resolve(projectRoot, "src/cli/sync-agent-logs.ts")}`,
      workingDirectory: projectRoot,
      intervalMinutes,
    });
    return;
  }
  ensureDarwinForLaunchCtl("install");
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(path.resolve(projectRoot, "logs"), { recursive: true });
  const template = readFileSync(path.resolve(plistDir, plist), "utf8");
  const intervalSeconds = process.env.MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS ?? "3600";
  const rendered = template
    .replaceAll("{{PROJECT_ROOT}}", projectRoot)
    .replaceAll("{{BUN_PATH}}", resolveBunPath())
    .replaceAll("{{INTERVAL_SECONDS}}", intervalSeconds);
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

function loadJob(): void {
  if (process.platform === "win32") {
    enableWindowsTask(windowsTaskName);
    return;
  }
  ensureDarwinForLaunchCtl("load");
  const target = path.resolve(launchAgentsDir, plist);
  if (!existsSync(target)) install();
  const uid = getUid();
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
  const result = spawnSync(resolveBunPath(), ["run", "src/cli/sync-agent-logs.ts"], {
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
      default:
        console.error(
          "Usage: bun run src/cli/agent-log-sync-automation.ts -- {install|load|unload|uninstall|status|run-once}",
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
