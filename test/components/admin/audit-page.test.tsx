/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { AuditLogsPage } from "../../../web/src/modules/admin/components/audit.page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
        total: 1,
        page: 1,
        limit: 50,
        totalPages: 1,
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
    expect(screen.getByText("test_event")).toBeInTheDocument();
  });
});
