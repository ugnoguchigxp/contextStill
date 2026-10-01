import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { filePathToSlug } from "./slug.js";
import { WikiError, strictWikiSlug, wikiWriteSuccessSchema } from "./wiki-contract.js";

export function wikiStateRoot(contentRoot: string): string {
  const appData =
    process.env.CONTEXT_STILL_APP_DATA_DIR ??
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "contextStill")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? os.homedir(), "contextStill")
        : path.join(
            process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
            "contextStill",
          ));
  return path.join(appData, "run", "wiki", createHash("sha256").update(contentRoot).digest("hex"));
}
export async function privateDirectory(directory: string): Promise<void> {
  // Validate existing ancestors before creating anything through a symlink.
  let ancestor = path.resolve(directory);
  while (true) {
    try {
      if ((await fs.realpath(ancestor)) !== ancestor)
        throw new WikiError("UNSAFE_RUNTIME_DIRECTORY", 503);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(directory)) !== path.resolve(directory)
  )
    throw new WikiError("UNSAFE_RUNTIME_DIRECTORY", 503);
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const dir = await fs.open(path.dirname(file), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    if (created) await fs.rm(temporary, { force: true });
  }
}
export async function withWikiWriteLock<T>(
  root: string,
  action: () => Promise<T>,
  waitMs = 5000,
): Promise<T> {
  const canonical = await fs.realpath(root);
  let gitDirectory: string;
  try {
    const execute = promisify(execFile);
    const result = await execute("git", ["-C", canonical, "rev-parse", "--absolute-git-dir"]);
    gitDirectory = await fs.realpath(result.stdout.trim());
  } catch {
    throw new WikiError("GIT_NOT_INITIALIZED", 503);
  }
  const directory = path.join(gitDirectory, "wiki-cli");
  await privateDirectory(directory);
  const lock = path.join(directory, "write.lock");
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new WikiError("WIKI_BUSY", 503, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await atomicJson(path.join(lock, "owner.json"), {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const stateDirectory = wikiStateRoot(canonical);
    await privateDirectory(stateDirectory);
    try {
      await fs.lstat(path.join(stateDirectory, "write.lock"));
      throw new WikiError("WIKI_BUSY", 503, true);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const bindingFile = path.join(directory, "runtime.json");
    try {
      const stat = await fs.lstat(bindingFile);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 16 * 1024
      )
        throw new WikiError("RECOVERY_REQUIRED", 503);
      const binding: unknown = JSON.parse(await fs.readFile(bindingFile, "utf8"));
      if (
        !binding ||
        typeof binding !== "object" ||
        !("stateDirectory" in binding) ||
        binding.stateDirectory !== stateDirectory
      )
        throw new WikiError("WIKI_RUNTIME_MISMATCH", 503);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw error instanceof WikiError ? error : new WikiError("RECOVERY_REQUIRED", 503);
      await atomicJson(bindingFile, { stateDirectory });
    }
    return await action();
  } finally {
    await fs.rm(lock, { recursive: true });
  }
}
export type WikiOperation = {
  id: string;
  inputHash: string;
  slug: string;
  command: "create" | "update";
  oldVersion: string | null;
  newVersion: string;
  pagePath: string;
  phase: "prepared" | "saved" | "committed" | "complete";
  head: string | null;
  commit?: string;
  stagedVersion?: string;
  sourceId?: string;
  result?: Record<string, unknown>;
};
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const version = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const operationSchema = z
  .object({
    id: z.string().uuid(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    slug: z.string().refine((value) => {
      try {
        strictWikiSlug(value);
        return true;
      } catch {
        return false;
      }
    }),
    command: z.enum(["create", "update"]),
    oldVersion: version.nullable(),
    newVersion: version,
    pagePath: z.string().endsWith(".md"),
    phase: z.enum(["prepared", "saved", "committed", "complete"]),
    head: objectId.nullable(),
    commit: objectId.optional(),
    stagedVersion: version.optional(),
    sourceId: z.string().min(1).optional(),
    result: wikiWriteSuccessSchema.optional(),
  })
  .strict()
  .refine((op) => (op.command === "create") === (op.oldVersion === null))
  .refine((op) => !op.stagedVersion || op.stagedVersion === op.newVersion)
  .refine((op) => filePathToSlug(op.pagePath) === op.slug)
  .refine((op) => !["committed", "complete"].includes(op.phase) || Boolean(op.commit))
  .refine(
    (op) =>
      op.phase !== "complete" ||
      (op.result?.operationId === op.id &&
        op.result.page.slug === op.slug &&
        op.result.page.version === op.newVersion &&
        op.result.commit === op.commit &&
        op.result.sourceId === op.sourceId &&
        op.result.command === op.command),
  );
export async function readOperation(file: string): Promise<WikiOperation | null> {
  try {
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 64 * 1024
    )
      throw new WikiError("RECOVERY_REQUIRED", 503);
    const result = operationSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
    if (!result.success || result.data.id !== path.basename(file, ".json"))
      throw new WikiError("RECOVERY_REQUIRED", 503);
    return result.data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new WikiError("RECOVERY_REQUIRED", 503);
  }
}
