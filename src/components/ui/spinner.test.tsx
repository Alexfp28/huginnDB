/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

afterEach(() => {
  cleanup();
});

describe("Spinner", () => {
  it("is decoration by default, so it doesn't double up on nearby text", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });

  it("announces itself when it is the only signal", () => {
    render(<Spinner label="Loading" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-label")).toBe("Loading");
    expect(el.getAttribute("aria-hidden")).toBeNull();
  });

  it("offers the four sizes the app was already using", () => {
    for (const [size, h] of [
      ["xs", "h-3"],
      ["sm", "h-3.5"],
      ["md", "h-4"],
      ["lg", "h-5"],
    ] as const) {
      cleanup();
      const { container } = render(<Spinner size={size} />);
      expect(container.querySelector("svg")!.getAttribute("class")).toContain(
        h,
      );
    }
  });

  it("spins", () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});
