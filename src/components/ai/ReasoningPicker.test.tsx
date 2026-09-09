/**
 * @vitest-environment jsdom
 *
 * The picker's behaviour, not its looks.
 *
 * Two things here are easy to get wrong and invisible when they are: the map
 * from a slider position to an effort level, and what happens either side of
 * the `auto` switch. Turning `auto` off has to return to the level the user
 * last chose — falling back to a hard-coded default there would quietly
 * discard a deliberate choice, and it is exactly the kind of thing that reads
 * as "the setting doesn't stick".
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { ReasoningPicker } from "./ReasoningPicker";
import type { AiReasoningEffort } from "@/types";

afterEach(cleanup);

/**
 * Radix opens its menu on `pointerdown`, not on `click` — and jsdom implements
 * no `PointerEvent`, so the event is synthesised from a `MouseEvent` with the
 * one property Radix reads (`button: 0`, i.e. the primary button).
 */
function open() {
  const trigger = screen.getByRole("button");
  fireEvent(
    trigger,
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  );
  fireEvent.click(trigger);
}

function slider(): HTMLInputElement {
  return screen.getByRole("slider") as HTMLInputElement;
}

describe("ReasoningPicker", () => {
  it("shows the current level on the trigger without being opened", () => {
    render(<ReasoningPicker value="high" onChange={() => {}} />);
    expect(screen.getByRole("button").textContent).toMatch(/high/i);
  });

  it("maps each slider position onto its effort level", () => {
    const onChange = vi.fn<(v: AiReasoningEffort) => void>();
    // Started from the middle so every position below is a real *change*: a
    // controlled input set to the value it already holds fires nothing, which
    // is why the resting stop is covered by the value-text test instead.
    render(<ReasoningPicker value="medium" onChange={onChange} />);
    open();

    const positions: Array<[string, AiReasoningEffort]> = [
      ["0", "none"],
      ["1", "low"],
      ["3", "high"],
      ["4", "max"],
    ];
    for (const [position, level] of positions) {
      fireEvent.change(slider(), { target: { value: position } });
      expect(onChange).toHaveBeenLastCalledWith(level);
    }
  });

  it("announces the level as the slider's value text", () => {
    render(<ReasoningPicker value="medium" onChange={() => {}} />);
    open();
    expect(slider().value).toBe("2");
    expect(slider().getAttribute("aria-valuetext")).toMatch(/medium/i);
  });

  /** `auto` means "send no field at all", so there is nothing on the track to
   *  drag while it is on. */
  it("disables the track under automatic", () => {
    render(<ReasoningPicker value="auto" onChange={() => {}} />);
    open();
    expect(slider().disabled).toBe(true);
  });

  it("returns to the level last chosen when automatic is turned off", () => {
    const onChange = vi.fn<(v: AiReasoningEffort) => void>();
    const { rerender } = render(
      <ReasoningPicker value="none" onChange={onChange} />,
    );
    open();

    // The user picks `low`, then flips to automatic…
    fireEvent.change(slider(), { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith("low");
    rerender(<ReasoningPicker value="low" onChange={onChange} />);

    const auto = screen.getByRole("switch");
    fireEvent.click(auto);
    expect(onChange).toHaveBeenLastCalledWith("auto");
    rerender(<ReasoningPicker value="auto" onChange={onChange} />);

    // …and back off again, which must land on `low` rather than a default.
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith("low");
  });
});
