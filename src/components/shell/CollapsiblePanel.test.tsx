/**
 * @vitest-environment jsdom
 *
 * `CollapsiblePanel` unmounts its children once the closing width/height
 * transition finishes, not the instant `open` flips — dropping them earlier
 * would pop the content out from under the still-animating wrapper. This
 * covers the four states the behavior change has to get right: mounted
 * while open, mounted mid-close (still animating), unmounted once the close
 * transition ends, and remounted immediately on reopen — plus the
 * `keepMounted` escape hatch some call sites need (see `AppShell.tsx`'s
 * `SavedSidePanel` and `IslandShell.tsx`'s side-editor slot).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CollapsiblePanel } from "./CollapsiblePanel";

afterEach(() => {
  cleanup();
});

/** The outer, transitioning wrapper — the only element whose own
 *  `transitionend` should ever unmount the children. */
function wrapperOf(el: HTMLElement): HTMLElement {
  return el.parentElement!.parentElement as HTMLElement;
}

describe("CollapsiblePanel", () => {
  it("renders children while open", () => {
    render(
      <CollapsiblePanel open size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("keeps children mounted through the closing transition", () => {
    const { rerender } = render(
      <CollapsiblePanel open size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    rerender(
      <CollapsiblePanel open={false} size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    // The wrapper is still easing from 200 to 0 — children must still be
    // present, or they'd visibly pop out before the animation finishes.
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("unmounts children once the close transition ends", () => {
    const { rerender } = render(
      <CollapsiblePanel open size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    const wrapper = wrapperOf(screen.getByText("content"));
    rerender(
      <CollapsiblePanel open={false} size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    fireEvent.transitionEnd(wrapper);
    expect(screen.queryByText("content")).toBeNull();
  });

  it("ignores a transitionend bubbling up from inside the children", () => {
    const { rerender } = render(
      <CollapsiblePanel open size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    const inner = screen.getByText("content");
    rerender(
      <CollapsiblePanel open={false} size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    fireEvent.transitionEnd(inner);
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("remounts children immediately on reopen", () => {
    const { rerender } = render(
      <CollapsiblePanel open size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    const wrapper = wrapperOf(screen.getByText("content"));
    rerender(
      <CollapsiblePanel open={false} size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    fireEvent.transitionEnd(wrapper);
    expect(screen.queryByText("content")).toBeNull();

    rerender(
      <CollapsiblePanel open size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("never unmounts children when keepMounted is set", () => {
    const { rerender } = render(
      <CollapsiblePanel open size={200} axis="width" keepMounted>
        <div>content</div>
      </CollapsiblePanel>,
    );
    const wrapper = wrapperOf(screen.getByText("content"));
    rerender(
      <CollapsiblePanel open={false} size={200} axis="width" keepMounted>
        <div>content</div>
      </CollapsiblePanel>,
    );
    fireEvent.transitionEnd(wrapper);
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("starts unmounted when initially closed", () => {
    render(
      <CollapsiblePanel open={false} size={200} axis="width">
        <div>content</div>
      </CollapsiblePanel>,
    );
    expect(screen.queryByText("content")).toBeNull();
  });
});
