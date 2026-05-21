import { vi } from "vitest";
export const mockReactQuery = (data: any) => {
  vi.mock("@tanstack/react-query", async () => {
    const actual = await vi.importActual("@tanstack/react-query");
    return {
      ...actual,
      useQuery: vi.fn().mockReturnValue({ data, isLoading: false }),
      useMutation: vi.fn().mockReturnValue({ mutate: vi.fn() }),
    };
  });
};
