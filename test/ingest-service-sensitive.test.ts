import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/shared/utils/secret-redaction.js";

describe("ingest service sensitive data filter", () => {
  it("removes API keys and secrets", () => {
    const input = [
      "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "normal line",
    ].join("\n");
    const redacted = redactSecrets(input);
    expect(redacted).toContain("[REMOVED SENSITIVE DATA]");
    expect(redacted).toContain("normal line");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("removes private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAz",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(input);
    expect(redacted).toBe("[REMOVED SENSITIVE DATA]");
  });
});
