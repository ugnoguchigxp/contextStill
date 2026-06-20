import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  queueWebSourceUrl,
  queueWebSourceUrls,
} from "../src/modules/sources/web/source-queue.service.js";
import { researchWebSourceToMarkdown } from "../src/modules/sources/web/source-research.service.js";

// config モック
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    vibeDistillation: {
      maxOutputTokens: 2048,
    },
    sourceContent: {
      root: "/mock/wiki/root",
    },
  },
}));

// queue core モック
const mockEnqueueFindingJob = vi.fn();
const mockFindFindingJob = vi.fn();
vi.mock("../src/modules/queue/core/index.js", () => ({
  enqueueFindingJob: (...args: any[]) => mockEnqueueFindingJob(...args),
  findFindingJob: (...args: any[]) => mockFindFindingJob(...args),
}));

// distillation tools モック
const mockValidateFetchContentUrl = vi.fn();
vi.mock("../src/modules/distillation/distillation-tools.service.js", () => ({
  validateFetchContentUrl: (...args: any[]) => mockValidateFetchContentUrl(...args),
}));

// distillation runtime モック
const mockRunDistillationCompletion = vi.fn();
const mockResolveDistillationModel = vi.fn();
const mockResolveRouteModelForProvider = vi.fn();
vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  runDistillationCompletion: (...args: any[]) => mockRunDistillationCompletion(...args),
  resolveDistillationModel: (...args: any[]) => mockResolveDistillationModel(...args),
  resolveRouteModelForProvider: (...args: any[]) => mockResolveRouteModelForProvider(...args),
}));

// settings service モック
const mockEnsureRuntimeSettingsLoaded = vi.fn();
const mockResolveWebSourceResearchRoute = vi.fn();
vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: (...args: any[]) => mockEnsureRuntimeSettingsLoaded(...args),
  resolveWebSourceResearchRoute: (...args: any[]) => mockResolveWebSourceResearchRoute(...args),
}));

// source repository モック
const mockUpsertSourceDocument = vi.fn();
vi.mock("../src/modules/sources/source.repository.js", () => ({
  upsertSourceDocument: (...args: any[]) => mockUpsertSourceDocument(...args),
}));

// wiki content-repo モック
const mockEnsureContentRoot = vi.fn();
const mockWritePage = vi.fn();
vi.mock("../src/modules/sources/wiki/content-repo.js", () => ({
  ensureContentRoot: (...args: any[]) => mockEnsureContentRoot(...args),
  writePage: (...args: any[]) => mockWritePage(...args),
}));

describe("source-web", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateFetchContentUrl.mockReturnValue({ safe: true });
    mockResolveWebSourceResearchRoute.mockReturnValue({
      provider: "openai",
      fallback: [],
      azureDeploymentSlots: undefined,
      localLlmModel: undefined,
    });
    mockResolveDistillationModel.mockReturnValue("gpt-4");
    mockResolveRouteModelForProvider.mockImplementation(
      (params: { routeModel?: string; localLlmModel?: string }) =>
        params.localLlmModel ?? params.routeModel ?? "gpt-4",
    );
  });

  describe("source-queue.service", () => {
    describe("queueWebSourceUrl", () => {
      test("returns error if protocol is not http or https", async () => {
        const result = await queueWebSourceUrl({ url: "ftp://example.com" });
        expect(result).toEqual({
          ok: false,
          url: "ftp://example.com",
          reason: "protocol must be http or https",
        });
      });

      test("returns error if validateFetchContentUrl returns unsafe", async () => {
        mockValidateFetchContentUrl.mockReturnValue({ safe: false, reason: "URL is blacklisted" });
        const result = await queueWebSourceUrl({ url: "https://example.com" });
        expect(result).toEqual({
          ok: false,
          url: "https://example.com",
          reason: "URL is blacklisted",
        });
      });

      test("returns success if job enqueued successfully (new job)", async () => {
        mockFindFindingJob.mockResolvedValue(null);
        mockEnqueueFindingJob.mockResolvedValue({
          id: "job-1",
          status: "pending",
          priority: 80,
          attemptCount: 0,
          distillationVersion: "v1",
          sourceKey: "https://example.com/",
          sourceUri: "https://example.com/",
          createdAt: new Date("2026-06-10T12:00:00Z"),
          updatedAt: new Date("2026-06-10T12:00:00Z"),
        });

        const result = await queueWebSourceUrl({ url: "https://example.com" });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.item.url).toBe("https://example.com");
          expect(result.item.normalizedUrl).toBe("https://example.com/");
          expect(result.item.existing).toBe(false);
          expect(result.item.state.id).toBe("job-1");
        }
      });

      test("returns success if job enqueued successfully (existing job)", async () => {
        mockFindFindingJob.mockResolvedValue({ id: "job-1" });
        mockEnqueueFindingJob.mockResolvedValue({
          id: "job-1",
          status: "pending",
          priority: 80,
          attemptCount: 0,
          distillationVersion: "v1",
          sourceKey: "https://example.com/",
          sourceUri: "https://example.com/",
          createdAt: new Date("2026-06-10T12:00:00Z"),
          updatedAt: new Date("2026-06-10T12:00:00Z"),
        });

        const result = await queueWebSourceUrl({ url: "https://example.com" });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.item.existing).toBe(true);
        }
      });

      test("returns error if enqueueFindingJob returns null", async () => {
        mockFindFindingJob.mockResolvedValue(null);
        mockEnqueueFindingJob.mockResolvedValue(null);

        const result = await queueWebSourceUrl({ url: "https://example.com" });
        expect(result).toEqual({
          ok: false,
          url: "https://example.com",
          reason: "source not found",
        });
      });
    });

    describe("queueWebSourceUrls", () => {
      test("ignores empty string urls and handles duplicates", async () => {
        mockFindFindingJob.mockResolvedValue(null);
        mockEnqueueFindingJob.mockResolvedValue({
          id: "job-1",
          status: "pending",
          priority: 80,
          attemptCount: 0,
          distillationVersion: "v1",
          sourceKey: "https://example.com/",
          sourceUri: "https://example.com/",
          createdAt: new Date("2026-06-10T12:00:00Z"),
          updatedAt: new Date("2026-06-10T12:00:00Z"),
        });

        const result = await queueWebSourceUrls({
          urls: ["  ", "https://example.com", "https://example.com", "invalid-url"],
        });

        expect(result.total).toBe(4);
        expect(result.queued).toBe(1);
        expect(result.invalid).toBe(1); // invalid-url is invalid
        expect(result.duplicateInRequest).toBe(1); // second https://example.com is duplicate
        expect(result.items.length).toBe(3); // "  " was skipped completely
      });
    });
  });

  describe("source-research.service", () => {
    describe("researchWebSourceToMarkdown", () => {
      test("throws error if web source research markdown is empty", async () => {
        mockRunDistillationCompletion.mockResolvedValue({
          content: "   ",
          toolEvents: [],
        });

        await expect(
          researchWebSourceToMarkdown({
            url: "https://example.com/test",
            normalizedUrl: "https://example.com/test",
          }),
        ).rejects.toThrow("web source research markdown is empty");
      });

      test("throws error if saved wiki path is outside pages root", async () => {
        mockRunDistillationCompletion.mockResolvedValue({
          content: "# Title\n\nBody content",
          toolEvents: [],
        });
        mockWritePage.mockResolvedValue({
          path: "/mock/outside/path/page.md", // outside /mock/wiki/root/pages
        });

        await expect(
          researchWebSourceToMarkdown({
            url: "https://example.com/test",
            normalizedUrl: "https://example.com/test",
          }),
        ).rejects.toThrow("saved wiki path must stay inside wiki/pages");
      });

      test("successfully researches web source, writes wiki page, upserts document, and returns result", async () => {
        mockRunDistillationCompletion.mockResolvedValue({
          content:
            "```markdown\n# Target Title\n\nSource URL: https://example.com/test\n\n## Summary\nContent\n```",
          toolEvents: [
            {
              name: "fetch_content",
              metadata: { finalUrl: "https://example.com/final-url" },
            },
          ],
        });
        mockWritePage.mockResolvedValue({
          path: "/mock/wiki/root/pages/websource/example-com/test.md",
        });

        const result = await researchWebSourceToMarkdown({
          url: "https://example.com/test",
          normalizedUrl: "https://example.com/test",
        });

        expect(result.title).toBe("Target Title");
        expect(result.body).toBe(
          "# Target Title\n\nSource URL: https://example.com/test\n\n## Summary\nContent",
        );
        expect(result.savedWikiSlug).toBe("websource/example-com/test");
        expect(result.savedWikiTargetKey).toBe("websource/example-com/test.md");
        expect(result.fetchFinalUrl).toBe("https://example.com/final-url");

        expect(mockEnsureContentRoot).toHaveBeenCalledWith("/mock/wiki/root");
        expect(mockWritePage).toHaveBeenCalledWith(
          "/mock/wiki/root",
          "websource/example-com/test",
          "Target Title",
          expect.stringContaining("Target Title"),
          expect.objectContaining({
            sourceUrl: "https://example.com/test",
            normalizedUrl: "https://example.com/test",
          }),
        );
        expect(mockUpsertSourceDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceKind: "wiki",
            uri: "websource/example-com/test.md",
            title: "Target Title",
          }),
        );
      });

      test("uses title fallback if heading # is missing", async () => {
        mockRunDistillationCompletion.mockResolvedValue({
          content: "No heading here. Just content.",
          toolEvents: [],
        });
        mockWritePage.mockResolvedValue({
          path: "/mock/wiki/root/pages/websource/example-com/test.md",
        });

        const result = await researchWebSourceToMarkdown({
          url: "https://example.com/test",
          normalizedUrl: "https://example.com/test",
        });

        expect(result.title).toBe("example.com/test");
      });
    });
  });
});
