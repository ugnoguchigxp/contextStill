/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { AdminModalShell } from "../../../web/src/modules/admin/components/admin-modal-shell";

describe("AdminModalShell", () => {
  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <AdminModalShell isOpen onClose={onClose} title="Test Modal" ariaLabel="Test Modal">
        <div>Body</div>
      </AdminModalShell>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked if closeOnBackdrop is true", () => {
    const onClose = vi.fn();
    render(
      <AdminModalShell
        isOpen
        onClose={onClose}
        title="Test Modal"
        ariaLabel="Test Modal"
        closeOnBackdrop
      >
        <div>Body</div>
      </AdminModalShell>,
    );

    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
