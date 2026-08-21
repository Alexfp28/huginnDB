import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounce, repeating } from "./schedule";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("debounce", () => {
  it("runs once, trailing, with the last arguments", () => {
    const run = vi.fn<(value: string) => void>();
    const d = debounce(100, run);
    d.schedule("a");
    d.schedule("b");
    vi.advanceTimersByTime(99);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run.mock.calls).toEqual([["b"]]);
  });

  it("reports pending only while a call is armed", () => {
    const d = debounce(100, () => {});
    expect(d.pending).toBe(false);
    d.schedule();
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(100);
    expect(d.pending).toBe(false);
  });

  it("cancel drops the pending call and says whether there was one", () => {
    const run = vi.fn();
    const d = debounce(100, run);
    expect(d.cancel()).toBe(false);
    d.schedule();
    expect(d.cancel()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    // `flushTabState` relies on this exact pair: cancel returning true is what
    // tells it there were unsaved edits worth writing synchronously.
    expect(d.cancel()).toBe(false);
  });

  it("clears the handle before running, so a re-schedule from inside works", () => {
    const seen: boolean[] = [];
    const d: { schedule: () => void; pending: boolean } = debounce(100, () => {
      seen.push(d.pending);
    });
    d.schedule();
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([false]);
  });
});

describe("repeating", () => {
  it("ticks on the interval and is idempotent on start", () => {
    const run = vi.fn();
    const r = repeating(100, run);
    r.start();
    // A StrictMode double-effect calls start twice; the second must not stack a
    // second interval that also fires forever.
    r.start();
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stops, and can be restarted", () => {
    const run = vi.fn();
    const r = repeating(100, run);
    r.start();
    expect(r.running).toBe(true);
    r.stop();
    expect(r.running).toBe(false);
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
    r.start();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
