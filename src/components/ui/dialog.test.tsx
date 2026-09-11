/**
 * @vitest-environment jsdom
 *
 * Two things worth locking down about the tier system, per the ADR's own
 * reasoning for why this file exists at all:
 *
 * 1. A consumer's `className` must beat the tier's own default in
 *    *rendered* output. `cva` alone does not merge — it just concatenates —
 *    so a test against the string `dialogContentVariants({...})` returns
 *    would prove nothing about which class wins once `cn` (tailwind-merge)
 *    resolves the conflict. Only the DOM's final `class` attribute answers
 *    that.
 * 2. The context wiring: `DialogHeader`/`DialogFooter` read `DialogTier`
 *    from `DialogContent`, not from a prop of their own, so the only way to
 *    prove the plumbing works is to render two tiers and check each rail
 *    shows up where it should and nowhere else.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

afterEach(() => {
  cleanup();
});

describe("DialogContent", () => {
  it("lets a consumer className beat the tier default in rendered output", () => {
    render(
      <Dialog open>
        <DialogContent className="max-w-5xl" aria-label="test dialog">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const el = screen.getByLabelText("test dialog");
    expect(el.className).toContain("max-w-5xl");
    // `padded`'s own `max-w-md` must have lost, not merely been joined —
    // both present would mean tailwind-merge did not run.
    expect(el.className).not.toContain("max-w-md");
  });

  it("gives the close button an accessible name", () => {
    render(
      <Dialog open>
        <DialogContent aria-label="test dialog">
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});

describe("DialogTierContext wiring", () => {
  it("panel's header carries the rail; prompt's does not", () => {
    const { unmount } = render(
      <Dialog open>
        <DialogContent tier="panel" aria-label="panel dialog">
          <DialogHeader data-testid="header">
            <DialogTitle>Title</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("header").className).toContain("border-b");
    unmount();

    render(
      <Dialog open>
        <DialogContent tier="prompt" aria-label="prompt dialog">
          <DialogHeader data-testid="header">
            <DialogTitle>Title</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("header").className).not.toContain("border-b");
  });

  it("panel's footer carries the border-t rail; prompt's does not", () => {
    const { unmount } = render(
      <Dialog open>
        <DialogContent tier="panel" aria-label="panel dialog">
          <DialogTitle>Title</DialogTitle>
          <DialogFooter data-testid="footer" />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("footer").className).toContain("border-t");
    unmount();

    render(
      <Dialog open>
        <DialogContent tier="prompt" aria-label="prompt dialog">
          <DialogTitle>Title</DialogTitle>
          <DialogFooter data-testid="footer" />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("footer").className).not.toContain("border-t");
  });

  it("padded (the default) keeps today's header/footer classes, unchanged", () => {
    render(
      <Dialog open>
        <DialogContent aria-label="padded dialog">
          <DialogHeader data-testid="header">
            <DialogTitle>Title</DialogTitle>
          </DialogHeader>
          <DialogFooter data-testid="footer" />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("header").className).toBe(
      "flex text-left flex-col space-y-1.5",
    );
    expect(screen.getByTestId("footer").className).toBe(
      "flex flex-wrap justify-end gap-2",
    );
  });
});
