import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { extractWebSourceUrlsFromUpload } from "../src/modules/sources/web/source-upload-parser.service.js";

describe("extractWebSourceUrlsFromUpload", () => {
  it("extracts and deduplicates urls from csv", async () => {
    const csv = [
      "url",
      "https://example.com/a",
      "memo,https://example.com/b",
      "https://example.com/a",
      "invalid",
    ].join("\n");
    const urls = await extractWebSourceUrlsFromUpload({
      filename: "urls.csv",
      bytes: Buffer.from(csv, "utf8"),
    });
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("extracts urls from xlsx cells", async () => {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["title", "url"],
      ["alpha", "https://example.com/a"],
      ["beta", "see https://example.com/b for details"],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "urls");
    const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const urls = await extractWebSourceUrlsFromUpload({
      filename: "urls.xlsx",
      bytes,
    });
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("throws on unsupported extension", async () => {
    await expect(
      extractWebSourceUrlsFromUpload({
        filename: "urls.txt",
        bytes: Buffer.from("https://example.com/a", "utf8"),
      }),
    ).rejects.toThrow("unsupported file type");
  });
});
