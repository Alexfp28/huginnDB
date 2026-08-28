// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useIsPanelVisible } from "./useIsPanelVisible";
import type { ActiveEvent, VisibilityEvent } from "dockview-react";

type Listener<E> = (e: E) => void;

/** Minimal fake of the slice of `DockviewPanelApi` this hook reads —
 *  `isActive`/`isVisible` plus their two change events, each firable from
 *  the test to simulate dockview switching tabs or hiding a panel. */
function fakeApi(initial: { isActive: boolean; isVisible: boolean }) {
  let isActive = initial.isActive;
  let isVisible = initial.isVisible;
  const activeListeners: Listener<ActiveEvent>[] = [];
  const visibilityListeners: Listener<VisibilityEvent>[] = [];
  return {
    get isActive() {
      return isActive;
    },
    get isVisible() {
      return isVisible;
    },
    onDidActiveChange: (cb: Listener<ActiveEvent>) => {
      activeListeners.push(cb);
      return { dispose: () => {} };
    },
    onDidVisibilityChange: (cb: Listener<VisibilityEvent>) => {
      visibilityListeners.push(cb);
      return { dispose: () => {} };
    },
    fireActive(next: boolean) {
      isActive = next;
      activeListeners.forEach((cb) => cb({ isActive: next }));
    },
    fireVisible(next: boolean) {
      isVisible = next;
      visibilityListeners.forEach((cb) => cb({ isVisible: next }));
    },
  };
}

describe("useIsPanelVisible", () => {
  it("starts true for the active, visible tab", () => {
    const api = fakeApi({ isActive: true, isVisible: true });
    const { result } = renderHook(() =>
      useIsPanelVisible(api as unknown as Parameters<typeof useIsPanelVisible>[0]),
    );
    expect(result.current).toBe(true);
  });

  it("starts false for a background tab kept mounted", () => {
    const api = fakeApi({ isActive: false, isVisible: true });
    const { result } = renderHook(() =>
      useIsPanelVisible(api as unknown as Parameters<typeof useIsPanelVisible>[0]),
    );
    expect(result.current).toBe(false);
  });

  it("flips to true when the tab becomes active", () => {
    const api = fakeApi({ isActive: false, isVisible: true });
    const { result } = renderHook(() =>
      useIsPanelVisible(api as unknown as Parameters<typeof useIsPanelVisible>[0]),
    );
    act(() => api.fireActive(true));
    expect(result.current).toBe(true);
  });

  it("flips to false when the tab is switched away from", () => {
    const api = fakeApi({ isActive: true, isVisible: true });
    const { result } = renderHook(() =>
      useIsPanelVisible(api as unknown as Parameters<typeof useIsPanelVisible>[0]),
    );
    act(() => api.fireActive(false));
    expect(result.current).toBe(false);
  });

  it("an active but explicitly hidden panel reads as not visible", () => {
    const api = fakeApi({ isActive: true, isVisible: true });
    const { result } = renderHook(() =>
      useIsPanelVisible(api as unknown as Parameters<typeof useIsPanelVisible>[0]),
    );
    act(() => api.fireVisible(false));
    expect(result.current).toBe(false);
  });
});
