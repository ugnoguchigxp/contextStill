import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sanitizeHtml: typeof import("sanitize-html") = require("sanitize-html");

const allowedTags = [
  ...sanitizeHtml.defaults.allowedTags,
  "details",
  "summary",
  "img",
  "kbd",
  "mark",
  "s",
  "sub",
  "sup",
];

const allowedSchemes = ["http", "https", "mailto"];

const sanitizeInlineHtml = (value: string): string =>
  sanitizeHtml(value, {
    allowedTags,
    allowedAttributes: {
      a: ["href", "name", "rel", "target", "title"],
      img: ["alt", "height", "src", "title", "width"],
      "*": ["class", "id"],
    },
    allowedSchemes,
    allowedSchemesByTag: {
      img: ["http", "https"],
    },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName: string, attribs: Record<string, string>) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          ...(attribs.target === "_blank" ? { rel: "noopener noreferrer" } : {}),
        },
      }),
    },
  });

const stripControlCharacters = (value: string): string =>
  [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");

const getUrlScheme = (value: string): string | null => {
  const compact = stripControlCharacters(value).trim().replace(/\s+/g, "");
  const match = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(compact);
  return match?.[1]?.toLowerCase() ?? null;
};

const hasRelativePathTraversal = (value: string): boolean => {
  const pathPart = value.replace(/\\/g, "/").split(/[?#]/, 1)[0] ?? "";
  return pathPart.split("/").some((segment) => segment === "..");
};

const isSafeMarkdownUrl = (value: string, options: { image?: boolean } = {}): boolean => {
  const trimmed = stripControlCharacters(value).trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return true;
  }
  if (trimmed.startsWith("//")) {
    return false;
  }
  const scheme = getUrlScheme(trimmed);
  if (scheme) {
    return options.image ? ["http", "https"].includes(scheme) : allowedSchemes.includes(scheme);
  }
  return !hasRelativePathTraversal(trimmed);
};

const sanitizeMarkdownLinks = (body: string): string =>
  body
    .replace(/(!?\[[^\]]*])\(([^)\s]+)(\s+(?:"[^"]*"|'[^']*'))?\)/g, (match, label, url, title) => {
      if (!isSafeMarkdownUrl(url, { image: label.startsWith("!") })) {
        return `${label}(#blocked-unsafe-url${title ?? ""})`;
      }
      return match;
    })
    .replace(/^(\s*\[[^\]]+]:\s*)(\S+)(.*)$/gm, (match, prefix, url, suffix) => {
      if (!isSafeMarkdownUrl(url)) {
        return `${prefix}#blocked-unsafe-url${suffix}`;
      }
      return match;
    });

export const sanitizeMarkdownBody = (body: string): string =>
  sanitizeMarkdownLinks(sanitizeInlineHtml(body));

export const sanitizePlainText = (value: string): string =>
  sanitizeHtml(stripControlCharacters(value), {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
