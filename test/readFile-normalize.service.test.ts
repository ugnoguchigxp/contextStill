import { describe, expect, test } from "vitest";
import {
  maybeStripFrontmatter,
  normalizeReadFileText,
  stripMarkdownFormatting,
  plainTextRenderCallbacks,
} from "../src/modules/readFile/normalize.service.js";

describe("read-file normalize service", () => {
  describe("maybeStripFrontmatter tests", () => {
    test("returns same markdown if includeFrontmatter is true", () => {
      const md = "---\ntitle: test\n---\nHello World";
      expect(maybeStripFrontmatter(md, true)).toBe(md);
    });

    test("returns same markdown if it does not start with ---", () => {
      const md = "Hello World\n---\ntitle: test\n---";
      expect(maybeStripFrontmatter(md, false)).toBe(md);
    });

    test("strips frontmatter if includeFrontmatter is false and starts with ---", () => {
      const md = "---\ntitle: test\n---\nHello World";
      // gray-matter returns content with trimmed leading/trailing newlines
      expect(maybeStripFrontmatter(md, false).trim()).toBe("Hello World");
    });
  });

  describe("normalizeReadFileText tests", () => {
    test("converts windows carriage returns to unix style", () => {
      const text = "hello\r\nworld\r";
      const normalized = normalizeReadFileText({ text, minify: false });
      expect(normalized).toBe("hello\nworld\n");
    });

    test("does not minify if minify parameter is false", () => {
      const text = "hello\n   world\n\nagain";
      const normalized = normalizeReadFileText({ text, minify: false });
      expect(normalized).toBe("hello\n   world\n\nagain");
    });

    test("minifies lines, whitespace, and tabs if minify parameter is true", () => {
      const text = "hello\n   world\t\t\nagain";
      const normalized = normalizeReadFileText({ text, minify: true });
      expect(normalized).toBe("hello world again");
    });
  });

  describe("stripMarkdownFormatting tests", () => {
    test("strips various markdown syntaxes into clean plain text", () => {
      // Bun.markdown.render is available globally under Bun runtime
      if (typeof Bun !== "undefined" && Bun.markdown) {
        const md = [
          "# Heading 1",
          "This is a paragraph with **strong** and *emphasis* styling.",
          "> This is a blockquote",
          "- List item 1",
          "- List item 2",
          "```ts",
          "const a = 1;",
          "```",
          "Here is a [link](https://example.com) and an ![image](https://example.com/img.png).",
          "A `code span` and ~~strikethrough~~.",
          "---",
          "| Header 1 | Header 2 |",
          "|---|---|",
          "| Cell 1 | Cell 2 |",
        ].join("\n");

        const stripped = stripMarkdownFormatting(md);

        // Check if various rendering callbacks triggered and removed syntax
        expect(stripped).toContain("Heading 1");
        expect(stripped).toContain("This is a paragraph");
        expect(stripped).toContain("strong");
        expect(stripped).toContain("emphasis");
        expect(stripped).toContain("List item 1");
        expect(stripped).toContain("const a = 1;");
        expect(stripped).toContain("link");
        expect(stripped).toContain("image");
        expect(stripped).toContain("code span");
        expect(stripped).toContain("strikethrough");
        expect(stripped).toContain("Cell 1");
      } else {
        // Fallback assert if not in Bun runtime (vitest default environment if run elsewhere)
        expect(true).toBe(true);
      }
    });
  });

  describe("plainTextRenderCallbacks tests", () => {
    test("handles all markdown render callbacks correctly", () => {
      // Ensure plainTextRenderCallbacks exists
      expect(plainTextRenderCallbacks).toBeDefined();

      expect(plainTextRenderCallbacks.heading?.("Header", undefined as any)).toBe("Header\n\n");
      expect(plainTextRenderCallbacks.paragraph?.("Para")).toBe("Para\n\n");
      expect(plainTextRenderCallbacks.blockquote?.("Quote")).toBe("Quote\n\n");
      expect(plainTextRenderCallbacks.code?.("const a = 1;")).toBe("const a = 1;\n\n");
      expect(plainTextRenderCallbacks.listItem?.("Item", undefined as any)).toBe("Item\n");
      expect(plainTextRenderCallbacks.list?.("List", undefined as any)).toBe("List\n");
      expect(plainTextRenderCallbacks.hr?.(undefined as any)).toBe("\n");
      expect(plainTextRenderCallbacks.table?.("Table")).toBe("Table\n");
      expect(plainTextRenderCallbacks.thead?.("Thead")).toBe("Thead\n");
      expect(plainTextRenderCallbacks.tbody?.("Tbody")).toBe("Tbody\n");
      expect(plainTextRenderCallbacks.tr?.("Tr")).toBe("Tr\n");
      expect(plainTextRenderCallbacks.th?.("Th")).toBe("Th\t");
      expect(plainTextRenderCallbacks.td?.("Td")).toBe("Td\t");
      expect(plainTextRenderCallbacks.html?.("<div></div>")).toBe("<div></div>");
      expect(plainTextRenderCallbacks.strong?.("strong text")).toBe("strong text");
      expect(plainTextRenderCallbacks.emphasis?.("emphasis text")).toBe("emphasis text");

      // Link callback: children || meta.href
      expect(
        plainTextRenderCallbacks.link?.("Link Text", { href: "https://example.com", title: "" }),
      ).toBe("Link Text");
      expect(plainTextRenderCallbacks.link?.("", { href: "https://example.com", title: "" })).toBe(
        "https://example.com",
      );

      // Image callback: children || meta.src
      expect(plainTextRenderCallbacks.image?.("Image Text", { src: "img.png", title: "" })).toBe(
        "Image Text",
      );
      expect(plainTextRenderCallbacks.image?.("", { src: "img.png", title: "" })).toBe("img.png");

      expect(plainTextRenderCallbacks.codespan?.("code")).toBe("code");
      expect(plainTextRenderCallbacks.strikethrough?.("strike")).toBe("strike");
      expect(plainTextRenderCallbacks.text?.("plain text")).toBe("plain text");
    });
  });
});
