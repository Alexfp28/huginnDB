/**
 * @vitest-environment jsdom
 *
 * The field picker's load-bearing behaviours — each one something the closed
 * `Select` it replaces got for free, and each one a way this control could stop
 * being usable inside a dialog without any test noticing.
 */
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { FilterFieldPicker } from "./FilterFieldPicker";
import type { FilterField } from "@/lib/grid/fieldPaths";

// jsdom implements no scrolling at all, and the panel keeps the highlighted
// option in view. Stubbed here rather than guarded in the component: the app
// runs in a real engine, where `scrollIntoView?.()` would be dead defence.
Element.prototype.scrollIntoView = vi.fn();

// `globals` is off in `vitest.config.ts`, so testing-library's auto-cleanup
// never registers — without this every render piles up in the same document.
afterEach(cleanup);

const FIELDS: FilterField[] = [
  { path: "_id", type: "objectId", nested: false },
  { path: "customData", type: "document", nested: false },
  { path: "customData.format", type: "string", nested: true },
  { path: "customData.size", type: "int", nested: true },
];

function Harness({
  onKeyDown,
  initial = "",
}: {
  onKeyDown?: (e: React.KeyboardEvent) => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    // The outer handler stands in for the dialog around the picker: it is what
    // Escape reaches whenever the picker does not stop it.
    <div onKeyDown={onKeyDown}>
      <FilterFieldPicker fields={FIELDS} value={value} onChange={setValue} />
      <span data-testid="value">{value}</span>
    </div>
  );
}

const input = () => screen.getByRole("combobox");
const optionCount = () => screen.queryAllByRole("option").length;
const committed = () => screen.getByTestId("value").textContent;

describe("FilterFieldPicker", () => {
  it("offers nested paths, not only the top-level fields", () => {
    render(<Harness />);
    expect(optionCount()).toBe(0);
    fireEvent.click(input());
    // Path then type: the sampled BSON type rides along, so a path is picked
    // knowing what it holds — the same thing the `Select` showed for a column.
    // A nested path is split across spans to grey out its parent, hence the
    // whole-row text rather than a per-node query.
    expect(screen.queryAllByRole("option").map((o) => o.textContent)).toEqual([
      "_idobjectId",
      "customDatadocument",
      "customData.formatstring",
      "customData.sizeint",
    ]);
  });

  it("filters by what was typed and commits the picked path", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "format" } });
    expect(optionCount()).toBe(1);
    fireEvent.click(screen.getByRole("option"));
    expect(committed()).toBe("customData.format");
    // Picking closes the panel; the value is not still being filtered on.
    expect(optionCount()).toBe(0);
  });

  it("lists everything again when a row already names a field", () => {
    // Filtering by the value it arrived with would offer this row's own field
    // and nothing else, which reads as a broken picker rather than a full one.
    render(<Harness initial="customData.format" />);
    fireEvent.click(input());
    expect(optionCount()).toBe(FIELDS.length);
  });

  it("keeps a typed path that matches no known field", () => {
    // The paths are a sample of the loaded page, so a field only older
    // documents carry has to stay reachable by hand.
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "meta.audit.by" } });
    expect(committed()).toBe("meta.audit.by");
    expect(optionCount()).toBe(0);
    expect(screen.getByText(/no field matches/i)).toBeTruthy();
  });

  it("picks with the keyboard", () => {
    render(<Harness />);
    fireEvent.click(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(committed()).toBe("customData");
  });

  it("keeps Escape away from the dialog while the panel is open", () => {
    // Otherwise dismissing a suggestion list closes the whole filter dialog
    // and throws away every condition the user has built.
    const onKeyDown = vi.fn();
    render(<Harness onKeyDown={onKeyDown} />);
    fireEvent.click(input());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(optionCount()).toBe(0);

    // Closed, Escape belongs to the dialog again.
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
