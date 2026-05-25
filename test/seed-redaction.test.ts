import { describe, expect, test, vi } from "vitest";
import { sanitizeSeedPayloadForPersistence, type SeedPayload } from "../src/db/seed.js";

vi.mock("../src/db/index.js", () => ({
  closeDbPool: vi.fn(),
  db: {},
}));

describe("db seed redaction", () => {
  test("sanitizes secrets before seed rows are persisted", () => {
    const payload: SeedPayload = {
      schemaVersion: 1,
      generatedAt: "2026-05-25T00:00:00.000Z",
      knowledgeItems: [
        {
          id: "k1",
          body: "normal\napi_key=sk-abcdefghijklmnopqrstuvwxyz0123456789",
          metadata: { credentials: { value: "raw-token-value" } },
        },
      ],
      sources: [
        {
          id: "s1",
          body: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
          metadata: { url: "https://example.com/docs?token=abcdef0123456789" },
        },
      ],
      sourceFragments: [
        {
          id: "f1",
          content: "password=super-secret-value",
          metadata: { privateKey: "raw-private-key" },
        },
      ],
      knowledgeSourceLinks: [],
      knowledgeTagDefinitions: [],
      knowledgeCommunityLabels: [],
    };

    const sanitized = sanitizeSeedPayloadForPersistence(payload);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("raw-token-value");
    expect(serialized).not.toContain("abcdef0123456789");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("raw-private-key");
  });
});
