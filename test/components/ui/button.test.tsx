/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Button } from "../../../web/src/components/ui/button";

describe("Button component", () => {
  it("renders with children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText("Click me")).toBeInTheDocument();
  });

  it("handles click interaction", async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    // click イベントの発火方法を修正
    const button = screen.getByText("Click me");
    button.click();
    expect(handleClick).toHaveBeenCalled();
  });
});
