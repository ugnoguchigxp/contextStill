import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextCompilerPage } from "../../../web/src/modules/context-compiler/components/context-compiler.page";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({ data: [], isLoading: false }),
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn() }),
  };
});
const queryClient = new QueryClient();
describe("ContextCompilerPage", () => {
  it("renders correctly", () => {
    // データが空配列であることを前提にレンダリング
    render(
      <QueryClientProvider client={queryClient}>
        <ContextCompilerPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/compiler/i)).toBeInTheDocument();
  });
});
