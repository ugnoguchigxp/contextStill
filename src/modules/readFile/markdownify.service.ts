import path from "node:path";
import { NodeHtmlMarkdown } from "node-html-markdown";

const htmlExtensions = new Set([".html", ".htm"]);
const markdownExtensions = new Set([".md", ".markdown", ".mdx", ".txt"]);

const htmlLikePattern =
  /^\s*<(?:!doctype\s+html|html|head|body|article|section|main|div|p|h[1-6]|ul|ol|li|table|pre|code|blockquote|span|a|img)\b/i;

const htmlToMarkdown = new NodeHtmlMarkdown();

export function markdownifyContent(params: { content: string; filePath: string }): string {
  const extension = path.extname(params.filePath).toLowerCase();
  if (markdownExtensions.has(extension)) {
    return params.content;
  }

  if (htmlExtensions.has(extension) || htmlLikePattern.test(params.content)) {
    return htmlToMarkdown.translate(params.content);
  }

  return params.content;
}
