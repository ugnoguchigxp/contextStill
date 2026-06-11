import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  registerReviewCorrections,
} from "../src/modules/registerCandidate/register-review-corrections.service.js";

const mockInsert = vi.fn().mockImplementation(() => makeChain([{ id: "default-id" }]));
const mockSelect = vi.fn().mockImplementation(() => makeSelectChain([]));
const mockAppendQueueEvent = vi.fn().mockResolvedValue(undefined);
const mockTransaction = vi.fn().mockImplementation(async (callback) => {
  const tx = {
    insert: (...args: any[]) => mockInsert(...args),
  };
  return callback(tx);
});

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

vi.mock("../src/modules/queue/core/events.js", () => ({
  appendQueueEvent: (...args: any[]) => mockAppendQueueEvent(...args),
}));

const makeChain = (result: any) => {
  const chain = {
    values: vi.fn().mockImplementation(() => chain),
    onConflictDoUpdate: vi.fn().mockImplementation(() => chain),
    onConflictDoNothing: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
  };
  return chain;
};

const makeSelectChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockResolvedValue(result),
  };
  return chain;
};

describe("register-review-corrections.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendQueueEvent.mockResolvedValue(undefined);
    mockInsert.mockImplementation(() => makeChain([{ id: "default-id" }]));
    mockSelect.mockImplementation(() => makeSelectChain([]));
  });

  test("successfully registers review correction as negative candidate", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }])) // distillationTargetStates insert
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }])) // findCandidateResults insert
      .mockReturnValueOnce(makeChain([{ id: "job-1" }])) // findingCandidateQueue insert
      .mockReturnValueOnce(makeChain([{ id: "found-1" }])) // foundCandidates insert
      .mockReturnValueOnce(makeChain([{ id: "covering-1" }])); // coveringEvidenceQueue insert

    const result = await registerReviewCorrections({
      items: [
        {
          title: "Avoid hardcoding API endpoints",
          finding: "Found hardcoded API host in production config",
          status: "accepted",
          origin: {
            system: "manual_review",
            reviewFindingId: "finding-001",
          },
        },
      ],
    });

    expect(result.status).toBe("success");
    expect(result.registeredCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.duplicateCount).toBe(0);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        index: 0,
        status: "success",
        title: "Avoid hardcoding API endpoints",
      }),
    );
    expect(mockInsert).toHaveBeenCalledTimes(5);
  });

  test("returns duplicate status when correction already exists", async () => {
    mockSelect.mockImplementation(() => makeSelectChain([{ id: "existing-target-id" }]));

    const result = await registerReviewCorrections({
      items: [
        {
          title: "Avoid hardcoding API endpoints",
          finding: "Found hardcoded API host in production config",
          status: "accepted",
          origin: {
            system: "manual_review",
            reviewFindingId: "finding-001",
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.registeredCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        index: 0,
        status: "duplicate",
        error: "Duplicate review correction: manual_review:finding-001",
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("handles partial successes and failures in bulk", async () => {
    // First item: success
    // Second item: duplicate
    mockSelect
      .mockReturnValueOnce(makeSelectChain([])) // first item check: no duplicate
      .mockReturnValueOnce(makeSelectChain([{ id: "existing-id" }])); // second item check: duplicate

    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "job-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "found-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "covering-1" }]));

    const result = await registerReviewCorrections({
      items: [
        {
          title: "Good correction",
          finding: "This is valid finding",
          status: "accepted",
          origin: {
            system: "system-a",
            reviewFindingId: "f-1",
          },
        },
        {
          title: "Duplicate correction",
          finding: "This is already registered",
          status: "accepted",
          origin: {
            system: "system-a",
            reviewFindingId: "f-2",
          },
        },
      ],
    });

    expect(result.status).toBe("partial");
    expect(result.registeredCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.items[0].status).toBe("success");
    expect(result.items[1].status).toBe("duplicate");
  });
});
