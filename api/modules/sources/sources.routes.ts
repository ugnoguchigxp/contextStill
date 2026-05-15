import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { groupedConfig } from "../../../src/config.js";
import { deleteSourceByUri } from "./sources.repository.js";
import {
  commitDeleteChange,
  commitFileChange,
  commitPathsChange,
  createFolder,
  deleteFolder,
  deletePage,
  ensureContentRoot,
  ensureGitRepo,
  getGitSummary,
  getPageDiff,
  getPageHistory,
  listFolders,
  listPages,
  readPage,
  renameFolder,
  writePage,
} from "../../../src/modules/sources/wiki/content-repo.js";
import {
  extractRemainderFromPathname,
  isSafeSlug,
  sanitizeSlug,
} from "../../../src/modules/sources/wiki/slug.js";
import { upsertSourceDocument } from "../../../src/modules/sources/source.repository.js";

const pageSlugSchema = z
  .string()
  .transform((value) => sanitizeSlug(value))
  .refine((value) => isSafeSlug(value), {
    message: "Invalid page slug",
  });

const writePageSchema = z.object({
  slug: pageSlugSchema,
  title: z.string().min(1),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const updatePageSchema = z.object({
  slug: pageSlugSchema.optional(),
  title: z.string().min(1).optional(),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  commitMessage: z.string().min(1).optional(),
});

const folderPathSchema = pageSlugSchema.refine((value) => value !== "", {
  message: "Invalid folder path",
});

const writeFolderSchema = z.object({
  path: folderPathSchema,
});

const diffQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().optional(),
});

const slugFromRequestPath = (url: string, prefix: string): string => {
  const pathname = new URL(url).pathname;
  return sanitizeSlug(extractRemainderFromPathname(pathname, prefix));
};

const invalidSlugResponse = (slug: string) => ({
  message: "Invalid page slug",
  slug,
});

const isInvalidSlug = (slug: string): boolean => !isSafeSlug(slug);

const invalidFolderResponse = (folderPath: string) => ({
  message: "Invalid folder path",
  path: folderPath,
});

const isInvalidFolderPath = (folderPath: string): boolean =>
  folderPath === "" || !isSafeSlug(folderPath);

const folderErrorStatus = (error: unknown): 400 | 404 | 409 => {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("already exists") || message.includes("conflicts")) return 409;
  if (message.includes("not found") || message.includes("ENOENT")) return 404;
  return 400;
};

async function ensureSourceRuntime(): Promise<void> {
  await ensureContentRoot(groupedConfig.sourceContent.root);
  await ensureGitRepo(groupedConfig.sourceContent.root);
}

const makeExcerpt = (body: string, query: string): string => {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const lowered = compact.toLowerCase();
  const queryLower = query.toLowerCase();
  const index = lowered.indexOf(queryLower);
  if (index === -1) return compact.slice(0, 180);
  const start = Math.max(0, index - 60);
  const end = Math.min(compact.length, index + query.length + 120);
  return compact.slice(start, end);
};

const searchableMetaText = (meta: Record<string, unknown>): string => {
  const tags = meta.tags;
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .join(" ");
  }
  if (typeof tags === "string") {
    return tags;
  }
  return "";
};

export const sourcesRouter = new Hono()
  .get("/health", async (c) => {
    await ensureSourceRuntime();
    const git = await getGitSummary(groupedConfig.sourceContent.root);
    return c.json({
      app: "memory-router",
      version: "0.1.0",
      git,
    });
  })
  .get("/tree", async (c) => {
    await ensureSourceRuntime();
    const [items, folders] = await Promise.all([
      listPages(groupedConfig.sourceContent.root),
      listFolders(groupedConfig.sourceContent.root),
    ]);
    return c.json({ items, folders });
  })
  .get("/search", zValidator("query", searchQuerySchema), async (c) => {
    await ensureSourceRuntime();
    const { q } = c.req.valid("query");
    const query = (q ?? "").trim();
    if (!query) {
      return c.json({ items: [] });
    }

    const tree = await listPages(groupedConfig.sourceContent.root);
    const hits: Array<{ slug: string; excerpt: string }> = [];
    const queryLower = query.toLowerCase();

    for (const item of tree) {
      const page = await readPage(groupedConfig.sourceContent.root, item.slug);
      if (!page) continue;
      const metaText = searchableMetaText(page.meta);
      const searchableText = `${page.slug}\n${page.title}\n${metaText}\n${page.body}`;
      const haystack = searchableText.toLowerCase();
      if (!haystack.includes(queryLower)) continue;
      hits.push({
        slug: page.slug,
        excerpt: makeExcerpt(searchableText, query),
      });
      if (hits.length >= 40) break;
    }

    return c.json({ items: hits });
  })
  .post("/reindex", async (c) => {
    await ensureSourceRuntime();
    const pages = await listPages(groupedConfig.sourceContent.root);
    let indexed = 0;
    for (const item of pages) {
      const page = await readPage(groupedConfig.sourceContent.root, item.slug);
      if (!page) continue;
      await upsertSourceDocument({
        sourceKind: "wiki",
        uri: page.path,
        title: page.title,
        body: page.body,
        metadata: page.meta,
        actor: "user",
      });
      indexed += 1;
    }
    return c.json({
      ok: true,
      indexed,
      removed: 0,
    });
  })
  .get("/folders", async (c) => {
    await ensureSourceRuntime();
    const items = await listFolders(groupedConfig.sourceContent.root);
    return c.json({ items });
  })
  .post("/folders", zValidator("json", writeFolderSchema), async (c) => {
    await ensureSourceRuntime();
    const payload = c.req.valid("json");
    try {
      const created = await createFolder(groupedConfig.sourceContent.root, payload.path);
      const commit = await commitFileChange(
        groupedConfig.sourceContent.root,
        created.keepFilePath,
        `docs(folder): create ${created.path}`,
      );
      return c.json({ ok: true, path: created.path, commit });
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Folder create failed",
          path: payload.path,
        },
        folderErrorStatus(error),
      );
    }
  })
  .put("/folders/*", zValidator("json", writeFolderSchema), async (c) => {
    await ensureSourceRuntime();
    const folderPath = slugFromRequestPath(c.req.url, "/api/sources/folders/");
    if (isInvalidFolderPath(folderPath)) {
      return c.json(invalidFolderResponse(folderPath), 400);
    }
    const payload = c.req.valid("json");
    try {
      const renamed = await renameFolder(
        groupedConfig.sourceContent.root,
        folderPath,
        payload.path,
      );
      const commit = await commitPathsChange(
        groupedConfig.sourceContent.root,
        [renamed.oldAbsolutePath, renamed.newAbsolutePath],
        `docs(folder): rename ${renamed.from} to ${renamed.path}`,
      );
      return c.json({
        ok: true,
        from: renamed.from,
        path: renamed.path,
        movedPages: renamed.movedPages,
        commit,
      });
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Folder rename failed",
          path: folderPath,
        },
        folderErrorStatus(error),
      );
    }
  })
  .delete("/folders/*", async (c) => {
    await ensureSourceRuntime();
    const folderPath = slugFromRequestPath(c.req.url, "/api/sources/folders/");
    if (isInvalidFolderPath(folderPath)) {
      return c.json(invalidFolderResponse(folderPath), 400);
    }
    try {
      const deleted = await deleteFolder(groupedConfig.sourceContent.root, folderPath);
      const commit = await commitPathsChange(
        groupedConfig.sourceContent.root,
        [deleted.absolutePath],
        `docs(folder): delete ${deleted.path}`,
      );
      return c.json({
        ok: true,
        path: deleted.path,
        deletedSlugs: deleted.deletedSlugs,
        commit,
      });
    } catch (error) {
      return c.json(
        {
          message: error instanceof Error ? error.message : "Folder delete failed",
          path: folderPath,
        },
        folderErrorStatus(error),
      );
    }
  })
  .get("/pages/*", async (c) => {
    await ensureSourceRuntime();
    const slug = slugFromRequestPath(c.req.url, "/api/sources/pages/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }
    const page = await readPage(groupedConfig.sourceContent.root, slug);
    if (!page) {
      return c.json({ message: "Page not found", slug }, 404);
    }
    return c.json(page);
  })
  .post("/pages", zValidator("json", writePageSchema), async (c) => {
    await ensureSourceRuntime();
    const payload = c.req.valid("json");
    const existing = await readPage(groupedConfig.sourceContent.root, payload.slug);
    if (existing) {
      return c.json({ message: "Page already exists", slug: payload.slug }, 409);
    }
    const { path, hash } = await writePage(
      groupedConfig.sourceContent.root,
      payload.slug,
      payload.title,
      payload.body,
      payload.meta ?? {},
    );
    const commit = await commitFileChange(
      groupedConfig.sourceContent.root,
      path,
      `docs(page): create ${payload.slug || "home"}`,
    );
    const savedPage = await readPage(groupedConfig.sourceContent.root, payload.slug);
    if (!savedPage) {
      return c.json({ message: "Page save verification failed" }, 500);
    }
    await upsertSourceDocument({
      sourceKind: "wiki",
      uri: savedPage.path,
      title: savedPage.title,
      body: savedPage.body,
      contentHash: hash,
      metadata: savedPage.meta,
      actor: "user",
    });
    return c.json({ ok: true, slug: savedPage.slug, hash, commit });
  })
  .put("/pages/*", zValidator("json", updatePageSchema), async (c) => {
    await ensureSourceRuntime();
    const slug = slugFromRequestPath(c.req.url, "/api/sources/pages/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }
    const existing = await readPage(groupedConfig.sourceContent.root, slug);
    if (!existing) {
      return c.json({ message: "Page not found", slug }, 404);
    }
    const payload = c.req.valid("json");
    const targetSlug = payload.slug ?? slug;
    if (targetSlug !== slug) {
      const targetExisting = await readPage(groupedConfig.sourceContent.root, targetSlug);
      if (targetExisting) {
        return c.json({ message: "Page already exists", slug: targetSlug }, 409);
      }
    }
    const title = payload.title ?? existing.title;
    const meta = payload.meta ?? existing.meta;
    const { path, hash } = await writePage(
      groupedConfig.sourceContent.root,
      targetSlug,
      title,
      payload.body,
      meta,
      targetSlug === slug ? { relativePath: existing.path } : undefined,
    );
    let commit: string | null;
    if (targetSlug === slug) {
      commit = await commitFileChange(
        groupedConfig.sourceContent.root,
        path,
        payload.commitMessage ?? `docs(page): update ${slug || "home"}`,
      );
    } else {
      const deletedPath = await deletePage(groupedConfig.sourceContent.root, slug);
      commit = await commitPathsChange(
        groupedConfig.sourceContent.root,
        [path, deletedPath],
        payload.commitMessage ?? `docs(page): rename ${slug || "home"} to ${targetSlug || "home"}`,
      );
      await deleteSourceByUri(existing.path);
    }
    const savedPage = await readPage(groupedConfig.sourceContent.root, targetSlug);
    if (!savedPage) {
      return c.json({ message: "Page save verification failed", slug: targetSlug }, 500);
    }
    await upsertSourceDocument({
      sourceKind: "wiki",
      uri: savedPage.path,
      title: savedPage.title,
      body: savedPage.body,
      contentHash: hash,
      metadata: savedPage.meta,
      actor: "user",
    });
    return c.json({ ok: true, slug: savedPage.slug, hash, commit });
  })
  .delete("/pages/*", async (c) => {
    await ensureSourceRuntime();
    const slug = slugFromRequestPath(c.req.url, "/api/sources/pages/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }
    const existing = await readPage(groupedConfig.sourceContent.root, slug);
    if (!existing) {
      return c.json({ message: "Page not found", slug }, 404);
    }
    try {
      const deletedPath = await deletePage(groupedConfig.sourceContent.root, slug);
      const commit = await commitDeleteChange(
        groupedConfig.sourceContent.root,
        deletedPath,
        `docs(page): delete ${slug || "home"}`,
      );
      await deleteSourceByUri(existing.path);
      return c.json({ ok: true, slug, commit });
    } catch {
      return c.json({ message: "Page not found", slug }, 404);
    }
  })
  .get("/history/*", async (c) => {
    await ensureSourceRuntime();
    const slug = slugFromRequestPath(c.req.url, "/api/sources/history/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }
    const items = await getPageHistory(groupedConfig.sourceContent.root, slug);
    return c.json({ slug, items });
  })
  .get("/diff/*", zValidator("query", diffQuerySchema), async (c) => {
    await ensureSourceRuntime();
    const slug = slugFromRequestPath(c.req.url, "/api/sources/diff/");
    if (isInvalidSlug(slug)) {
      return c.json(invalidSlugResponse(slug), 400);
    }
    const { from, to } = c.req.valid("query");
    if (!from || !to) {
      return c.json({ message: "from and to query are required" }, 400);
    }
    const diff = await getPageDiff(groupedConfig.sourceContent.root, slug, from, to);
    return c.json({ slug, from, to, diff });
  });
