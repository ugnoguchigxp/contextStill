import { describe, expect, test } from "vitest";
import { buildFilteredVibeMemoryForCandidateContent } from "../src/modules/findCandidate/vibe-memory-filter.js";

describe("buildFilteredVibeMemoryForCandidateContent", () => {
  test("drops boilerplate while preserving commands and diff material", () => {
    const result = buildFilteredVibeMemoryForCandidateContent({
      id: "memory-1",
      sessionId: "session-1",
      content: [
        "USER: # AGENTS.md instructions for /repo",
        "",
        "<INSTRUCTIONS>",
        "このプロジェクトでの作業を開始する際、最初に一度だけ initial_instructions MCP ツールを実行してください。",
        "</INSTRUCTIONS>",
        "",
        "<environment_context><cwd>/repo</cwd></environment_context>",
        "",
        "<filesystem><workspace_roots><root>/Users/example/repo</root></workspace_roots></filesystem>",
        "",
        "ASSISTANT: 確認します。",
        "",
        "USER: findCandidate の chunk 化を廃止してください。",
        "",
        "ASSISTANT: /Users/example/repo/src/modules/findCandidate/domain.ts の bunx vitest run test/find-candidate.test.ts が失敗しました。",
      ].join("\n"),
      metadata: {
        toolCalls: [
          {
            name: "exec_command",
            command: "bunx vitest run /Users/example/repo/test/find-candidate.test.ts",
          },
          {
            name: "apply_patch",
            targetFile: "/Users/example/repo/src/modules/findCandidate/domain.ts",
            contentPreview: "*** Begin Patch\n*** Update File: src/modules/findCandidate/domain.ts",
          },
        ],
      },
      diffs: [
        {
          file_path: "/Users/example/repo/src/modules/findCandidate/domain.ts",
          diff_hunk:
            '@@ remove chunk pipeline @@\n- old chunk-specific usage source\n+ usageSource: "find-candidate"',
          change_type: "modify",
          language: "typescript",
          symbol_name: null,
          symbol_kind: null,
        },
      ],
    });

    expect(result.content).toContain("[filtered_vibe_memory]");
    expect(result.content).toContain("findCandidate の chunk 化を廃止してください");
    expect(result.content).toContain("bunx vitest run test/find-candidate.test.ts");
    expect(result.content).toContain("src/modules/findCandidate/domain.ts");
    expect(result.content).toContain("test/find-candidate.test.ts");
    expect(result.content).toContain("old chunk-specific usage source");
    expect(result.content).not.toContain("/Users/example/repo");
    expect(result.content).not.toContain("<INSTRUCTIONS>");
    expect(result.content).not.toContain("<environment_context>");
    expect(result.content).not.toContain("<filesystem>");
    expect(result.content).not.toContain("AGENTS.md instructions");
    expect(result.content).not.toContain("ASSISTANT: 確認します。");
    expect(result.stats.droppedMessages).toBeGreaterThan(0);
    expect(result.stats.includedDiffHunks).toBe(1);
  });
});
