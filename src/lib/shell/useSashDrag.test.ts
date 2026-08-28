/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSashDrag } from "./useSashDrag";

let rafCallbacks: FrameRequestCallback[];
let nextRafId: number;
let canceled: Set<number>;

// Only the fields `useSashDrag` actually reads off a pointer event — a full
// `React.PointerEvent` is not worth constructing by hand.
function fakePointerEvent(overrides: {
  clientX?: number;
  clientY?: number;
  buttons?: number;
  pointerId?: number;
}): React.PointerEvent<HTMLDivElement> {
  return {
    preventDefault: vi.fn(),
    clientX: overrides.clientX ?? 0,
    clientY: overrides.clientY ?? 0,
    buttons: overrides.buttons ?? 1,
    pointerId: overrides.pointerId ?? 1,
    currentTarget: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    },
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

function runPendingFrame() {
  const callbacks = rafCallbacks;
  rafCallbacks = [];
  for (const cb of callbacks) cb(0);
}

beforeEach(() => {
  rafCallbacks = [];
  nextRafId = 1;
  canceled = new Set();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return nextRafId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    canceled.add(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSashDrag", () => {
  it("coalesces several pointermoves in one frame into a single, summed onResize", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() =>
      useSashDrag({ orientation: "vertical", onResize }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent({ clientX: 100 }));
      result.current.onPointerMove(fakePointerEvent({ clientX: 105 })); // +5
      result.current.onPointerMove(fakePointerEvent({ clientX: 103 })); // -2
      result.current.onPointerMove(fakePointerEvent({ clientX: 112 })); // +9
    });

    // Nothing fires synchronously — it's queued for the next frame.
    expect(onResize).not.toHaveBeenCalled();

    act(() => {
      runPendingFrame();
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(12);
  });

  it("flushes a pending delta on pointerup instead of dropping it", () => {
    const onResize = vi.fn();
    const onDraggingChange = vi.fn();
    const { result } = renderHook(() =>
      useSashDrag({ orientation: "horizontal", onResize, onDraggingChange }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent({ clientY: 50 }));
      result.current.onPointerMove(fakePointerEvent({ clientY: 60 })); // +10, queued
      result.current.onPointerUp(fakePointerEvent({}));
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(10);
    expect(onDraggingChange).toHaveBeenNthCalledWith(1, true);
    expect(onDraggingChange).toHaveBeenNthCalledWith(2, false);

    // The frame that was canceled must not fire a second, empty flush.
    act(() => {
      runPendingFrame();
    });
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it("ignores a pointermove with no buttons pressed", () => {
    const onResize = vi.fn();
    const { result } = renderHook(() =>
      useSashDrag({ orientation: "vertical", onResize }),
    );

    act(() => {
      result.current.onPointerDown(fakePointerEvent({ clientX: 0 }));
      result.current.onPointerMove(fakePointerEvent({ clientX: 40, buttons: 0 }));
      runPendingFrame();
    });

    expect(onResize).not.toHaveBeenCalled();
  });
});
