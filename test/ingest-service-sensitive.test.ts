import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsFromValue } from "../src/shared/utils/secret-redaction.js";

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

  it("redacts nested metadata values and sensitive keys", () => {
    const redacted = redactSecretsFromValue({
      sourceUri: "https://example.com/docs?token=abcdef0123456789",
      authToken: "plain-token-value",
      credentials: {
        value: "raw-token-value",
      },
      tokenUsage: 123,
      secretaryName: "not sensitive",
      nested: {
        command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'",
      },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
    expect(serialized).not.toContain("plain-token-value");
    expect(serialized).not.toContain("raw-token-value");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("abcdef0123456789");
    expect(redacted).toMatchObject({
      tokenUsage: 123,
      secretaryName: "not sensitive",
    });
  });
});
