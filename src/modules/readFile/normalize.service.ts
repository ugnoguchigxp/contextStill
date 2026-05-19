import matter from "gray-matter";

const plainTextRenderCallbacks: Bun.markdown.RenderCallbacks = {
  heading: (children) => `${children}\n\n`,
  paragraph: (children) => `${children}\n\n`,
  blockquote: (children) => `${children}\n\n`,
  code: (children) => `${children}\n\n`,
  listItem: (children) => `${children}\n`,
  list: (children) => `${children}\n`,
  hr: () => "\n",
  table: (children) => `${children}\n`,
  thead: (children) => `${children}\n`,
  tbody: (children) => `${children}\n`,
  tr: (children) => `${children}\n`,
  th: (children) => `${children}\t`,
  td: (children) => `${children}\t`,
  html: (children) => children,
  strong: (children) => children,
  emphasis: (children) => children,
  link: (children, meta) => children || meta.href,
  image: (children, meta) => children || meta.src,
  codespan: (children) => children,
  strikethrough: (children) => children,
  text: (text) => text,
};

export function maybeStripFrontmatter(markdown: string, includeFrontmatter: boolean): string {
  if (includeFrontmatter) return markdown;
  if (!markdown.startsWith("---")) return markdown;
  return matter(markdown).content;
}

export function stripMarkdownFormatting(markdown: string): string {
  return Bun.markdown.render(markdown, plainTextRenderCallbacks);
}

export function normalizeReadFileText(params: { text: string; minify: boolean }): string {
  const unixLines = params.text.replace(/\r\n?/g, "\n");
  if (!params.minify) return unixLines;
  return unixLines
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
