/**
 * @vitest-environment jsdom
 *
 * The tooltip's content has to leave its place in the DOM, and that is the one
 * thing worth testing here — see the note on `TooltipContent`. Rendered in
 * place, an ancestor's `overflow` clips it and an ancestor's stacking context
 * lets a later sibling paint over it, which is what happened to every icon
 * button near the top of the scrolling connections panel.
 *
 * `collisionPadding` is not covered: jsdom has no layout, so nothing here can
 * observe a flip at a viewport edge. It is stated at the prop instead.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

afterEach(() => {
  cleanup();
});

describe("the tooltip escapes its container", () => {
  it("portals the content out of a clipping ancestor", () => {
    const { container } = render(
      <TooltipProvider>
        {/* The shape that used to break: a scrolling, clipping ancestor. */}
        <div className="overflow-y-auto">
          <Tooltip open>
            <TooltipTrigger>trigger</TooltipTrigger>
            <TooltipContent>Disconnect all</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>,
    );
    // Radix renders the label twice — once visibly and once in an sr-only
    // span — so this asks for the announced one and walks up from there.
    const announced = screen.getByRole("tooltip");
    expect(document.body.contains(announced)).toBe(true);
    expect(container.contains(announced)).toBe(false);
  });

  it("leaves the trigger where it was", () => {
    const { container } = render(
      <TooltipProvider>
        <div className="overflow-hidden">
          <SimpleTooltip label="Zoom out">
            <button>−</button>
          </SimpleTooltip>
        </div>
      </TooltipProvider>,
    );
    // Only the content moves: a portalled *trigger* would break every layout
    // it sits in.
    const trigger = screen.getByRole("button", { name: "−" });
    expect(container.contains(trigger)).toBe(true);
  });
});
