/**
 * @vitest-environment jsdom
 *
 * The drop dialog names what references the table before the user confirms.
 *
 * The point of the lookup is the case the server's own error gets wrong —
 * MariaDB's 1451 names no table — so what is pinned here is that the children
 * are listed, that a cross-schema child carries its schema, and that a failed
 * lookup stays out of the way rather than blocking a drop the server may well
 * accept.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { DropObjectDialog } from "./DropObjectDialog";
import type { IncomingForeignKey, TableInfo } from "@/types";

const listReferencingForeignKeys = vi.fn<
  (c: string, s: string | undefined, t: string) => Promise<IncomingForeignKey[]>
>();

vi.mock("@/lib/tauri", () => ({
  api: {
    listReferencingForeignKeys: (c: string, s: string | undefined, t: string) =>
      listReferencingForeignKeys(c, s, t),
    updatePreferences: () => Promise.resolve(),
  },
}));

const target: TableInfo = { schema: "shop", name: "orders", kind: "table" };

function mount(kind: "table" | "view" = "table") {
  render(
    <StrictMode>
      <DropObjectDialog
        connectionId="c1"
        target={target}
        kind={kind}
        onClose={() => {}}
        onDone={() => {}}
      />
    </StrictMode>,
  );
}

afterEach(() => {
  cleanup();
  listReferencingForeignKeys.mockReset();
});

describe("DropObjectDialog", () => {
  it("lists every referencing table, with the schema only when it differs", async () => {
    listReferencingForeignKeys.mockResolvedValue([
      {
        schema: "shop",
        table: "lines",
        constraint: "fk_lines_order",
        columns: ["order_id", "order_rev"],
      },
      {
        schema: "billing",
        table: "invoices",
        constraint: "fk_inv_order",
        columns: ["order_id"],
      },
    ]);
    mount();

    expect(
      await screen.findByText("lines (order_id, order_rev) → fk_lines_order"),
    ).toBeTruthy();
    expect(
      screen.getByText("billing.invoices (order_id) → fk_inv_order"),
    ).toBeTruthy();
    expect(screen.getByText("Referenced by 2 foreign keys")).toBeTruthy();
    expect(listReferencingForeignKeys).toHaveBeenCalledWith(
      "c1",
      "shop",
      "orders",
    );
  });

  it("shows no warning when nothing references the table", async () => {
    listReferencingForeignKeys.mockResolvedValue([]);
    mount();
    // Wait for the lookup to settle: the "checking" line goes away.
    await vi.waitFor(() =>
      expect(screen.queryByText(/Checking which tables/)).toBeNull(),
    );
    expect(screen.queryByText(/Referenced by/)).toBeNull();
  });

  it("stays out of the way when the lookup fails", async () => {
    listReferencingForeignKeys.mockRejectedValue(new Error("no privilege"));
    mount();
    await vi.waitFor(() =>
      expect(screen.queryByText(/Checking which tables/)).toBeNull(),
    );
    expect(screen.queryByText(/Referenced by/)).toBeNull();
    expect(screen.queryByText(/no privilege/)).toBeNull();
  });

  it("does not look anything up for a view", () => {
    mount("view");
    expect(listReferencingForeignKeys).not.toHaveBeenCalled();
    expect(screen.queryByText(/Checking which tables/)).toBeNull();
  });
});
