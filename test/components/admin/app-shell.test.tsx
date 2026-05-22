/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
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
    const labels = screen.getByLabelText("main navigation").textContent ?? "";
    expect(labels.indexOf("Graph")).toBeLessThan(labels.indexOf("Compile"));
    expect(labels.indexOf("Compile")).toBeLessThan(labels.indexOf("Audit"));
  });
});
