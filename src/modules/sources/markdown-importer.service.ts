import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { registerEvidenceFromText } from "../evidence/evidence.service.js";
import { registerKnowledgeFromMarkdown } from "../knowledge/knowledge.service.js";

type MarkdownImportResult = {
  importedFiles: number;
  importedFragments: number;
  importedKnowledge: number;
  skippedFiles: number;
  files: Array<{ path: string; sourceId: string; fragmentId: string; knowledgeId: string }>;
};

type FrontmatterParseResult = {
  frontmatter: Record<string, string>;
  body: string;
};

const knowledgeTypeValues = new Set([
  "fact",
  "decision",
  "rule",
  "procedure",
  "skill",
  "risk",
  "lesson",
  "example",
]);

const knowledgeStatusValues = new Set([
  "candidate",
  "draft",
  "trial",
  "active",
  "deprecated",
  "rejected",
]);

const scopeValues = new Set(["user", "repo", "workspace", "org", "global"]);

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatter: {}, body: markdown };
  }
  const block = markdown.slice(4, end);
  const body = markdown.slice(end + 5);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    frontmatter[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter, body };
}

function firstMarkdownHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    const title = trimmed.replace(/^#+\s*/, "").trim();
    if (title) return title;
  }
  return null;
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function inferKnowledgeType(input: { frontmatterType?: string; title: string; body: string }):
  | "fact"
  | "decision"
  | "rule"
  | "procedure"
  | "skill"
  | "risk"
  | "lesson"
  | "example" {
  const explicitType = input.frontmatterType?.toLowerCase();
  if (explicitType && knowledgeTypeValues.has(explicitType)) {
    return explicitType as
      | "fact"
      | "decision"
      | "rule"
      | "procedure"
      | "skill"
      | "risk"
      | "lesson"
      | "example";
  }

  const signal = `${input.title}\n${input.body}`.toLowerCase();
  if (
    signal.includes("runbook") ||
    signal.includes("playbook") ||
    signal.includes("how to") ||
    signal.includes("手順") ||
    signal.includes("手続")
  ) {
    return "procedure";
  }
  if (
    signal.includes("rule") ||
    signal.includes("policy") ||
    signal.includes("must") ||
    signal.includes("禁止") ||
    signal.includes("規約")
  ) {
    return "rule";
  }
  if (signal.includes("example") || signal.includes("事例")) {
    return "example";
  }
  return "fact";
}

export async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const parentPath =
      "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : rootDir;
    files.push(path.join(parentPath, entry.name));
  }
  return files.sort();
}

export async function importMarkdownDirectory(rootDir: string): Promise<MarkdownImportResult> {
  const markdownFiles = await collectMarkdownFiles(rootDir);
  const results: MarkdownImportResult = {
    importedFiles: 0,
    importedFragments: 0,
    importedKnowledge: 0,
    skippedFiles: 0,
    files: [],
  };

  for (const filePath of markdownFiles) {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) {
      results.skippedFiles += 1;
      continue;
    }

    const hash = createHash("sha256").update(content).digest("hex");
    const { frontmatter, body } = parseFrontmatter(content);
    const inferredTitle = firstMarkdownHeading(body) ?? path.basename(filePath, ".md");
    const knowledgeType = inferKnowledgeType({
      frontmatterType: frontmatter.type,
      title: frontmatter.title ?? inferredTitle,
      body,
    });
    const knowledgeStatus = (frontmatter.status?.toLowerCase() ?? "draft").trim();
    const knowledgeScope = (frontmatter.scope?.toLowerCase() ?? "repo").trim();
    const confidence = clamp01(Number(frontmatter.confidence), 0.7);
    const importance = clamp01(Number(frontmatter.importance), 0.7);

    const { sourceId, fragmentId } = await registerEvidenceFromText({
      sourceKind: "markdown",
      uri: filePath,
      title: path.basename(filePath),
      contentHash: hash,
      text: content,
      locator: "full",
      metadata: {
        importedAt: new Date().toISOString(),
      },
    });
    const knowledgeId = await registerKnowledgeFromMarkdown({
      sourceUri: filePath,
      contentHash: hash,
      title: frontmatter.title ?? inferredTitle,
      body: body.trim().slice(0, 5000),
      type: knowledgeType,
      status: knowledgeStatusValues.has(knowledgeStatus)
        ? (knowledgeStatus as
            | "candidate"
            | "draft"
            | "trial"
            | "active"
            | "deprecated"
            | "rejected")
        : "draft",
      scope: scopeValues.has(knowledgeScope)
        ? (knowledgeScope as "user" | "repo" | "workspace" | "org" | "global")
        : "repo",
      confidence,
      importance,
      metadata: {
        importedAt: new Date().toISOString(),
        sourceKind: "markdown",
      },
    });

    results.importedFiles += 1;
    results.importedFragments += 1;
    results.importedKnowledge += 1;
    results.files.push({ path: filePath, sourceId, fragmentId, knowledgeId });
  }

  return results;
}
