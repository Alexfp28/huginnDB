/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField } from "./search-field";

afterEach(() => {
  cleanup();
});

const input = () => screen.getByRole("textbox") as HTMLInputElement;

describe("SearchField", () => {
  it("pairs the magnifier's offset with the input's padding", () => {
    // The pairing is the whole point: they have to agree or the caret starts
    // under the icon, and ten call sites were remembering it by hand in three
    // different combinations.
    const { container } = render(
      <SearchField size="xs" value="" onValueChange={() => {}} />,
    );
    expect(container.querySelector("svg")!.getAttribute("class")).toContain(
      "left-2",
    );
    expect(input().className).toContain("pl-6");
  });

  it("reports typing as a value, not an event", () => {
    const onValueChange = vi.fn();
    render(<SearchField value="" onValueChange={onValueChange} />);
    fireEvent.change(input(), { target: { value: "cust" } });
    expect(onValueChange).toHaveBeenCalledWith("cust");
  });

  it("shows the clear button only when there is something to clear", () => {
    const { rerender } = render(
      <SearchField
        value=""
        onValueChange={() => {}}
        onClear={() => {}}
        clearLabel="Clear"
      />,
    );
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    rerender(
      <SearchField
        value="x"
        onValueChange={() => {}}
        onClear={() => {}}
        clearLabel="Clear"
      />,
    );
    expect(screen.getByRole("button", { name: "Clear" })).not.toBeNull();
  });

  it("reserves room on the right only while the clear button is there", () => {
    render(
      <SearchField
        value="x"
        onValueChange={() => {}}
        onClear={() => {}}
        clearLabel="Clear"
      />,
    );
    expect(input().className).toContain("pr-8");
  });

  it("calls onClear", () => {
    const onClear = vi.fn();
    render(
      <SearchField
        value="x"
        onValueChange={() => {}}
        onClear={onClear}
        clearLabel="Clear"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalled();
  });
});
