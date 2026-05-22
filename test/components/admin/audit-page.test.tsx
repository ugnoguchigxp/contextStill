import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { AuditLogsPage } from "../../../web/src/modules/admin/components/audit.page";

// useQuery を直接モック
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({
      data: {
        items: [
          {
            id: "1",
            eventType: "test_event",
            actor: "system",
            createdAt: new Date().toISOString(),
            payload: {},
          },
        ],
        availableEventTypes: ["test_event"],
        pagination: {
          page: 1,
          limit: 100,
          total: 1,
          totalPages: 1,
          hasNextPage: false,
        },
      },
      isLoading: false,
      error: null,
    }),
  };
});

const queryClient = new QueryClient();

describe("AuditLogsPage", () => {
  it("renders the audit log table with mocked data", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AuditLogsPage />
      </QueryClientProvider>,
    );
    // モックデータが表示されていることを確認
    expect(screen.getAllByText("test_event").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Audit Events")).toBeInTheDocument();
    expect(screen.getByText("Previous")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText(/Showing/)).toBeInTheDocument();
  });
});
