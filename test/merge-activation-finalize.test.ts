import crypto from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DeadZoneMergeReviewQueueError } from "../src/modules/landscape/deadzone-merge-review-queue.service.js";
import { createMergeActivationFinalizeJob } from "../src/modules/landscape/merge-activation-finalize.service.js";
import { processMergeActivationFinalizeJob } from "../src/modules/landscape/merge-activation-finalize.worker.js";

// クエリ結果解決用のキュー
let mockDbResults: any[] = [];

// db index のモック
vi.mock("../src/db/index.js", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve) => {
      resolve(mockDbResults.shift() ?? []);
    }),
  };
  return {
    db: mockDb,
  };
});

// queue events モック
const mockAppendQueueEvent = vi.fn();
vi.mock("../src/modules/queue/core/events.js", () => ({
  appendQueueEvent: (...args: any[]) => mockAppendQueueEvent(...args),
}));

// settings service モック
const mockEnsureRuntimeSettingsLoaded = vi.fn();
const mockGetRuntimeSettingsSnapshot = vi.fn();
vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: (...args: any[]) => mockEnsureRuntimeSettingsLoaded(...args),
  getRuntimeSettingsSnapshot: (...args: any[]) => mockGetRuntimeSettingsSnapshot(...args),
}));

// knowledge repository モック
const mockUpdateKnowledgeItem = vi.fn();
vi.mock("../api/modules/knowledge/knowledge.repository.js", () => ({
  updateKnowledgeItem: (...args: any[]) => mockUpdateKnowledgeItem(...args),
}));

const validMergeResult = {
  decision: "merge_recommended",
  confidence: "high",
  rationale: [],
  blockers: [],
  proposedCanonicalBody: "New Body",
  proposedSummary: "Summary",
  rawOutputExcerpt: "raw",
  parseStatus: "parsed",
};

describe("merge-activation-finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbResults = [];
    mockGetRuntimeSettingsSnapshot.mockReturnValue({
      taskRouting: {
        finalizeDistille: {
          provider: "openai",
          model: "gpt-4",
        },
      },
    });
  });

  describe("createMergeActivationFinalizeJob", () => {
    test("throws error if merge review job not found", async () => {
      mockDbResults = [[]]; // select from deadZoneMergeReviewQueue returns empty
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "merge review job not found",
      );
    });

    test("throws error if merge review job is not completed", async () => {
      mockDbResults = [[{ id: "job-1", status: "pending" }]];
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "merge review job is not completed",
      );
    });

    test("throws error if merge review job has no canonical knowledge", async () => {
      mockDbResults = [[{ id: "job-1", status: "completed", canonicalKnowledgeId: null }]];
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "merge review job has no canonical knowledge",
      );
    });

    test("throws error if merge review did not recommend finalization", async () => {
      mockDbResults = [
        [
          {
            id: "job-1",
            status: "completed",
            canonicalKnowledgeId: "ca-1",
            result: {
              decision: "keep_separate",
              confidence: "high",
              rationale: [],
              blockers: [],
              proposedCanonicalBody: null,
              proposedSummary: null,
              rawOutputExcerpt: "raw",
              parseStatus: "parsed",
            },
          },
        ],
      ];
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "merge review did not recommend finalization",
      );
    });

    test("throws error if deadZone knowledge row is missing", async () => {
      mockDbResults = [
        [
          {
            id: "job-1",
            status: "completed",
            canonicalKnowledgeId: "ca-1",
            deadZoneKnowledgeId: "dz-1",
            result: validMergeResult,
          },
        ],
        [], // deadZone not found
      ];
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "knowledge row missing",
      );
    });

    test("throws error if canonical knowledge row is missing", async () => {
      mockDbResults = [
        [
          {
            id: "job-1",
            status: "completed",
            canonicalKnowledgeId: "ca-1",
            deadZoneKnowledgeId: "dz-1",
            result: validMergeResult,
          },
        ],
        [{ id: "dz-1", title: "DZ", body: "DZ Body", status: "active" }], // deadZone found
        [], // canonical not found
      ];
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "knowledge row missing",
      );
    });

    test("throws error if dead-zone and canonical knowledge must differ", async () => {
      mockDbResults = [
        [
          {
            id: "job-1",
            status: "completed",
            canonicalKnowledgeId: "ca-1",
            deadZoneKnowledgeId: "ca-1", // same ID
            result: validMergeResult,
          },
        ],
        [{ id: "ca-1", title: "CA", body: "CA Body", status: "active" }], // deadZone found
        [{ id: "ca-1", title: "CA", body: "CA Body", status: "active" }], // canonical found
      ];
      await expect(createMergeActivationFinalizeJob("job-1")).rejects.toThrow(
        "dead-zone and canonical knowledge must differ",
      );
    });

    test("successfully creates a job", async () => {
      mockDbResults = [
        [
          {
            id: "job-1",
            status: "completed",
            canonicalKnowledgeId: "ca-1",
            deadZoneKnowledgeId: "dz-1",
            result: validMergeResult,
            priority: 85,
            reviewItemId: "review-1",
          },
        ],
        [
          {
            id: "dz-1",
            title: "DZ",
            body: "DZ Body",
            status: "active",
            appliesTo: null,
            metadata: null,
          },
        ],
        [
          {
            id: "ca-1",
            title: "CA",
            body: "CA Body",
            status: "active",
            appliesTo: null,
            metadata: null,
          },
        ],
        [
          {
            id: "finalize-job-1",
            status: "pending",
            mergeReviewJobId: "job-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            reviewItemId: "review-1",
          },
        ], // returned from insert
      ];

      const result = await createMergeActivationFinalizeJob("job-1");
      expect(result).toEqual({
        id: "finalize-job-1",
        status: "pending",
        jobType: "merge_activation_finalize",
        mergeReviewJobId: "job-1",
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        reviewItemId: "review-1",
      });
      expect(mockAppendQueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: "mergeActivationFinalize",
          queueJobId: "finalize-job-1",
          eventType: "enqueued",
        }),
      );
    });

    test("falls back to local-llm if route provider is auto", async () => {
      mockGetRuntimeSettingsSnapshot.mockReturnValue({
        taskRouting: {
          finalizeDistille: {
            provider: "auto",
            model: null,
          },
        },
      });

      mockDbResults = [
        [
          {
            id: "job-1",
            status: "completed",
            canonicalKnowledgeId: "ca-1",
            deadZoneKnowledgeId: "dz-1",
            result: validMergeResult,
            priority: 85,
            reviewItemId: "review-1",
          },
        ],
        [
          {
            id: "dz-1",
            title: "DZ",
            body: "DZ Body",
            status: "active",
            appliesTo: null,
            metadata: null,
          },
        ],
        [
          {
            id: "ca-1",
            title: "CA",
            body: "CA Body",
            status: "active",
            appliesTo: null,
            metadata: null,
          },
        ],
        [
          {
            id: "finalize-job-1",
            status: "pending",
            mergeReviewJobId: "job-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            reviewItemId: "review-1",
          },
        ], // returned from insert
      ];

      const result = await createMergeActivationFinalizeJob("job-1");
      expect(result.id).toBe("finalize-job-1");
    });
  });

  describe("processMergeActivationFinalizeJob", () => {
    test("throws error if job not found", async () => {
      mockDbResults = [[]]; // select finalize queue returns empty
      await expect(processMergeActivationFinalizeJob("fjob-1")).rejects.toThrow(
        "merge activation finalize job not found: fjob-1",
      );
    });

    test("skips the job if knowledge rows are missing in db", async () => {
      mockDbResults = [
        [
          {
            id: "fjob-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            inputSnapshot: {},
          },
        ],
        [], // deadZone not found
      ];

      await processMergeActivationFinalizeJob("fjob-1");
      expect(mockAppendQueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "claimed",
        }),
      );
      // update to skip the job
      expect(mockDbResults.length).toBe(0); // verified update call consumed mockDbResults
    });

    test("skips the job if bodyHash mismatches or status changed", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const hdz = crypto.createHash("sha256").update(dzBody).digest("hex");
      const hca = crypto.createHash("sha256").update(caBody).digest("hex");

      mockDbResults = [
        [
          {
            id: "fjob-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            inputSnapshot: {
              deadZone: { bodyHash: hdz },
              canonical: { bodyHash: hca },
            },
          },
        ],
        [{ id: "dz-1", body: "Changed DZ Body", status: "active" }], // different body
        [{ id: "ca-1", body: caBody, status: "active" }],
      ];

      await processMergeActivationFinalizeJob("fjob-1");
      // should mark skipped
    });

    test("skips the job if proposedCanonicalBody is missing", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const hdz = crypto.createHash("sha256").update(dzBody).digest("hex");
      const hca = crypto.createHash("sha256").update(caBody).digest("hex");

      mockDbResults = [
        [
          {
            id: "fjob-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            inputSnapshot: {
              mergeReviewJob: { proposedCanonicalBody: "" }, // empty
              deadZone: { bodyHash: hdz },
              canonical: { bodyHash: hca },
            },
          },
        ],
        [{ id: "dz-1", body: dzBody, status: "active" }],
        [{ id: "ca-1", body: caBody, status: "active" }],
      ];

      await processMergeActivationFinalizeJob("fjob-1");
    });

    test("successfully completes the job", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const hdz = crypto.createHash("sha256").update(dzBody).digest("hex");
      const hca = crypto.createHash("sha256").update(caBody).digest("hex");

      mockDbResults = [
        [
          {
            id: "fjob-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            attemptCount: 1,
            inputSnapshot: {
              mergeReviewJob: { proposedCanonicalBody: "Unified body" },
              deadZone: { bodyHash: hdz },
              canonical: { bodyHash: hca },
            },
          },
        ],
        [
          {
            id: "dz-1",
            body: dzBody,
            status: "active",
            appliesTo: { technologies: ["node"], general: true },
          },
        ],
        [
          {
            id: "ca-1",
            body: caBody,
            status: "active",
            appliesTo: { technologies: ["react"], repoPath: "path" },
          },
        ],
      ];

      mockUpdateKnowledgeItem.mockResolvedValueOnce({ id: "ca-1" }); // canonical update
      mockUpdateKnowledgeItem.mockResolvedValueOnce({ id: "dz-1" }); // deadzone update

      await processMergeActivationFinalizeJob("fjob-1");

      expect(mockUpdateKnowledgeItem).toHaveBeenNthCalledWith(
        1,
        "ca-1",
        expect.objectContaining({
          body: "Unified body",
          appliesTo: expect.objectContaining({
            technologies: ["react", "node"],
            general: true,
            repoPath: "path",
          }),
        }),
      );
      expect(mockUpdateKnowledgeItem).toHaveBeenNthCalledWith(
        2,
        "dz-1",
        expect.objectContaining({
          status: "deprecated",
        }),
      );
      expect(mockAppendQueueEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          eventType: "completed",
        }),
      );
    });

    test("throws error if canonical knowledge update fails", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const hdz = crypto.createHash("sha256").update(dzBody).digest("hex");
      const hca = crypto.createHash("sha256").update(caBody).digest("hex");

      mockDbResults = [
        [
          {
            id: "fjob-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            inputSnapshot: {
              mergeReviewJob: { proposedCanonicalBody: "Unified body" },
              deadZone: { bodyHash: hdz },
              canonical: { bodyHash: hca },
            },
          },
        ],
        [{ id: "dz-1", body: dzBody, status: "active" }],
        [{ id: "ca-1", body: caBody, status: "active" }],
      ];

      mockUpdateKnowledgeItem.mockResolvedValueOnce(null); // fails

      await expect(processMergeActivationFinalizeJob("fjob-1")).rejects.toThrow(
        "canonical knowledge update failed: ca-1",
      );
    });

    test("throws error if dead-zone knowledge deprecation fails", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const hdz = crypto.createHash("sha256").update(dzBody).digest("hex");
      const hca = crypto.createHash("sha256").update(caBody).digest("hex");

      mockDbResults = [
        [
          {
            id: "fjob-1",
            deadZoneKnowledgeId: "dz-1",
            canonicalKnowledgeId: "ca-1",
            inputSnapshot: {
              mergeReviewJob: { proposedCanonicalBody: "Unified body" },
              deadZone: { bodyHash: hdz },
              canonical: { bodyHash: hca },
            },
          },
        ],
        [{ id: "dz-1", body: dzBody, status: "active" }],
        [{ id: "ca-1", body: caBody, status: "active" }],
      ];

      mockUpdateKnowledgeItem.mockResolvedValueOnce({ id: "ca-1" }); // canonical OK
      mockUpdateKnowledgeItem.mockResolvedValueOnce(null); // deadzone fails

      await expect(processMergeActivationFinalizeJob("fjob-1")).rejects.toThrow(
        "dead-zone knowledge deprecation failed: dz-1",
      );
    });
  });
});
