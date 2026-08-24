// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useAsyncSubmit } from "./useAsyncSubmit";

describe("useAsyncSubmit", () => {
  it("stays in flight after a success, so the dialog can't be submitted twice", async () => {
    const { result } = renderHook(() => useAsyncSubmit());
    await act(async () => {
      result.current.run(async () => {});
    });
    // The success path always closes or replaces the dialog; clearing the flag
    // here would re-enable the buttons for the frames before the unmount lands.
    expect(result.current.submitting).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("surfaces the failure and re-enables the form", async () => {
    const { result } = renderHook(() => useAsyncSubmit());
    await act(async () => {
      result.current.run(async () => {
        throw new Error("nope");
      });
    });
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBe("Error: nope");
  });

  it("clears a previous error when the next task starts", async () => {
    const { result } = renderHook(() => useAsyncSubmit());
    await act(async () => {
      result.current.run(async () => {
        throw new Error("first");
      });
    });
    expect(result.current.error).toBe("Error: first");
    let release: (() => void) | undefined;
    await act(async () => {
      result.current.run(() => new Promise<void>((r) => (release = r)));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.submitting).toBe(true);
    await act(async () => release?.());
  });

  it("clearError drops a message without running anything", async () => {
    const { result } = renderHook(() => useAsyncSubmit());
    await act(async () => {
      result.current.run(async () => {
        throw new Error("boom");
      });
    });
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.submitting).toBe(false);
  });
});
