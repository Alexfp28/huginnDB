/**
 * @vitest-environment jsdom
 *
 * The first test in `components/ui/`. `Button` has 200-plus call sites, so
 * every variant added to it is a change that can break a surface nobody
 * remembers — these lock down the contract the rest of the library builds on.
 *
 * Plain DOM assertions rather than jest-dom matchers: the package isn't a
 * dependency of this repo, and the tree is kept small on purpose.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, buttonVariants } from "./button";

afterEach(() => {
  cleanup();
});

const button = () => screen.getByRole("button") as HTMLButtonElement;

describe("Button variants", () => {
  it("defaults to the brand fill at md density", () => {
    const cls = buttonVariants({});
    expect(cls).toContain("bg-brand");
    expect(cls).toContain("h-9");
  });

  it("shares the xs/sm/md density vocabulary with Input", () => {
    expect(buttonVariants({ size: "xs" })).toContain("h-7");
    expect(buttonVariants({ size: "sm" })).toContain("h-8");
    expect(buttonVariants({ size: "md" })).toContain("h-9");
  });

  it("gives every icon size a square box, which is what stops call sites picking their own padding", () => {
    for (const [size, box] of [
      ["icon", "h-8 w-8"],
      ["icon-sm", "h-7 w-7"],
      ["icon-xs", "h-6 w-6"],
    ] as const) {
      const cls = buttonVariants({ size });
      for (const token of box.split(" ")) expect(cls).toContain(token);
    }
  });

  it("quiet is ghost plus a muted resting colour — the toolbar button the app hand-rolled 65 times", () => {
    const quiet = buttonVariants({ variant: "quiet" });
    expect(quiet).toContain("text-muted-foreground");
    expect(quiet).toContain("hover:text-foreground");
  });

  it("lets the consumer's className win over the variant default", () => {
    // Asserted on the rendered element, not on `buttonVariants` — and the
    // difference is the whole point. `cva` only *concatenates*; the conflict
    // resolution comes from the `cn` (tailwind-merge) the component wraps the
    // result in, and only because `className` goes in last. A test against
    // `buttonVariants({ className })` passes a string containing BOTH classes
    // and proves nothing about what the user sees.
    render(
      <Button size="sm" className="h-6">
        Save
      </Button>,
    );
    expect(button().className).toContain("h-6");
    expect(button().className).not.toContain("h-8");
  });

  it("concatenates without merging at the cva layer, which is why the check above renders", () => {
    // Pinned deliberately: if `buttonVariants` ever grows its own merge, the
    // test above becomes redundant rather than wrong, and this one says so.
    expect(buttonVariants({ size: "sm", className: "h-6" })).toContain("h-8");
  });
});

describe("Button loading", () => {
  it("disables itself and reports aria-busy", () => {
    render(<Button loading>Save</Button>);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
  });

  it("keeps the label when no loadingLabel is given", () => {
    render(<Button loading>Save</Button>);
    expect(button().textContent).toContain("Save");
  });

  it("swaps the label when a loadingLabel is given", () => {
    render(
      <Button loading loadingLabel="Saving…">
        Save
      </Button>,
    );
    expect(button().textContent).toContain("Saving…");
    expect(button().textContent).not.toContain("Save ");
  });

  it("spins whenever it is loading, label or not", () => {
    // Deliberately unlike the hand-rolled footers this replaces, which showed
    // a spinner only when they had no busy label. A button reading "Dropping…"
    // is no less busy than one reading "Drop".
    render(
      <Button loading loadingLabel="Dropping…">
        Drop
      </Button>,
    );
    expect(button().querySelector(".animate-spin")).not.toBeNull();
  });

  it("is not busy or disabled at rest", () => {
    render(<Button>Save</Button>);
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-busy")).toBeNull();
    expect(button().querySelector(".animate-spin")).toBeNull();
  });

  it("still honours an explicit disabled while not loading", () => {
    render(<Button disabled>Save</Button>);
    expect(button().disabled).toBe(true);
  });
});

describe("Button asChild", () => {
  it("renders the child element instead of a button, carrying the classes", () => {
    render(
      <Button asChild variant="link">
        <a href="/docs">Docs</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link.className).toContain("text-brand");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
