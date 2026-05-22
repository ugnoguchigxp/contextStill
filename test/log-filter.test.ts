import { describe, expect, it } from "vitest";
import { filterSensitiveData } from "../src/modules/agent-log-sync/log-filter.js";

describe("log-filter > filterSensitiveData", () => {
  it("should replace API keys and tokens with removal placeholder", () => {
    const raw = "My token is ghp_1234567890abcdefghijklmnopqrstuvwxyz and bearer xyz123.";
    const filtered = filterSensitiveData(raw);
    expect(filtered).toContain("[REMOVED SENSITIVE DATA]");
    expect(filtered).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(filtered).not.toContain("bearer xyz123");
  });

  it("should remove lines containing forbidden keywords", () => {
    const raw = "line1: ordinary content\nline2: my password is admin123\nline3: ordinary suffix";
    const filtered = filterSensitiveData(raw);
    const lines = filtered.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("line1: ordinary content");
    expect(lines[1]).toBe("line3: ordinary suffix");
    expect(filtered).not.toContain("password");
  });

  it("should mask private keys", () => {
    const raw =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const filtered = filterSensitiveData(raw);
    expect(filtered).toContain("[REMOVED SENSITIVE DATA]");
    expect(filtered).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
  });
});
