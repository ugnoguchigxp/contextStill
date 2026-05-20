import { beforeEach, describe, expect, test, vi } from "vitest";
import { executeDistillationToolCall } from "../src/modules/distillation/distillation-tools.service.js";

const mocks = vi.hoisted(() => ({
  recordAuditLogSafe: vi.fn(),
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    distillationWebSearch: "DISTILLATION_WEB_SEARCH",
    distillationFetchContent: "DISTILLATION_FETCH_CONTENT",
    distillationMcpEvidence: "DISTILLATION_MCP_EVIDENCE",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

describe("distillation MCP evidence tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "";
    process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "";
  });

  test("returns non-blocking unavailable result when context7 is not configured", async () => {
    const result = await executeDistillationToolCall({
      id: "call-1",
      type: "function",
      function: {
        name: "context7",
        arguments: '{"query":"example api docs"}',
      },
    });

    expect(result).toMatchObject({
      callId: "call-1",
      name: "context7",
      ok: false,
      metadata: { unavailable: true, server: "context7" },
    });
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "DISTILLATION_MCP_EVIDENCE",
        payload: expect.objectContaining({
          toolName: "context7",
          unavailable: true,
        }),
      }),
    );
  });
});
