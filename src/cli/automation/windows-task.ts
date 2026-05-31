import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WindowsTaskDefinition = {
  taskName: string;
  description: string;
  templatePath: string;
  command: string;
  arguments: string;
  workingDirectory: string;
  intervalMinutes: number;
};

function ensureWindows(action: string): void {
  if (process.platform !== "win32") {
    throw new Error(`${action} is only supported on Windows Task Scheduler.`);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function readTemplate(templatePath: string): string {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`task template not found: ${templatePath}`);
  }
  return fs.readFileSync(templatePath, "utf8");
}

function toIsoLocalBoundary(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function buildTaskXml(definition: WindowsTaskDefinition): string {
  const template = readTemplate(definition.templatePath);
  const intervalMinutes = Math.max(1, Math.floor(definition.intervalMinutes));
  const startBoundary = new Date(Date.now() + 60_000);
  return template
    .replaceAll("{{DESCRIPTION}}", escapeXml(definition.description))
    .replaceAll("{{START_BOUNDARY}}", toIsoLocalBoundary(startBoundary))
    .replaceAll("{{INTERVAL_ISO8601}}", `PT${intervalMinutes}M`)
    .replaceAll("{{COMMAND}}", escapeXml(definition.command))
    .replaceAll("{{ARGUMENTS}}", escapeXml(definition.arguments))
    .replaceAll("{{WORKING_DIRECTORY}}", escapeXml(definition.workingDirectory));
}

function writeTempTaskXml(taskName: string, xml: string): string {
  const tempDir = path.join(os.tmpdir(), "context-still-task-xml");
  fs.mkdirSync(tempDir, { recursive: true });
  const safeName = taskName.replaceAll(/[\\/:*?"<>|]/g, "_");
  const tempPath = path.join(tempDir, `${safeName}.xml`);
  fs.writeFileSync(tempPath, xml, "utf8");
  return tempPath;
}

function runSchtasks(args: string[]): string {
  const result = execFileSync("schtasks", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.trim();
}

export function installWindowsTask(definition: WindowsTaskDefinition): void {
  ensureWindows("install");
  const xml = buildTaskXml(definition);
  const tempPath = writeTempTaskXml(definition.taskName, xml);
  try {
    runSchtasks(["/create", "/tn", definition.taskName, "/xml", tempPath, "/f"]);
    console.log(`installed: ${definition.taskName}`);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function uninstallWindowsTask(taskName: string): void {
  ensureWindows("uninstall");
  runSchtasks(["/delete", "/tn", taskName, "/f"]);
  console.log(`removed: ${taskName}`);
}

export function enableWindowsTask(taskName: string): void {
  ensureWindows("load");
  runSchtasks(["/change", "/tn", taskName, "/enable"]);
  console.log(`enabled: ${taskName}`);
}

export function disableWindowsTask(taskName: string): void {
  ensureWindows("unload");
  runSchtasks(["/change", "/tn", taskName, "/disable"]);
  console.log(`disabled: ${taskName}`);
}

export function printWindowsTaskStatus(taskName: string): void {
  ensureWindows("status");
  const output = runSchtasks(["/query", "/tn", taskName, "/fo", "LIST", "/v"]);
  console.log(output);
}
