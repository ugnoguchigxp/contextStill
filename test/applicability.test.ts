import { describe, expect, test } from "vitest";
import {
  applicabilityFromCoverCandidate,
  applicabilityToCoverCandidateFields,
  hasRequiredApplicabilityFacets,
  mergeApplicability,
  missingRequiredApplicabilityFacets,
  normalizeApplicability,
} from "../src/modules/knowledge/applicability.js";

describe("knowledge applicability", () => {
  test("normalizes nested appliesTo and comma-separated values", () => {
    expect(
      normalizeApplicability({
        appliesTo: {
          technologies: "typescript, vitest, typescript",
          changeTypes: ["diagnosis", ""],
          domains: "queue、distillation",
          repoPath: " /repo ",
          general: false,
        },
      }),
    ).toEqual({
      general: false,
      technologies: ["typescript", "vitest"],
      changeTypes: ["diagnosis"],
      domains: ["queue", "distillation"],
      repoPath: "/repo",
    });
  });

  test("normalizes flat applicabilityGeneral and aliases", () => {
    expect(
      normalizeApplicability({
        applicabilityGeneral: "true",
        TECHNOLOGIES: '["sqlite","typescript"]',
        CHANGE_TYPES: "schema",
        DOMAIN: "storage",
        repo_key: "contextStill",
      }),
    ).toEqual({
      general: true,
      technologies: ["sqlite", "typescript"],
      changeTypes: ["schema"],
      domains: ["storage"],
      repoKey: "contextStill",
    });
  });

  test("normalizes nested snake_case applicability aliases", () => {
    expect(
      normalizeApplicability({
        applies_to: {
          technologies: "sqlite",
          change_types: "runtime-test",
          domain: "queue",
          repo_path: " /repo/contextStill ",
          applicability_general: "false",
        },
      }),
    ).toEqual({
      general: false,
      technologies: ["sqlite"],
      changeTypes: ["runtime-test"],
      domains: ["queue"],
      repoPath: "/repo/contextStill",
    });
  });

  test("merges later applicability over earlier values", () => {
    expect(
      mergeApplicability(
        {
          technologies: ["typescript"],
          changeTypes: ["diagnosis"],
          domains: ["queue"],
          general: false,
        },
        {
          technologies: ["sqlite"],
          repoPath: "/repo/contextStill",
        },
      ),
    ).toEqual({
      general: false,
      technologies: ["sqlite"],
      changeTypes: ["diagnosis"],
      domains: ["queue"],
      repoPath: "/repo/contextStill",
    });
  });

  test("converts between canonical and cover candidate fields", () => {
    const canonical = {
      general: false,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["distillation"],
      repoKey: "contextStill",
    };

    expect(applicabilityToCoverCandidateFields(canonical)).toEqual({
      applicabilityGeneral: false,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["distillation"],
      repoKey: "contextStill",
    });
    expect(
      applicabilityFromCoverCandidate({
        applicabilityGeneral: false,
        technologies: ["typescript"],
        changeTypes: ["bugfix"],
        domains: ["distillation"],
        repoKey: "contextStill",
      }),
    ).toEqual(canonical);
  });

  test("reports missing required facets", () => {
    expect(
      missingRequiredApplicabilityFacets({
        technologies: ["typescript"],
        domains: ["distillation"],
      }),
    ).toEqual(["changeTypes"]);
    expect(
      hasRequiredApplicabilityFacets({
        technologies: ["typescript"],
        changeTypes: ["bugfix"],
        domains: ["distillation"],
      }),
    ).toBe(true);
  });
});
