import path from "node:path";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_URLS = 5_000;
const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
const supportedExtensions = new Set(["csv", "tsv", "xlsx", "xls"]);

function normalizeUrlCandidate(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^[\s"'`([{<]+/, "")
    .replace(/[\s"'`)\]}>.,;:!?]+$/, "");
  if (!cleaned) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

function pushUrl(raw: string, sink: string[], seen: Set<string>, maxUrls: number): void {
  if (sink.length >= maxUrls) return;
  const normalized = normalizeUrlCandidate(raw);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  sink.push(normalized);
}

function collectUrlsFromText(
  text: string,
  sink: string[],
  seen: Set<string>,
  maxUrls: number,
): void {
  if (!text) return;
  for (const match of text.match(urlPattern) ?? []) {
    pushUrl(match, sink, seen, maxUrls);
    if (sink.length >= maxUrls) return;
  }
}

async function extractUrlsFromSpreadsheet(
  buffer: Buffer,
  sink: string[],
  seen: Set<string>,
  maxUrls: number,
): Promise<void> {
  const xlsx = await import("xlsx");
  const workbook = xlsx.read(buffer, { type: "buffer", dense: true });
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    for (const row of rows) {
      for (const cell of row) {
        if (cell === null || cell === undefined) continue;
        collectUrlsFromText(String(cell), sink, seen, maxUrls);
        if (sink.length >= maxUrls) return;
      }
    }
  }
}

function extensionFromFilename(filename: string): string {
  return path.extname(filename).replace(/^\./, "").toLowerCase();
}

export async function extractWebSourceUrlsFromUpload(params: {
  filename: string;
  bytes: Buffer;
  maxUrls?: number;
}): Promise<string[]> {
  if (!params.filename.trim()) {
    throw new Error("filename is required");
  }
  if (params.bytes.length === 0) {
    throw new Error("uploaded file is empty");
  }
  if (params.bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(`uploaded file is too large (max ${MAX_UPLOAD_BYTES} bytes)`);
  }

  const extension = extensionFromFilename(params.filename);
  if (!supportedExtensions.has(extension)) {
    throw new Error("unsupported file type (csv, tsv, xlsx, xls)");
  }

  const maxUrls = Math.max(1, Math.floor(params.maxUrls ?? DEFAULT_MAX_URLS));
  const urls: string[] = [];
  const seen = new Set<string>();

  if (extension === "csv" || extension === "tsv") {
    collectUrlsFromText(params.bytes.toString("utf8"), urls, seen, maxUrls);
  } else {
    await extractUrlsFromSpreadsheet(params.bytes, urls, seen, maxUrls);
  }

  return urls;
}
