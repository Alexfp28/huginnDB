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
 *
 * The same limit applies to `disableHoverableContent`: its effect is a pointer
 * grace-area polygon between trigger and content, which needs real geometry to
 * observe. What *is* testable, and what actually regressed, is the decision —
 * that the app's wrapper sets the policy rather than leaving it to each of the
 * three window roots to remember. That is asserted against the props reaching
 * Radix, which is the narrowest thing that would have caught it.
 */

import type * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProviderProps = React.ComponentPropsWithoutRef<
  typeof import("@radix-ui/react-tooltip").Provider
>;

/** Props every `TooltipPrimitive.Provider` render was handed, in order. */
const { providerProps } = vi.hoisted(() => ({
  providerProps: [] as ProviderProps[],
}));

vi.mock("@radix-ui/react-tooltip", async () => {
  const actual = await vi.importActual<
    typeof import("@radix-ui/react-tooltip")
  >("@radix-ui/react-tooltip");
  return {
    ...actual,
    // Pass straight through — this records, it does not stub. The portal and
    // trigger tests below still exercise the real Radix implementation.
    Provider: (props: ProviderProps) => {
      providerProps.push(props);
      return <actual.Provider {...props} />;
    },
  };
});
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

beforeEach(() => {
  providerProps.length = 0;
});

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

describe("the provider carries the app's tooltip policy", () => {
  it("turns off hoverable content by default", () => {
    // Radix defaults this to `false`, which keeps a tooltip open while the
    // pointer crosses a grace area toward the content. With nothing in this app
    // rendering hoverable content, the only thing that bought was a tooltip
    // lingering over its neighbour when the pointer moved between two adjacent
    // buttons — the second opens with no delay (`skipDelayDuration`) while the
    // first is still inside its grace area.
    render(
      <TooltipProvider>
        <SimpleTooltip label="Disconnect all">
          <button>x</button>
        </SimpleTooltip>
      </TooltipProvider>,
    );
    expect(providerProps).not.toHaveLength(0);
    for (const props of providerProps) {
      expect(props.disableHoverableContent).toBe(true);
    }
  });

  it("still lets a root override it", () => {
    // A default, not a closed list: a surface that one day needs hoverable
    // content (a tooltip with a link in it) can still ask for it.
    render(
      <TooltipProvider disableHoverableContent={false}>
        <SimpleTooltip label="Disconnect all">
          <button>x</button>
        </SimpleTooltip>
      </TooltipProvider>,
    );
    expect(providerProps.at(-1)?.disableHoverableContent).toBe(false);
  });

  it("applies to SimpleTooltip's fallback provider too", () => {
    // The safety net for a tooltip rendered with no root above it must not be
    // the one place the policy is missing.
    render(
      <SimpleTooltip label="Disconnect all">
        <button>x</button>
      </SimpleTooltip>,
    );
    expect(providerProps).not.toHaveLength(0);
    expect(providerProps.at(-1)?.disableHoverableContent).toBe(true);
  });
});
