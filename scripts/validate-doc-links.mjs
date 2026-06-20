import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const roots = ["README.md", "README.jp.md", "spec/pub", "spec/docs"];
const ignoredSchemes = /^(https?:|mailto:|tel:|#)/i;
const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

async function listMarkdownFiles(inputPath) {
  const absolutePath = path.resolve(root, inputPath);
  if (!existsSync(absolutePath)) return [];
  const stat = statSync(absolutePath);
  if (stat.isFile()) return inputPath.endsWith(".md") ? [absolutePath] : [];

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const child = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(path.relative(root, child));
      return entry.isFile() && entry.name.endsWith(".md") ? [child] : [];
    }),
  );
  return files.flat();
}

function stripAnchor(link) {
  const index = link.indexOf("#");
  return index >= 0 ? link.slice(0, index) : link;
}

function resolveLinkTarget(file, rawLink) {
  const withoutQuery = stripAnchor(rawLink.split("?")[0] ?? rawLink);
  if (!withoutQuery || ignoredSchemes.test(withoutQuery)) return null;
  const decoded = decodeURIComponent(withoutQuery);
  return path.resolve(path.dirname(file), decoded);
}

const files = (await Promise.all(roots.map(listMarkdownFiles))).flat();
const failures = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(markdownLinkPattern)) {
    const rawLink = match[1];
    const target = rawLink ? resolveLinkTarget(file, rawLink) : null;
    if (!target) continue;
    if (existsSync(target)) continue;
    failures.push(`${path.relative(root, file)} -> ${rawLink}`);
  }
}

if (failures.length > 0) {
  console.error("[docs:check-links] missing local markdown link targets:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`[docs:check-links] ok (${files.length} markdown files)`);
