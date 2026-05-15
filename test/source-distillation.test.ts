import { describe, expect, test } from "bun:test";
import type { SourceFragmentForDistillation } from "../src/modules/sources/distillation.repository.js";
import {
  buildSourceDistillationInputHash,
  buildSourceDistillationMessages,
} from "../src/modules/sources/distillation.service.js";

function fragment(
  overrides: Partial<SourceFragmentForDistillation> = {},
): SourceFragmentForDistillation {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    sourceId: "00000000-0000-4000-8000-000000000200",
    sourceKind: "wiki",
    sourceUri: "/tmp/wiki/rules.md",
    sourceTitle: "Rules",
    sourceContentHash: "hash-a",
    locator: "chunk:0001",
    heading: "Rules",
    content: "# Rules\nUse repository-local verify before committing.",
    metadata: {},
    sourceMetadata: {},
    createdAt: new Date("2026-05-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("source distillation", () => {
  test("builds wiki prompt with shared score and tool constraints", () => {
    const messages = buildSourceDistillationMessages({
      fragment: fragment(),
      maxInputChars: 4000,
    });
    const prompt = messages.map((message) => message.content).join("\n");

    expect(prompt).toContain("Allowed knowledge types are exactly: rule, procedure");
    expect(prompt).toContain("Only emit candidates whose score is at least");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("fetch_content");
    expect(prompt).toContain("SOURCE_FRAGMENT_CONTENT");
    expect(prompt).not.toMatch(/\bfact\b/i);
    expect(prompt).not.toMatch(/\blesson\b/i);
  });

  test("input hash changes when source fragment content changes", () => {
    const base = buildSourceDistillationInputHash(fragment());
    const changed = buildSourceDistillationInputHash(
      fragment({ content: "# Rules\nUse a narrower focused verify command first." }),
    );

    expect(changed).not.toBe(base);
  });
});
