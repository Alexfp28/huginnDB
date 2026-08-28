/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditorOptions } from "./useEditorOptions";

describe("useEditorOptions", () => {
  it("keeps the same reference across renders when deps are unchanged", () => {
    const prefs = { fontSize: 13 };
    const { result, rerender } = renderHook(
      ({ p }: { p: typeof prefs }) => useEditorOptions(() => ({ fontSize: p.fontSize }), [p]),
      { initialProps: { p: prefs } },
    );
    const first = result.current;

    rerender({ p: prefs });

    expect(result.current).toBe(first);
  });

  it("returns a fresh reference when a dep changes", () => {
    const { result, rerender } = renderHook(
      ({ p }: { p: { fontSize: number } }) =>
        useEditorOptions(() => ({ fontSize: p.fontSize }), [p]),
      { initialProps: { p: { fontSize: 13 } } },
    );
    const first = result.current;

    rerender({ p: { fontSize: 14 } });

    expect(result.current).not.toBe(first);
    expect(result.current.fontSize).toBe(14);
  });
});
