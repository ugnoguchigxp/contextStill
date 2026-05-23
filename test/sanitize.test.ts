import { describe, expect, test } from "vitest";
import { sanitizeMarkdownBody, sanitizePlainText } from "../src/modules/sources/wiki/sanitize.js";

describe("Sanitize Utility", () => {
  describe("sanitizeMarkdownBody", () => {
    test("allows standard Markdown tags and blocks noisy ones", () => {
      const html =
        "<div>Hello <script>alert(1)</script> <details><summary>Click</summary>Hidden</details></div>";
      const sanitized = sanitizeMarkdownBody(html);
      expect(sanitized).toContain(
        "<div>Hello  <details><summary>Click</summary>Hidden</details></div>",
      );
      expect(sanitized).not.toContain("script");
    });

    test("transforms a target='_blank' to include noopener", () => {
      const html = '<a href="https://example.com" target="_blank">Link</a>';
      const sanitized = sanitizeMarkdownBody(html);
      expect(sanitized).toContain('rel="noopener noreferrer"');
    });

    test("blocks unsafe markdown URLs", () => {
      const md =
        "[Safe](https://example.com) [Unsafe](javascript:alert(1)) [Traversal](../etc/passwd)";
      const sanitized = sanitizeMarkdownBody(md);
      expect(sanitized).toContain("https://example.com");
      expect(sanitized).toContain("#blocked-unsafe-url");
    });

    test("handles image URLs separately", () => {
      const md = "![Image](https://example.com/img.png) ![Evil](javascript:evil())";
      const sanitized = sanitizeMarkdownBody(md);
      expect(sanitized).toContain("https://example.com/img.png");
      expect(sanitized).toContain("#blocked-unsafe-url");
    });

    test("allows empty or anchor-only URLs", () => {
      const md = "[Anchor](#target-section) [Empty]()";
      const sanitized = sanitizeMarkdownBody(md);
      expect(sanitized).toContain("#target-section");
      expect(sanitized).not.toContain("#blocked-unsafe-url");
    });

    test("blocks protocol-relative URLs starting with //", () => {
      const md = "[Protocol Relative](//example.com)";
      const sanitized = sanitizeMarkdownBody(md);
      expect(sanitized).toContain("#blocked-unsafe-url");
    });

    test("handles reference-style markdown links and sanitizes unsafe ones", () => {
      const md = [
        "[safe]: https://example.com",
        "[unsafe]: javascript:alert(1)",
        "[traversal]: ../etc/passwd",
      ].join("\n");
      const sanitized = sanitizeMarkdownBody(md);
      expect(sanitized).toContain("[safe]: https://example.com");
      expect(sanitized).toContain("[unsafe]: #blocked-unsafe-url");
      expect(sanitized).toContain("[traversal]: #blocked-unsafe-url");
    });
  });

  describe("sanitizePlainText", () => {
    test("strips all HTML and control characters", () => {
      const text = "Hello <b>World</b>\x00\x1F";
      const sanitized = sanitizePlainText(text);
      expect(sanitized).toBe("Hello World");
    });
  });
});
