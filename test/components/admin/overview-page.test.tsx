/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { OverviewPage } from "../../../web/src/modules/admin/components/overview.page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn().mockImplementation((options) => {
      if (options.queryKey?.includes("doctor")) {
        return {
          data: {
            db: { reachable: true },
            storage: { writable: true },
            llm: { available: true },
            vector: { installed: true },
            mcp: { nextActions: [] },
            reasons: [],
          },
          isLoading: false,
        };
      }
      return {
        data: {
          kpis: {
            compileRuns: 0,
            compileDegradedRuns: 0,
            activeKnowledge: 0,
            totalSources: 0,
            zeroUseActiveKnowledge: 0,
          },
          charts: { distillationQueue: [], knowledgeByStatusType: [] },
        },
        isLoading: false,
      };
    }),
  };
});
const queryClient = new QueryClient();
describe("OverviewPage", () => {
  it("renders correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/overview/i)).toBeInTheDocument();
  });
});
