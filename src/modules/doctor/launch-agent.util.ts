import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DoctorReport } from "../../shared/schemas/doctor.schema.js";

export async function pathExists(filePath: string): Promise<boolean> {
  if (!filePath.trim()) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function inspectLaunchAgent(
  label: string,
): Promise<DoctorReport["agentLogSync"]["launchAgent"]> {
  if (process.platform === "win32") {
    const taskName = toWindowsTaskName(label);
    if (!taskName) {
      return { label, plistPath: label, installed: false, loaded: false, state: null };
    }

    let installed = false;
    let loaded = false;
    let state: string | null = null;
    try {
      const output = execFileSync("schtasks", ["/query", "/tn", taskName, "/fo", "LIST", "/v"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      installed = true;
      const stateLine = output
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().includes("scheduled task state"));
      state = stateLine?.split(":").slice(1).join(":").trim() ?? "unknown";
      loaded = state?.toLowerCase() === "enabled";
    } catch {
      installed = false;
      loaded = false;
      state = null;
    }

    return {
      label,
      plistPath: taskName,
      installed,
      loaded,
      state,
    };
  }

  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const installed = await pathExists(plistPath);
  let loaded = false;
  let state: string | null = null;

  if (installed && typeof process.getuid === "function") {
    try {
      const output = execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      loaded = true;
      state = output.match(/state = ([^\n]+)/)?.[1]?.trim() ?? null;
    } catch {
      loaded = false;
    }
  }

  return { label, plistPath, installed, loaded, state };
}

function toWindowsTaskName(label: string): string | null {
  if (label === "com.context-still.daemon") return "\\context-still\\daemon";
  return null;
}
