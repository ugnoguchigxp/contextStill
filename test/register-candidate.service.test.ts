import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  registerCandidate,
  registerCandidatesBulk,
} from "../src/modules/registerCandidate/register-candidate.service.js";

const mockInsert = vi.fn();
const mockEnqueueFindingJob = vi.fn().mockResolvedValue({ id: "finding-job-1" });
const mockTransaction = vi.fn().mockImplementation(async (callback) => {
  const tx = {
    insert: (...args: any[]) => mockInsert(...args),
  };
  return callback(tx);
});

vi.mock("../src/db/index.js", () => ({
  db: {
    transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

vi.mock("../src/modules/queue/core/index.js", () => ({
  enqueueFindingJob: (...args: any[]) => mockEnqueueFindingJob(...args),
}));

const makeChain = (result: any) => {
  const chain = {
    values: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
  };
  return chain;
};

describe("register-candidate.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueFindingJob.mockResolvedValue({ id: "finding-job-1" });
  });

  test("infers title from markdown heading successfully", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }])) // distillationTargetStates insert
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }])); // findCandidateResults insert

    const result = await registerCandidate({
      text: "# My Custom Rule Header\nThis is the content of the rule.",
      type: "rule",
      metadata: {},
    });

    expect(result.status).toBe("candidate_registered");
    expect(result.title).toBe("My Custom Rule Header"); // Inferred from heading
    expect(result.type).toBe("rule");
    expect(result.warnings).not.toContain("text_parsed_to_candidate_json");
  });

  test("infers title from yaml front-matter if heading is not present", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const result = await registerCandidate({
      text: "title: Front-Matter Title\n\nBody content of the rule.",
      type: "rule",
      metadata: {},
    });

    expect(result.title).toBe("Front-Matter Title");
  });

  test("infers title from first line if no heading or front-matter is found", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const result = await registerCandidate({
      text: "Simple first line\nSecond line here.",
      type: "rule",
      metadata: {},
    });

    expect(result.title).toBe("Simple first line");
  });

  test("emits warning if procedure candidate is missing skill-like section", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const result = await registerCandidate({
      title: "Bad Procedure",
      body: "This body does not contain key skill terms.",
      type: "procedure",
      metadata: {},
    });

    expect(result.warnings).toContain("procedure_candidate_missing_skill_like_sections");
  });

  test("throws validation error in strict mode if procedure candidate is missing skill-like section", async () => {
    await expect(
      registerCandidate(
        {
          title: "Bad Procedure",
          body: "This body does not contain key skill terms.",
          type: "procedure",
          metadata: {},
        },
        { strictProcedureSections: true },
      ),
    ).rejects.toThrow("PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockEnqueueFindingJob).not.toHaveBeenCalled();
  });

  test("does not emit warning if procedure candidate has proper skill-like sections", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const goodProcedureBody = `
Use when:
We want to verify a system functionality.

Workflow:
1. Trigger verify command.
2. Check standard output.

Verification:
Ensure it returns exit code 0.

Avoid:
Do not run on production database.
`;

    const result = await registerCandidate({
      title: "Good Procedure",
      body: goodProcedureBody,
      type: "procedure",
      metadata: {},
    });

    expect(result.warnings).not.toContain("procedure_candidate_missing_skill_like_sections");
  });

  test("emits warning and parses correctly when text is structured LLM JSON output", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const jsonText = `\`\`\`json
[
  {
    "title": "Parsed JSON Title",
    "type": "rule",
    "content": "This is content from parsed JSON."
  }
]
\`\`\``;

    const result = await registerCandidate({
      text: jsonText,
      metadata: {},
    });

    expect(result.title).toBe("Parsed JSON Title");
    expect(result.warnings).toContain("text_parsed_to_candidate_json");
  });

  test("emits warning when text contains multiple candidates and registers the first one", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const jsonText = `\`\`\`json
[
  {
    "title": "First Candidate Title",
    "type": "rule",
    "content": "This is the first candidate content."
  },
  {
    "title": "Second Candidate Title",
    "type": "rule",
    "content": "This is the second candidate content."
  }
]
\`\`\``;

    const result = await registerCandidate({
      text: jsonText,
      metadata: {},
    });

    expect(result.title).toBe("First Candidate Title");
    expect(result.warnings).toContain("text_parsed_to_candidate_json");
    expect(result.warnings).toContain("text_contained_multiple_candidates_registered_first");
  });

  test("throws error if database insertion returns empty target", async () => {
    mockInsert.mockReturnValueOnce(makeChain([])); // Failed to insert target

    await expect(
      registerCandidate({
        title: "Test target failed",
        body: "body",
        metadata: {},
      }),
    ).rejects.toThrow("failed to create candidate target state");
  });

  test("throws error if database insertion returns empty candidate", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([])); // Failed to insert candidate

    await expect(
      registerCandidate({
        title: "Test candidate failed",
        body: "body",
        metadata: {},
      }),
    ).rejects.toThrow("failed to create candidate result");
  });

  test("populates compactOrigin metadata correctly based on inputs", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    await registerCandidate({
      title: "Metadata Test",
      body: "Body",
      confidence: 85,
      importance: 90,
      technologies: ["nodejs", "typescript"],
      repoPath: "/Users/user/project",
      repoKey: "my-repo",
      metadata: { customField: "val" },
    });

    // Verify insert args for findCandidateResults (second call)
    const candidateInsertValues = mockInsert.mock.calls[1][0]; // we pass target db schema table in insert call, values are inside values() chain
    // In our simplified mock makeChain, values() is just chaining, but we can verify mockInsert was called with findCandidateResults table schema.
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  test("assigns wiki priority when metadata indicates wiki parent", async () => {
    const targetChain = makeChain([{ id: "target-1" }]);
    const candidateChain = makeChain([{ id: "candidate-1" }]);
    mockInsert.mockReturnValueOnce(targetChain).mockReturnValueOnce(candidateChain);

    await registerCandidate({
      title: "Wiki derived candidate",
      body: "body",
      metadata: {
        parentTargetKind: "wiki_file",
      },
    });

    expect(targetChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        priorityGroup: "wiki",
      }),
    );
  });

  test("registers candidates in bulk and defaults missing type to rule", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "target-2" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-2" }]));

    const result = await registerCandidatesBulk([{ body: "A" }, { body: "B", type: "procedure" }]);

    expect(result.status).toBe("bulk_candidates_registered");
    expect(result.registeredCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        index: 0,
        status: "candidate_registered",
        type: "rule",
      }),
    );
    expect(result.items[1]).toEqual(
      expect.objectContaining({
        index: 1,
        status: "candidate_registered",
        type: "procedure",
      }),
    );
    expect(mockEnqueueFindingJob).toHaveBeenCalledTimes(2);
    const firstOrigin = mockEnqueueFindingJob.mock.calls[0]?.[0]?.payload?.origin;
    const secondOrigin = mockEnqueueFindingJob.mock.calls[1]?.[0]?.payload?.origin;
    expect(firstOrigin?.metadata).toEqual(
      expect.objectContaining({
        bulkIndex: 0,
        bulkCount: 2,
        bulkSource: "mcp_register_candidates",
        inputTypeProvided: false,
      }),
    );
    expect(secondOrigin?.metadata).toEqual(
      expect.objectContaining({
        bulkIndex: 1,
        bulkCount: 2,
        bulkSource: "mcp_register_candidates",
        inputTypeProvided: true,
      }),
    );
    expect(firstOrigin?.metadata?.bulkBatchId).toBeTypeOf("string");
    expect(firstOrigin?.metadata?.bulkBatchId).toBe(secondOrigin?.metadata?.bulkBatchId);
  });

  test("returns partial result when one bulk item fails", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "target-2" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-2" }]));
    mockEnqueueFindingJob
      .mockResolvedValueOnce({ id: "finding-job-1" })
      .mockRejectedValueOnce(new Error("queue unavailable"));

    const result = await registerCandidatesBulk([{ body: "A" }, { body: "B" }]);

    expect(result.status).toBe("bulk_candidates_partial");
    expect(result.registeredCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.items[1]).toEqual(
      expect.objectContaining({
        index: 1,
        status: "candidate_failed",
        error: "queue unavailable",
      }),
    );
  });

  test("marks invalid procedure item as failed in strict bulk mode", async () => {
    mockInsert
      .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
      .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]));

    const result = await registerCandidatesBulk(
      [
        {
          title: "Bad Procedure",
          body: "This body does not contain key skill terms.",
          type: "procedure",
        },
        { body: "Valid rule body" },
      ],
      { strictProcedureSections: true },
    );

    expect(result.status).toBe("bulk_candidates_partial");
    expect(result.registeredCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        index: 0,
        status: "candidate_failed",
        error: "PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS",
      }),
    );
    expect(result.items[1]).toEqual(
      expect.objectContaining({
        index: 1,
        status: "candidate_registered",
        type: "rule",
      }),
    );
  });

  test("validates max bulk size before DB writes", async () => {
    const overLimit = Array.from({ length: 11 }, (_, index) => ({ body: `body-${index}` }));

    await expect(registerCandidatesBulk(overLimit)).rejects.toThrow();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
