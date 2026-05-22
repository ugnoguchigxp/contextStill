import { describe, expect, it } from "vitest";
import {
  compactWhitespace,
  decodeHtmlEntities,
  stripMarkup,
  validateFetchContentUrl,
} from "../src/modules/distillation/url-fetcher.js";

describe("url-fetcher validateFetchContentUrl", () => {
  it("allows safe public HTTP and HTTPS URLs", () => {
    expect(validateFetchContentUrl("https://example.com")).toEqual({ safe: true });
    expect(validateFetchContentUrl("http://google.com/search?q=test")).toEqual({ safe: true });
  });

  it("blocks invalid URLs", () => {
    expect(validateFetchContentUrl("not-a-url")).toEqual({ safe: false, reason: "invalid URL" });
    expect(validateFetchContentUrl("ftp://example.com")).toEqual({
      safe: false,
      reason: "protocol must be http or https",
    });
  });

  it("blocks empty or localhost hostnames", () => {
    expect(validateFetchContentUrl("https://localhost")).toEqual({
      safe: false,
      reason: "localhost is not allowed",
    });
    expect(validateFetchContentUrl("https://test.localhost")).toEqual({
      safe: false,
      reason: "localhost is not allowed",
    });
  });

  it("blocks cloud metadata endpoint", () => {
    expect(validateFetchContentUrl("http://169.254.169.254")).toEqual({
      safe: false,
      reason: "cloud metadata endpoint is blocked",
    });
  });

  it("blocks private IPv4 addresses", () => {
    expect(validateFetchContentUrl("http://127.0.0.1")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
    expect(validateFetchContentUrl("http://192.168.0.1")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
    expect(validateFetchContentUrl("http://10.255.255.254")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
    expect(validateFetchContentUrl("http://172.16.0.1")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
  });

  it("blocks loopback and link-local IPv6 addresses", () => {
    expect(validateFetchContentUrl("http://[::1]")).toEqual({
      safe: false,
      reason: "private, loopback, or link-local IPv6 is blocked",
    });
    expect(validateFetchContentUrl("http://[fe80::1]")).toEqual({
      safe: false,
      reason: "private, loopback, or link-local IPv6 is blocked",
    });
    expect(validateFetchContentUrl("http://[fc00::]")).toEqual({
      safe: false,
      reason: "private, loopback, or link-local IPv6 is blocked",
    });
  });
});

describe("url-fetcher text processing utilities", () => {
  it("compacts redundant whitespace", () => {
    expect(compactWhitespace("  hello   world  \n new line  ")).toBe("hello world new line");
  });

  it("decodes HTML entities correctly", () => {
    expect(decodeHtmlEntities("hello &amp; world &lt;test&gt;")).toBe("hello & world <test>");
    expect(decodeHtmlEntities("&#39;test&#39;")).toBe("'test'");
    expect(decodeHtmlEntities("&#x22;hex&#x22;")).toBe('"hex"');
  });

  it("strips HTML markup and noisy elements", () => {
    const rawHtml = `
      <header>Navigation Header</header>
      <main>
        <h1>Main Title</h1>
        <script>console.log("noisy script");</script>
        <style>body { color: red; }</style>
        <p>This is <strong>important</strong> content.</p>
      </main>
      <footer>Footer Info</footer>
    `;
    const stripped = stripMarkup(rawHtml);
    expect(stripped).toContain("Main Title");
    expect(stripped).toContain("This is important content.");
    expect(stripped).not.toContain("Navigation Header");
    expect(stripped).not.toContain("noisy script");
    expect(stripped).not.toContain("Footer Info");
  });
});
