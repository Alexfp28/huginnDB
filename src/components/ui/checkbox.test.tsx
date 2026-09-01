/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

afterEach(() => {
  cleanup();
});

const box = () => screen.getByRole("checkbox") as HTMLInputElement;

describe("Checkbox", () => {
  it("renders a bare input when there is no label, so it can be nested", () => {
    const { container } = render(<Checkbox />);
    // No wrapper: several call sites put this inside a label or a table cell
    // they already own, and one relies on that nesting for its clickable row.
    expect(container.firstElementChild?.tagName).toBe("INPUT");
  });

  it("wraps itself in a label when given one", () => {
    render(<Checkbox label="Include secrets" />);
    expect(screen.getByLabelText("Include secrets")).not.toBeNull();
  });

  it("applies the mixed state, which the DOM has no attribute for", () => {
    // This is why four call sites each hand-rolled a ref before.
    render(<Checkbox indeterminate />);
    expect(box().indeterminate).toBe(true);
  });

  it("clears the mixed state when it goes away", () => {
    const { rerender } = render(<Checkbox indeterminate />);
    rerender(<Checkbox indeterminate={false} />);
    expect(box().indeterminate).toBe(false);
  });

  it("spends the brand token, never primary", () => {
    // `--primary` is near-black in light themes; `--brand` is the app's one
    // action colour. Twelve checkboxes used to get this wrong.
    render(<Checkbox />);
    expect(box().className).toContain("accent-brand");
    expect(box().className).not.toContain("accent-primary");
  });

  it("has two densities and lets a call site override either", () => {
    render(<Checkbox />);
    expect(box().className).toContain("h-3.5");
    cleanup();
    render(<Checkbox size="xs" />);
    expect(box().className).toContain("h-3");
  });

  it("forwards a ref to the input alongside the mixed state", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<Checkbox ref={ref} indeterminate />);
    expect(ref.current?.tagName).toBe("INPUT");
    expect(ref.current?.indeterminate).toBe(true);
  });
});
