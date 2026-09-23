/**
 * @vitest-environment jsdom
 *
 * The FK picker must not trust its cache: a referenced key renamed after the
 * first open has to show up on the next one. It used to return early on a
 * cache hit, so the stale list survived F5 and edits alike until restart.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fkOptionsCache } from "@/stores/grid/fkOptions";
import { FkCombobox } from "./FkCombobox";

const fetchFkOptions = vi.fn();
vi.mock("@/lib/tauri", () => ({
  api: {
    fetchFkOptions: (args: unknown) => fetchFkOptions(args),
  },
}));

afterEach(() => {
  cleanup();
  fetchFkOptions.mockReset();
  fkOptionsCache.clearConnection("c1");
});

function renderPicker() {
  return render(
    <FkCombobox
      connectionId="c1"
      refTable="artist"
      refColumn="id"
      // Not one of the options below: the trigger carries its value as a
      // `title` too, and would otherwise satisfy the option lookups.
      value="7"
      nullable={false}
      onChange={() => {}}
    />,
  );
}

describe("FkCombobox", () => {
  it("refetches on a cache hit and replaces the stale options", async () => {
    fkOptionsCache.set("c1", undefined, "artist", "id", {
      kind: "ready",
      options: [{ value: "5", label: null }],
    });
    fetchFkOptions.mockResolvedValue({
      options: [{ value: "50", label: null }],
      has_more: false,
    });

    renderPicker();
    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByTitle("50")).toBeTruthy();
    expect(screen.queryByTitle("5")).toBeNull();
    expect(fetchFkOptions).toHaveBeenCalledTimes(1);
    expect(fkOptionsCache.get("c1", undefined, "artist", "id")?.options).toEqual(
      [{ value: "50", label: null }],
    );
  });

  it("keeps the picker on a cached page when the refresh fails", async () => {
    fkOptionsCache.set("c1", undefined, "artist", "id", {
      kind: "ready",
      options: [{ value: "5", label: null }],
    });
    fetchFkOptions.mockRejectedValue(new Error("pool closed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderPicker();
    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTitle("5")).toBeTruthy();
    warn.mockRestore();
  });

  it("falls back to a text input when there is nothing cached to show", async () => {
    fetchFkOptions.mockRejectedValue(new Error("no such table"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderPicker();

    expect(await screen.findByRole("textbox")).toBeTruthy();
    warn.mockRestore();
  });
});
