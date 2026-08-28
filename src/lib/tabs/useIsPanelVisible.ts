import { useEffect, useState } from "react";
import type { DockviewPanelApi } from "dockview-react";

/**
 * Whether a dockview panel is the one actually on screen right now — the
 * active tab of a visible group, as opposed to a background tab that
 * `TabbedArea` keeps mounted on purpose (see that file's header comment:
 * every open tab keeps its own React tree for the lifetime of the tab, so
 * switching tabs doesn't reset a filter draft or a scroll position). That
 * design means a query still ticking its timer, a grid still holding a
 * virtualizer, or any other per-tab recurring work keeps running for tabs
 * nobody is looking at — this hook is how such work can check "is anyone
 * even seeing this?" without the tab itself needing to unmount.
 *
 * Backed by `DockviewPanelApi.isActive`/`isVisible`, which each panel
 * component already receives as `props.api` (`IDockviewPanelProps`) — no
 * group-level bookkeeping needed, dockview tracks both per panel already.
 * `isActive` is "the selected tab within its group"; `isVisible` is
 * "not explicitly hidden via `setVisible(false)`" (unused by this app
 * today, but a panel could in principle be both inactive-in-its-group and
 * explicitly hidden, so both are checked).
 */
export function useIsPanelVisible(api: DockviewPanelApi): boolean {
  const [visible, setVisible] = useState(() => api.isActive && api.isVisible);

  useEffect(() => {
    setVisible(api.isActive && api.isVisible);
    const activeSub = api.onDidActiveChange((e) =>
      setVisible(e.isActive && api.isVisible),
    );
    const visibleSub = api.onDidVisibilityChange((e) =>
      setVisible(api.isActive && e.isVisible),
    );
    return () => {
      activeSub.dispose();
      visibleSub.dispose();
    };
  }, [api]);

  return visible;
}
