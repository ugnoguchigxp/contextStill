/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { AppShell } from "../../../web/src/modules/admin/components/app-shell";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: any) => <a href="/">{children}</a>,
  useRouterState: vi.fn().mockReturnValue("/test"),
  Outlet: () => <div>outlet-content</div>,
}));

describe("AppShell", () => {
  it("renders with navigation", () => {
    render(<AppShell />);
    expect(screen.getByText("outlet-content")).toBeInTheDocument();
  });
});
