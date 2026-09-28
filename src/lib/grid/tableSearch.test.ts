/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { focusTableSearch } from "./tableSearch";

describe("focusTableSearch", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses and selects the named tab's filter box", () => {
    document.body.innerHTML = `
      <div data-table-tab="t1"><input data-grid-search value="old query"></div>`;
    expect(focusTableSearch("t1")).toBe(true);
    const input = document.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("old query".length);
  });

  it("never answers for another tab's grid", () => {
    document.body.innerHTML = `
      <div data-table-tab="other"><input data-grid-search></div>
      <div data-table-tab="t1"></div>`;
    expect(focusTableSearch("t1")).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("is false for a tab that is not mounted", () => {
    expect(focusTableSearch("missing")).toBe(false);
  });
});
