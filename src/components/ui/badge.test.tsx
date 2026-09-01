/**
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Badge, badgeVariants } from "./badge";

afterEach(() => {
  cleanup();
});

describe("Badge", () => {
  it("names tones by meaning, so no call site has to pick a hue", () => {
    for (const tone of [
      "neutral",
      "brand",
      "success",
      "warning",
      "destructive",
      "outline",
    ] as const) {
      expect(badgeVariants({ tone })).toContain("border");
    }
    expect(badgeVariants({ tone: "destructive" })).toContain(
      "text-destructive",
    );
    expect(badgeVariants({ tone: "brand" })).toContain("text-brand");
  });

  it("renders a span by default and its child as content", () => {
    render(<Badge>unique</Badge>);
    expect(screen.getByText("unique").tagName).toBe("SPAN");
  });

  it("hands off to a child element with asChild, for the badges that click", () => {
    render(
      <Badge asChild tone="brand">
        <button>filter</button>
      </Badge>,
    );
    const el = screen.getByRole("button", { name: "filter" });
    expect(el.className).toContain("text-brand");
  });

  it("lets the consumer override a tone's colour", () => {
    render(<Badge className="text-foreground">x</Badge>);
    expect(screen.getByText("x").className).not.toContain(
      "text-muted-foreground",
    );
  });
});
