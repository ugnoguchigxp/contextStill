import path from "node:path";

export const extractRemainderFromPathname = (pathname: string, prefix: string): string => {
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  const raw = pathname.slice(prefix.length).trim();
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "\0";
  }
  return decoded.replace(/^\/+|\/+$/g, "");
};

const normalizeRelative = (value: string): string => value.split(path.sep).join("/");

export const filePathToSlug = (relativePath: string): string => {
  const normalized = normalizeRelative(relativePath);
  if (normalized === "index.md") {
    return "";
  }
  if (normalized.endsWith("/index.md")) {
    return normalized.slice(0, -"/index.md".length);
  }
  return normalized.replace(/\.md$/i, "");
};

export const sanitizeSlug = (slug: string): string =>
  slug
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");

export const isSafeSlug = (slug: string): boolean => {
  const normalized = sanitizeSlug(slug);
  if (normalized.includes("\0")) {
    return false;
  }
  return normalized.split("/").every((segment) => {
    if (segment === "") {
      return normalized === "";
    }
    return segment !== "." && segment !== "..";
  });
};

export const assertSafeSlug = (slug: string): string => {
  const normalized = sanitizeSlug(slug);
  if (!isSafeSlug(normalized)) {
    throw new Error("Invalid page slug");
  }
  return normalized;
};
