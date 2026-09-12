import { describe, expect, test, vi } from "vitest";
import {
  asRecord,
  buildKnowledgeListOrderBy,
  buildKnowledgeListWhere,
  buildNormalizedApplicability,
  extractSourceRefs,
  extractSourceVibeMemoryIds,
  isMissingKnowledgeLifecycleColumnsError,
  mergeApplicabilityMetadata,
  mergeNormalizedApplicability,
} from "../src/modules/knowledge/knowledge-admin.repository.helpers.js";

vi.mock("../src/modules/knowledge/knowledge-tags.repository.js", () => ({
  listKnowledgeTagDefinitions: vi.fn(async () => [
    { kind: "technology", slug: "typescript", aliases: [], status: "active" },
    { kind: "change_type", slug: "refactor", aliases: [], status: "active" },
    { kind: "domain", slug: "testing", aliases: [], status: "active" },
  ]),
}));

describe("knowledge-admin repository helpers", () => {
  test("asRecord only keeps plain objects", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1])).toEqual({});
    expect(asRecord("x")).toEqual({});
  });

  test("extractSourceRefs keeps unique trimmed refs and derived locators", () => {
    expect(
      extractSourceRefs({
        sourceRefs: [" file://a#1 ", "file://a#1", 12, ""],
        candidateSourceRefs: ["file://b"],
        sourceDocumentUri: "file://doc",
        sourceFragmentLocator: "L2",
      }),
    ).toEqual(["file://a#1", "file://b", "file://doc#L2"]);
    expect(extractSourceRefs({ sourceUri: "file://only" })).toEqual(["file://only#full"]);
    expect(extractSourceRefs({})).toEqual([]);
  });

  test("extractSourceVibeMemoryIds reads both direct ids and vibe-memory URIs", () => {
    expect(
      extractSourceVibeMemoryIds({
        sourceVibeMemoryIds: [" vm-1 ", "", 3],
        sourceUri: "vibe-memory://vm-2",
      }),
    ).toEqual(["vm-1", "vm-2"]);
    expect(extractSourceVibeMemoryIds({ sourceUri: "file://x" })).toEqual([]);
  });

  test("isMissingKnowledgeLifecycleColumnsError recognizes postgres and sqlite signals", () => {
    expect(isMissingKnowledgeLifecycleColumnsError({ code: "42703" })).toBe(true);
    expect(
      isMissingKnowledgeLifecycleColumnsError(new Error("column last_compiled_at missing")),
    ).toBe(true);
    for (const token of [
      "compile_select_count",
      "agentic_accept_count",
      "explicit_upvote_count",
      "explicit_downvote_count",
      "dynamic_score",
    ]) {
      expect(isMissingKnowledgeLifecycleColumnsError(token)).toBe(true);
    }
    expect(isMissingKnowledgeLifecycleColumnsError("unrelated")).toBe(false);
  });

  test("buildKnowledgeListWhere covers display filters, search, quality and tags", () => {
    expect(buildKnowledgeListWhere({})).toBeUndefined();
    expect(buildKnowledgeListWhere({ displayFilter: "draft" })).toBeDefined();
    expect(buildKnowledgeListWhere({ displayFilter: "active" })).toBeDefined();
    expect(buildKnowledgeListWhere({ displayFilter: "deprecated" })).toBeDefined();
    expect(buildKnowledgeListWhere({ status: "active" })).toBeDefined();
    expect(buildKnowledgeListWhere({ displayFilter: "unused-active" })).toBeDefined();
    expect(buildKnowledgeListWhere({ displayFilter: "stale" })).toBeDefined();
    expect(buildKnowledgeListWhere({ displayFilter: "high-value" })).toBeDefined();
    expect(buildKnowledgeListWhere({ type: "rule" })).toBeDefined();
    expect(buildKnowledgeListWhere({ polarities: ["negative"] })).toBeDefined();
    expect(buildKnowledgeListWhere({ intentTags: ["release"] })).toBeDefined();
    expect(buildKnowledgeListWhere({ query: " sqlite " })).toBeDefined();
    expect(buildKnowledgeListWhere({ minQuality: 70 })).toBeDefined();
  });

  test("buildKnowledgeListOrderBy accepts known sort keys and falls back", () => {
    for (const sortBy of [
      "title",
      "type",
      "status",
      "scope",
      "qualityScore",
      "updatedAt",
      "unknown",
    ]) {
      expect(buildKnowledgeListOrderBy({ sortBy: sortBy as any, sortDir: "asc" })).toHaveLength(3);
      expect(buildKnowledgeListOrderBy({ sortBy: sortBy as any, sortDir: "desc" })).toHaveLength(3);
    }
    expect(buildKnowledgeListOrderBy({})).toHaveLength(3);
  });

  test("mergeNormalizedApplicability preserves unknown keys from existing and incoming values", () => {
    expect(
      mergeNormalizedApplicability({
        existingAppliesTo: { extra: 1, technologies: ["old"] },
        inputAppliesTo: { extra: 2, custom: true },
        normalizedAppliesTo: { technologies: ["sqlite"] },
      }),
    ).toEqual({ extra: 2, custom: true, technologies: ["sqlite"] });
  });

  test("buildNormalizedApplicability merges facet fields", async () => {
    const result = await buildNormalizedApplicability({
      technologies: ["typescript"],
      changeTypes: ["refactor"],
      domains: ["testing"],
    });
    expect(result.appliesTo).toMatchObject({
      technologies: ["typescript"],
      changeTypes: ["refactor"],
      domains: ["testing"],
    });
  });

  test("mergeApplicabilityMetadata records warnings and unknown tags", () => {
    const empty = {
      appliesTo: { technologies: ["sqlite"] },
      warnings: [] as string[],
      unknownTagCandidates: [] as Array<{
        kind: "technology";
        value: string;
        normalizedSlug: string;
        reason: string;
      }>,
    };
    expect(mergeApplicabilityMetadata({ keep: true }, empty)).toEqual({ keep: true });
    expect(
      mergeApplicabilityMetadata(
        {},
        {
          ...empty,
          warnings: ["dup"],
          unknownTagCandidates: [
            {
              kind: "technology",
              value: "mystery",
              normalizedSlug: "mystery",
              reason: "unknown",
            },
          ],
        },
      ),
    ).toEqual({
      tagNormalizationWarnings: ["dup"],
      unknownTagCandidates: [
        { kind: "technology", value: "mystery", normalizedSlug: "mystery", reason: "unknown" },
      ],
    });
  });
});
