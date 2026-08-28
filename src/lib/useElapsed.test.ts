// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsed } from "./useElapsed";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useElapsed", () => {
  it("starts at 0 with no outcome yet", () => {
    const { result } = renderHook(() => useElapsed());
    expect(result.current.elapsedMs).toBe(0);
    expect(result.current.lastOk).toBeNull();
  });

  it("ticks every 50ms while running", () => {
    const { result } = renderHook(() => useElapsed());
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(120));
    // Two full ticks elapsed (100ms); the exact value tracks Date.now(), so
    // assert it's in the ballpark rather than pinning an exact number.
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(result.current.lastOk).toBeNull();
  });

  it("freezes elapsedMs and records the outcome on stop", () => {
    const { result } = renderHook(() => useElapsed());
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(80));
    act(() => result.current.stop(true));
    const frozen = result.current.elapsedMs;
    expect(result.current.lastOk).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    // No more ticks after stop() — the interval was cleared.
    expect(result.current.elapsedMs).toBe(frozen);
  });

  it("records a failed outcome", () => {
    const { result } = renderHook(() => useElapsed());
    act(() => result.current.start());
    act(() => result.current.stop(false));
    expect(result.current.lastOk).toBe(false);
  });

  it("a second start() resets elapsedMs and clears the previous interval", () => {
    const { result } = renderHook(() => useElapsed());
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.start());
    expect(result.current.elapsedMs).toBe(0);
    expect(result.current.lastOk).toBeNull();
    // Only one interval should be alive — advancing shouldn't double-tick.
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(50);
    expect(result.current.elapsedMs).toBeLessThan(150);
  });

  it("clears its interval on unmount", () => {
    const clearSpy = vi.spyOn(global, "clearInterval");
    const { result, unmount } = renderHook(() => useElapsed());
    act(() => result.current.start());
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
