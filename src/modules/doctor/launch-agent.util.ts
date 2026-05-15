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
