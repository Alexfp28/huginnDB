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
    expect(onApply).toHaveBeenCalledWith({
      filters: byCode,
      projection: undefined,
    });
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
    expect(onApply).toHaveBeenCalledWith({
      filters: [{ column: "code", op: "eq", value: "IMPCR02" }],
      projection: undefined,
    });
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

describe("QueryPanel projection", () => {
  const withPk: ColumnInfo[] = [
    { name: "id", data_type: "int8", nullable: false, is_primary_key: true },
    ...columns,
  ];

  function pick(label: string, option: string) {
    fireEvent.keyDown(screen.getByRole("button", { name: label }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: option }));
  }

  it("shows the primary key locked and never offers it", () => {
    render(
      <QueryPanel
        columns={withPk}
        applied={[]}
        appliedProjection={{ fields: ["code"] }}
        keyColumns={["id"]}
        focus={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("id")).toBeTruthy();
    // Locked: no remove button for it, one for the picked column.
    expect(screen.queryByRole("button", { name: "Remove id" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove code" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: "Column" }), {
      key: "Enter",
    });
    const offered = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(offered).toEqual(["user"]);
  });

  it("applies the picked columns together with the conditions", () => {
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={withPk}
        applied={byCode}
        keyColumns={["id"]}
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Choose" }));
    pick("Column", "user");
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledWith({
      filters: byCode,
      projection: { fields: ["user"], exclude: false },
    });
  });

  it("excludes on MongoDB, and never offers _id for it", () => {
    const docs: ColumnInfo[] = [
      { name: "_id", data_type: "objectId", nullable: false, is_primary_key: true },
      { name: "configuration", data_type: "string", nullable: true, is_primary_key: false },
    ];
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={docs}
        applied={[]}
        document
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Exclude" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Field" }), {
      key: "Enter",
    });
    const offered = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(offered).toEqual(["configuration"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "configuration" }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledWith({
      filters: [],
      projection: { fields: ["configuration"], exclude: true },
    });
  });

  it("returns every field when a mode is chosen but nothing picked", () => {
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={withPk}
        applied={[]}
        keyColumns={["id"]}
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Choose" }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledWith({ filters: [], projection: undefined });
  });
});
