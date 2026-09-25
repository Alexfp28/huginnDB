/**
 * @vitest-environment jsdom
 *
 * `Segmented` is a roving-tabindex radiogroup: exactly one segment sits in the
 * Tab order and the arrows move between the rest. The case these lock down is
 * the one that used to break it — a `value` no option names (a custom number
 * typed beside a row of presets), which left every segment at `tabIndex=-1`
 * and the whole strip unreachable from the keyboard.
 *
 * Plain DOM assertions rather than jest-dom matchers, as in `button.test.tsx`.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Segmented } from "./segmented";

afterEach(() => {
  cleanup();
});

const OPTIONS = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

/** Stateful harness, so arrow presses round-trip through `value`. */
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Segmented value={value} onValueChange={setValue} options={OPTIONS} aria-label="pick" />
      <output data-testid="value">{value}</output>
    </>
  );
}

const radios = () => screen.getAllByRole("radio") as HTMLButtonElement[];
const tabIndexes = () => radios().map((r) => r.tabIndex);
const current = () => screen.getByTestId("value").textContent;

describe("Segmented roving tabindex", () => {
  it("puts only the selected segment in the Tab order", () => {
    render(<Harness initial="b" />);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("gives the tab stop to the first segment when no option matches the value", () => {
    render(<Harness initial="custom" />);
    expect(tabIndexes()).toEqual([0, -1, -1]);
    // Nothing is claimed as checked just because it holds the tab stop.
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("steps from the focused segment when nothing is selected", () => {
    render(<Harness initial="custom" />);
    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(current()).toBe("b");
    expect(document.activeElement).toBe(radios()[1]);
    expect(tabIndexes()).toEqual([-1, 0, -1]);
  });

  it("moves focus with the selection and wraps at both ends", () => {
    render(<Harness initial="c" />);
    radios()[2].focus();
    fireEvent.keyDown(radios()[2], { key: "ArrowRight" });
    expect(current()).toBe("a");
    expect(document.activeElement).toBe(radios()[0]);

    fireEvent.keyDown(radios()[0], { key: "ArrowLeft" });
    expect(current()).toBe("c");
    expect(document.activeElement).toBe(radios()[2]);
  });

  it("ignores keys other than the horizontal arrows", () => {
    render(<Harness initial="a" />);
    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowDown" });
    expect(current()).toBe("a");
  });
});
