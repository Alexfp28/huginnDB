/**
 * @vitest-environment jsdom
 *
 * The query panel's contract with `serverFilters`: it seeds from them, applies
 * back exactly what it shows, follows them while its draft says the same and
 * keeps an edited draft when they move underneath it. The last two are the
 * rule its module header states, and the easiest part to break silently.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const describeTableQuery = vi.fn();
const explainTableQuery = vi.fn();
const openQueryTab = vi.fn();
vi.mock("@/lib/tauri", () => ({
  api: {
    describeTableQuery: (q: unknown) => describeTableQuery(q),
    explainTableQuery: (q: unknown) => explainTableQuery(q),
  },
}));
vi.mock("@/lib/tabs/openQueryTab", () => ({
  openQueryTab: (id: string, opts: unknown) => openQueryTab(id, opts),
}));

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
      raw: "",
      collation: "",
      hint: "",
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
      raw: "",
      collation: "",
      hint: "",
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
      raw: "",
      collation: "",
      hint: "",
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
      raw: "",
      collation: "",
      hint: "",
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
    expect(onApply).toHaveBeenCalledWith({
      filters: [],
      projection: undefined,
      raw: "",
      collation: "",
      hint: "",
    });
  });
});

describe("QueryPanel expression and result", () => {
  const base = {
    connectionId: "c1",
    table: "device",
    limit: 100,
    offset: 0,
  };

  it("applies a hand-written expression alongside the conditions", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "SQL expression" }));
    fireEvent.change(screen.getByLabelText("Expression"), {
      target: { value: "qty > 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledWith({
      filters: byCode,
      projection: undefined,
      raw: "qty > 3",
      collation: "",
      hint: "",
    });
  });

  it("shows the statement the draft would run, and opens it in an editor", async () => {
    describeTableQuery.mockResolvedValue({
      text: "SELECT * FROM device WHERE (\nqty > 3\n) LIMIT 100 OFFSET 0",
      language: "sql",
    });
    render(
      <QueryPanel
        columns={columns}
        applied={[]}
        appliedRaw="qty > 3"
        preview={base}
        focus={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/SELECT \* FROM device/)).toBeTruthy(),
    );
    // The draft, not just the base, is what was described.
    expect(describeTableQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ table: "device", raw: "qty > 3" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(openQueryTab).toHaveBeenCalledWith("c1", {
      sql: expect.stringContaining("SELECT * FROM device"),
    });
  });

  it("blocks Apply while the draft does not describe", async () => {
    describeTableQuery.mockRejectedValue("expression: a ; would end the statement");
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={columns}
        applied={[]}
        appliedRaw="1 = 1; DROP TABLE t"
        preview={base}
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("QueryPanel regressions from review", () => {
  it("does not claim unapplied changes after an edit is undone", () => {
    render(
      <QueryPanel
        columns={columns}
        applied={byCode}
        focus={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Choose" }));
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "SQL expression" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove the expression" }),
    );
    expect(screen.queryByText("Unapplied changes")).toBeNull();

    // A real change still says so.
    fireEvent.change(valueInputs()[0], { target: { value: "IMPCR02" } });
    expect(screen.getByText("Unapplied changes")).toBeTruthy();
  });

  it("shows the statement on one line until it is expanded", async () => {
    describeTableQuery.mockResolvedValue({
      text: "db.device.find({\n  user: \"itbacking\"\n}).limit(100)",
      language: "mongodb",
    });
    render(
      <QueryPanel
        columns={columns}
        applied={[]}
        document
        preview={{ connectionId: "c1", table: "device", limit: 100, offset: 0 }}
        focus={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    const collapsed = await screen.findByText(
      'db.device.find({ user: "itbacking" }).limit(100)',
    );
    expect(collapsed.tagName).toBe("CODE");

    fireEvent.click(
      screen.getByRole("button", { name: "Show the whole statement" }),
    );
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("\n  user:");
  });
});

describe("QueryPanel advanced options", () => {
  it("applies a collation and an index hint with everything else", () => {
    const onApply = vi.fn();
    render(
      <QueryPanel
        columns={columns}
        applied={byCode}
        driver="sqlite"
        indexNames={["idx_code", "idx_user"]}
        focus={null}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    // Folded until asked for.
    expect(screen.queryByText("Collation")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Collation and index hint — none set",
      }),
    );
    fireEvent.change(screen.getByLabelText("Collation"), {
      target: { value: "NOCASE" },
    });
    fireEvent.change(screen.getByLabelText("Index (hint)"), {
      target: { value: "idx_code" },
    });
    expect(screen.getByText("Unapplied changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(onApply).toHaveBeenCalledWith({
      filters: byCode,
      projection: undefined,
      raw: "",
      collation: "NOCASE",
      hint: "idx_code",
    });
  });

  it("offers no hint on PostgreSQL, and says why", () => {
    render(
      <QueryPanel
        columns={columns}
        applied={[]}
        driver="postgres"
        indexNames={["idx_code"]}
        appliedCollation="es-ES-x-icu"
        focus={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    // Opened already: a collation is set.
    const hint = screen.getByLabelText("Index (hint)") as HTMLSelectElement;
    expect(hint.disabled).toBe(true);
    expect(
      screen.getByText(
        "PostgreSQL has no index hints; its planner chooses on its own.",
      ),
    ).toBeTruthy();
  });
});

describe("QueryPanel explain", () => {
  const base = { connectionId: "c1", table: "device", limit: 100, offset: 0 };

  it("reads the plan of the draft and drops it once the draft moves on", async () => {
    describeTableQuery.mockResolvedValue({
      text: "SELECT * FROM device LIMIT 100 OFFSET 0",
      language: "sql",
    });
    explainTableQuery.mockResolvedValue({ raw: { query_block: { cost: 1 } } });
    render(
      <QueryPanel
        columns={columns}
        applied={byCode}
        preview={base}
        focus={null}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByText(/SELECT \* FROM device/);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Explain — the plan this query would use, without running it",
      }),
    );
    expect(explainTableQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ table: "device", filters: byCode }),
    );
    await screen.findByText(/query_block/);
    expect(screen.getByText("Execution plan")).toBeTruthy();

    // A different draft is a different query: its plan is not this one.
    fireEvent.change(valueInputs()[0], { target: { value: "IMPCR02" } });
    expect(screen.queryByText("Execution plan")).toBeNull();
  });
});
