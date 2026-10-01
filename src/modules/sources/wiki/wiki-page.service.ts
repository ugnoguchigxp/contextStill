import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecretRecord, redactSecrets } from "../../../shared/utils/secret-redaction.js";
import {
  assertNoSymlinkComponents,
  readPage,
  serializeMarkdown,
  writePage,
} from "./content-repo.js";
import { WikiError, strictWikiSlug, validateRequestId, validateWikiBody } from "./wiki-contract.js";
import {
  type WikiOperation,
  atomicJson,
  privateDirectory,
  readOperation,
  wikiStateRoot,
  withWikiWriteLock,
} from "./wiki-write-state.js";

const execute = promisify(execFile);
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
function serializeWikiPage(title: string, body: string, meta: Record<string, unknown>): string {
  try {
    return serializeMarkdown(title, body, meta);
  } catch {
    throw new WikiError("FINAL_PAGE_INVALID_OR_TOO_LARGE", 413);
  }
}
export type WikiWrite = {
  command: "create" | "update";
  slug: string;
  title?: string;
  body: string;
  ifVersion?: string;
  requestId: string;
  extract: boolean;
};
export type WikiWriteResponse = { status: 200 | 207 | 412; result: Record<string, unknown> };
type Dependencies = {
  root: string;
  namespace: string;
  preflight: () => Promise<void>;
  index: (page: NonNullable<Awaited<ReturnType<typeof readPage>>>) => Promise<string>;
};
const git = async (root: string, ...args: string[]) =>
  (await execute("git", ["-C", root, ...args], { maxBuffer: 20 * 1024 * 1024 })).stdout.trim();
const head = async (root: string): Promise<string | null> => {
  try {
    return await git(root, "rev-parse", "--verify", "HEAD");
  } catch {
    return null;
  }
};
async function safeRoot(root: string): Promise<void> {
  try {
    if ((await fs.realpath(root)) !== path.resolve(root)) throw new Error("root alias");
    const stat = await fs.lstat(path.join(root, "pages"));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid pages");
  } catch {
    throw new WikiError("WIKI_NOT_INITIALIZED", 503);
  }
}
function namespaceSlug(namespace: string, slug: string): string {
  if (!namespace) throw new WikiError("WIKI_CLI_DISABLED", 503);
  strictWikiSlug(namespace);
  strictWikiSlug(slug);
  if (slug !== namespace && !slug.startsWith(`${namespace}/`))
    throw new WikiError("NAMESPACE_VIOLATION", 400);
  return slug;
}
async function operationFiles(root: string): Promise<string[]> {
  const directory = path.join(wikiStateRoot(root), "operations");
  await privateDirectory(directory);
  return (await fs.readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));
}
export async function assertWikiOperationsComplete(root: string): Promise<void> {
  for (const file of await operationFiles(await fs.realpath(root))) {
    const op = await readOperation(file);
    if (op && op.phase !== "complete") throw new WikiError("RECOVERY_REQUIRED", 503);
  }
}
async function readWikiPage(root: string, slug: string) {
  try {
    return await readPage(root, slug, { exactNames: true });
  } catch {
    throw new WikiError("INVALID_PAGE", 400);
  }
}
function partialOperation(op: WikiOperation, error: unknown): WikiWriteResponse {
  const code = error instanceof WikiError ? error.code : "PARTIAL_COMPLETION";
  return {
    status: 207,
    result: {
      ok: false,
      error: {
        code,
        message:
          error instanceof WikiError && !error.retryable
            ? "状態の確認が必要です。operation記録とGitを照合してください"
            : "同じrequest IDと入力で再試行してください",
        retryable: error instanceof WikiError ? error.retryable : true,
      },
      operationId: op.id,
      slug: op.slug,
      version: op.newVersion,
      phase: op.phase,
      fileState: op.phase === "prepared" ? "unknown" : "saved",
      indexState: op.phase === "complete" ? "ready" : "pending",
      extractionState: "not_requested",
      knowledgeState: "not_requested",
    },
  };
}
export class WikiPageService {
  constructor(private readonly dependencies: Dependencies) {}
  private slug(slug: string) {
    return namespaceSlug(this.dependencies.namespace, slug);
  }
  async get(slug: string) {
    this.slug(slug);
    await safeRoot(this.dependencies.root);
    try {
      const page = await readWikiPage(this.dependencies.root, slug);
      if (!page) throw new WikiError("PAGE_NOT_FOUND", 404);
      return { ok: true, command: "get", page };
    } catch (error) {
      if (error instanceof WikiError) throw error;
      throw new WikiError("INVALID_PAGE", 400);
    }
  }
  async list() {
    const { root, namespace } = this.dependencies;
    this.slug(namespace);
    await safeRoot(root);
    const slugs = new Set<string>();
    const scan = async (directory: string): Promise<void> => {
      try {
        await assertNoSymlinkComponents(root, directory, true);
      } catch {
        throw new WikiError("INVALID_PAGE", 400);
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new WikiError("INVALID_PAGE", 400);
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const relative = path.relative(path.join(root, "pages"), file).split(path.sep).join("/");
          const slug = (
            relative.endsWith("/index.md") ? relative.slice(0, -9) : relative.slice(0, -3)
          ).normalize("NFC");
          this.slug(slug);
          slugs.add(slug);
          if (slugs.size > 1000) throw new WikiError("LIST_TOO_LARGE", 413);
        }
      }
    };
    // The namespace may itself be a page or a directory; read checks every ancestor.
    const page = await readWikiPage(root, namespace);
    if (page) slugs.add(namespace);
    await scan(path.join(root, "pages", namespace));
    const items = [];
    for (const slug of [...slugs].sort()) {
      const item = await readWikiPage(root, slug);
      if (item) items.push({ slug: item.slug, title: item.title, version: item.version });
    }
    return { ok: true, command: "list", items };
  }
  async write(input: WikiWrite): Promise<WikiWriteResponse> {
    this.slug(input.slug);
    validateRequestId(input.requestId);
    validateWikiBody(input.body);
    if (input.title !== undefined && (!input.title.trim() || Buffer.byteLength(input.title) > 4096))
      throw new WikiError("INVALID_TITLE", 400);
    if (input.command === "create" && !input.title) throw new WikiError("INVALID_TITLE", 400);
    if (input.command === "update" && !input.ifVersion)
      throw new WikiError("VERSION_REQUIRED", 428);
    if (input.ifVersion && !/^sha256:[a-f0-9]{64}$/.test(input.ifVersion))
      throw new WikiError("INVALID_VERSION", 400);
    if (input.extract) throw new WikiError("EXTRACTION_UNSUPPORTED", 422);
    const { root, preflight, index } = this.dependencies;
    await safeRoot(root);
    return withWikiWriteLock(root, async (): Promise<WikiWriteResponse> => {
      const directory = path.join(wikiStateRoot(root), "operations");
      const files = await operationFiles(root);
      const file = path.join(directory, `${input.requestId.toLowerCase()}.json`);
      const inputHash = hash(
        JSON.stringify({
          command: input.command,
          slug: input.slug,
          body: input.body,
          title: input.title ?? null,
          ifVersion: input.ifVersion ?? null,
          extract: input.extract,
        }),
      );
      let op = await readOperation(file);
      if (op && op.inputHash !== inputHash) throw new WikiError("REQUEST_ID_CONFLICT", 409);
      if (op?.phase === "complete" && op.result) return { status: 200, result: op.result };
      for (const otherFile of files) {
        const other = await readOperation(otherFile);
        if (
          other &&
          other.id !== input.requestId.toLowerCase() &&
          other.slug === input.slug &&
          other.phase !== "complete"
        )
          throw new WikiError("OPERATION_PENDING", 409);
      }
      try {
        await preflight();
      } catch (error) {
        const safe =
          error instanceof WikiError ? error : new WikiError("WRITER_UNAVAILABLE", 503, true);
        if (op) return partialOperation(op, safe);
        throw safe;
      }
      const current = op ? null : await readWikiPage(root, input.slug);
      if (!op) {
        if (files.length >= 10000) throw new WikiError("OPERATION_LIMIT", 503);
        if (input.command === "create" && current) throw new WikiError("PAGE_EXISTS", 409);
        if (input.command === "update" && !current) throw new WikiError("PAGE_NOT_FOUND", 404);
        if (input.command === "update" && current?.version !== input.ifVersion) {
          return {
            status: 412,
            result: {
              ok: false,
              error: {
                code: "VERSION_CONFLICT",
                message: "ページが更新されています",
                retryable: false,
              },
              slug: input.slug,
              currentVersion: current?.version,
              operationId: input.requestId,
            },
          };
        }
        const gitDirectory = await git(root, "rev-parse", "--show-toplevel").catch(() => {
          throw new WikiError("GIT_NOT_INITIALIZED", 503);
        });
        if ((await fs.realpath(gitDirectory)) !== root)
          throw new WikiError("GIT_NOT_INITIALIZED", 503);
        await git(root, "var", "GIT_AUTHOR_IDENT").catch(() => {
          throw new WikiError("GIT_IDENTITY_REQUIRED", 503);
        });
        await git(root, "var", "GIT_COMMITTER_IDENT").catch(() => {
          throw new WikiError("GIT_IDENTITY_REQUIRED", 503);
        });
        const pagePath = current?.path ?? `${input.slug}.md`;
        if (await git(root, "diff", "--cached", "--name-only"))
          throw new WikiError("GIT_STAGED_CHANGES", 409);
        if (
          await git(
            root,
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            `pages/${pagePath}`,
          )
        )
          throw new WikiError("PAGE_DIRTY", 409);
        let ignored = true;
        try {
          await git(root, "check-ignore", "-q", "--", `pages/${pagePath}`);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === 1))
            throw new WikiError("GIT_UNAVAILABLE", 503);
          ignored = false;
        }
        if (ignored) throw new WikiError("PAGE_IGNORED", 409);
        const title = redactSecrets(input.title ?? current?.title ?? "");
        const body = redactSecrets(input.body);
        const meta = redactSecretRecord(current?.meta ?? {});
        const output = serializeWikiPage(title, body, meta);
        op = {
          id: input.requestId.toLowerCase(),
          inputHash,
          slug: input.slug,
          command: input.command,
          oldVersion: current?.version ?? null,
          newVersion: `sha256:${hash(output)}`,
          pagePath,
          phase: "prepared",
          head: await head(root),
        };
        await atomicJson(file, op);
      }
      try {
        let saved = await readWikiPage(root, op.slug);
        if (op.phase === "prepared") {
          if (saved?.version !== op.newVersion) {
            if ((saved?.version ?? null) !== op.oldVersion || (await head(root)) !== op.head)
              throw new WikiError("RECOVERY_REQUIRED", 503);
            const title = redactSecrets(input.title ?? saved?.title ?? "");
            const body = redactSecrets(input.body);
            const meta = redactSecretRecord(saved?.meta ?? {});
            const output = serializeWikiPage(title, body, meta);
            if (`sha256:${hash(output)}` !== op.newVersion)
              throw new WikiError("RECOVERY_REQUIRED", 503);
            await writePage(root, op.slug, title, body, meta, {
              relativePath: op.pagePath,
              atomic: true,
            });
            saved = await readWikiPage(root, op.slug);
          }
          op.phase = "saved";
          await atomicJson(file, op);
        }
        if (!saved || saved.version !== op.newVersion)
          throw new WikiError("RECOVERY_REQUIRED", 503);
        const relative = `pages/${op.pagePath}`;
        if (op.phase === "saved") {
          const currentHead = await head(root);
          const marker = `wiki operation:${op.id}`;
          if (currentHead !== op.head) {
            const targetLog = await git(root, "log", "-1", "--format=%H%n%B", "--", relative);
            const [targetCommit, ...messageLines] = targetLog.split("\n");
            const message = messageLines.join("\n").trim();
            const recoveryCommit =
              message === marker ? targetCommit : op.oldVersion === op.newVersion ? op.head : null;
            if (!recoveryCommit) throw new WikiError("RECOVERY_REQUIRED", 503);
            const raw = (
              await execute("git", ["-C", root, "show", `${recoveryCommit}:${relative}`], {
                maxBuffer: 20 * 1024 * 1024,
              })
            ).stdout;
            if (`sha256:${hash(raw)}` !== op.newVersion)
              throw new WikiError("RECOVERY_REQUIRED", 503);
            op.commit = recoveryCommit;
          } else {
            const staged = (await git(root, "diff", "--cached", "--name-only", "-z"))
              .split("\0")
              .filter(Boolean);
            if (staged.some((name) => name !== relative))
              throw new WikiError("RECOVERY_REQUIRED", 503);
            if (op.stagedVersion || staged.includes(relative)) {
              const stagedBytes = (
                await execute("git", ["-C", root, "show", `:${relative}`], {
                  maxBuffer: 20 * 1024 * 1024,
                })
              ).stdout;
              if (`sha256:${hash(stagedBytes)}` !== op.newVersion)
                throw new WikiError("RECOVERY_REQUIRED", 503);
            }
            await git(root, "add", "--", relative);
            op.stagedVersion = op.newVersion;
            await atomicJson(file, op);
            if (await git(root, "diff", "--cached", "--name-only", "--", relative)) {
              await git(root, "commit", "--only", "-m", marker, "--", relative);
            }
            const committed = await head(root);
            if (!committed) throw new WikiError("RECOVERY_REQUIRED", 503);
            op.commit = committed;
          }
          op.phase = "committed";
          await atomicJson(file, op);
        }
        const committedBytes = (
          await execute("git", ["-C", root, "show", `${op.commit}:${relative}`], {
            maxBuffer: 20 * 1024 * 1024,
          })
        ).stdout;
        if (`sha256:${hash(committedBytes)}` !== op.newVersion)
          throw new WikiError("RECOVERY_REQUIRED", 503);
        const indexHead = await head(root);
        const currentHeadBytes = (
          await execute("git", ["-C", root, "show", `${indexHead}:${relative}`], {
            maxBuffer: 20 * 1024 * 1024,
          })
        ).stdout;
        if (
          `sha256:${hash(currentHeadBytes)}` !== op.newVersion ||
          (await git(root, "diff", "--cached", "--name-only"))
        )
          throw new WikiError("RECOVERY_REQUIRED", 503);
        op.sourceId = await index(saved);
        if (
          (await readWikiPage(root, op.slug))?.version !== op.newVersion ||
          (await head(root)) !== indexHead
        )
          throw new WikiError("RECOVERY_REQUIRED", 503);
        if (!op.sourceId) throw new Error("index result missing");
        const result = {
          ok: true,
          command: op.command,
          page: { slug: op.slug, version: op.newVersion },
          operationId: op.id,
          commit: op.commit,
          sourceId: op.sourceId,
          fileState: "saved",
          indexState: "ready",
          extractionState: "not_requested",
          knowledgeState: "not_requested",
        };
        op.phase = "complete";
        op.result = result;
        await atomicJson(file, op);
        return { status: 200, result };
      } catch (error) {
        return partialOperation(op, error);
      }
    });
  }
}
