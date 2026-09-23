/**
 * @vitest-environment jsdom
 *
 * The query panel's contract with `serverFilters`: it seeds from them, applies
 * back exactly what it shows, follows them while its draft is untouched and
 * keeps a touched draft when they move underneath it. The last two are the
 * rule its module header states, and the easiest part to break silently.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { QueryPanel } from "./QueryPanel";
import type { ColumnFilter, ColumnInfo } from "@/types";

const columns: ColumnInfo[] = [
  { name: "code", data_type: "text", nullable: false, is_primary_key: false },
  { name: "user", data_type: "text", nullable: true, is_primary_key: false },
];
const byCode: ColumnFilter[] = [{ column: "code", op: "eq", value: "IMPCR01" }];

beforeAll(() => {
  // jsdom has no layout, and the panel scrolls a chip's row into view.
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => cleanup());

function valueInputs() {
  return screen.getAllByPlaceholderText("Value") as HTMLInputElement[];
}

describe("QueryPanel", () => {
  it("seeds a row per applied filter and applies it back unchanged", () => {
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={columns}
        applied={byCode}
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    expect(valueInputs().map((i) => i.value)).toEqual(["IMPCR01"]);
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledWith(byCode);
  });

  it("applies on Ctrl+Enter from inside the panel", () => {
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={columns}
        applied={byCode}
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.change(valueInputs()[0], { target: { value: "IMPCR02" } });
    fireEvent.keyDown(valueInputs()[0], { key: "Enter", ctrlKey: true });
    expect(onApply).toHaveBeenCalledWith([
      { column: "code", op: "eq", value: "IMPCR02" },
    ]);
  });

  it("follows the applied filters while the draft is untouched", () => {
    const props = {
      columns,
      focus: null,
      onApply: () => {},
      onClose: () => {},
    };
    const { rerender } = render(<QueryPanel {...props} applied={byCode} />);
    // A chip removed from the toolbar while the panel is open.
    rerender(<QueryPanel {...props} applied={[]} />);
    expect(screen.queryAllByPlaceholderText("Value")).toHaveLength(0);
    expect(screen.queryByText("Unapplied changes")).toBeNull();
  });

  it("keeps a touched draft when the applied filters move, and says so", () => {
    const props = {
      columns,
      focus: null,
      onApply: () => {},
      onClose: () => {},
    };
    const { rerender } = render(<QueryPanel {...props} applied={byCode} />);
    fireEvent.change(valueInputs()[0], { target: { value: "IMPCR02" } });
    rerender(<QueryPanel {...props} applied={[]} />);
    expect(valueInputs().map((i) => i.value)).toEqual(["IMPCR02"]);
    expect(screen.getByText("Unapplied changes")).toBeTruthy();

    // Reset is the way back to what is actually in force.
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryAllByPlaceholderText("Value")).toHaveLength(0);
    expect(screen.queryByText("Unapplied changes")).toBeNull();
  });

  it("focuses the row seeded from the chip the user clicked", () => {
    const two: ColumnFilter[] = [
      ...byCode,
      { column: "user", op: "eq", value: "pi" },
    ];
    render(
      <QueryPanel
        columns={columns}
        applied={two}
        focus={{ index: 1, epoch: 1 }}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    const second = valueInputs()[1];
    expect(second.closest(".ring-2")).toBeTruthy();
    expect(valueInputs()[0].closest(".ring-2")).toBeNull();
  });
});
