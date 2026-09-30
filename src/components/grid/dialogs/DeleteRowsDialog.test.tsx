/**
 * @vitest-environment jsdom
 *
 * A delete the server refuses says why inside the dialog that asked for it.
 *
 * The failure used to land in the tab's banner behind the dialog's scrim, so a
 * row still referenced by another table looked like a click that did nothing.
 * Pinned here: the dialog stays open, a foreign-key refusal gets its own
 * sentence plus the referencing tables, any other failure gets the generic
 * one, and the button is usable again for a retry.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { DeleteRowsDialog } from "./DeleteRowsDialog";
import type { IncomingForeignKey } from "@/types";

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

function mount(onDelete: () => Promise<void>, onClose = () => {}) {
  render(
    <DeleteRowsDialog
      connectionId="c1"
      schema="shop"
      table="customers"
      pkColumns={["id"]}
      pkValueRows={[[7]]}
      onDelete={onDelete}
      onClose={onClose}
    />,
  );
}

afterEach(() => {
  cleanup();
  listReferencingForeignKeys.mockReset();
});

describe("DeleteRowsDialog", () => {
  it("explains a foreign-key refusal in place and names the referencing tables", async () => {
    listReferencingForeignKeys.mockResolvedValue([
      {
        schema: "shop",
        table: "orders",
        constraint: "fk_orders_customer",
        columns: ["customer_id"],
      },
    ]);
    const onDelete = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(
        'database error: error returned from database: update or delete on table "customers" violates foreign key constraint "fk_orders_customer" on table "orders"',
      );
    mount(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/still referenced by other tables/)).toBeTruthy();
    expect(
      await screen.findByText("orders (customer_id) → fk_orders_customer"),
    ).toBeTruthy();
    expect(listReferencingForeignKeys).toHaveBeenCalledWith(
      "c1",
      "shop",
      "customers",
    );
    // Still open, and the button is back for another attempt.
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("uses the generic message for any other failure, without looking up references", async () => {
    const onDelete = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue("connection refused");
    mount(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText("Could not delete: connection refused"),
    ).toBeTruthy();
    expect(listReferencingForeignKeys).not.toHaveBeenCalled();
  });
});
