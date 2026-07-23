/**
 * Keeps the OS window title (taskbar / Alt-Tab entry) in sync with what the
 * window is actually showing, so multiple HuginnDB windows are tellable apart
 * from outside the app (#59) and the active table's database + name is always
 * visible (#57).
 *
 * Renders nothing — it is a side-effect-only component mounted once per window.
 * Runs in EVERY window (not main-only): each window has its own title, and a
 * secondary window is exactly the case #59 is about. `setTitle` is guarded in a
 * try/catch because it is an async IPC call whose permission is capability-
 * scoped; a failure must never break rendering.
 *
 * Title shape:
 *   "<profile> · <db>.<table> — HuginnDB"   when a table tab is active
 *   "<profile> · <db> — HuginnDB"           when another tab / connection is focused
 *   "HuginnDB"                              when nothing is connected
 */

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useAppFlavor } from "@/stores/appFlavor";
import {
  resolveConnectionLabel,
  resolveConnectionParts,
} from "@/lib/connectionLabel";

export function WindowTitleSync() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const profiles = useConnections((s) => s.profiles);
  const selectedConnectionId = useUi((s) => s.selectedConnectionId);
  // Flavor-aware app name: the canary build must read "HuginnDB Canary" in the
  // taskbar / Alt-Tab entry too, otherwise it is indistinguishable from the
  // stable install from outside the window. Defaults to "HuginnDB" until the
  // flavor resolves. This is why the OS title set by tauri.canary.conf.json
  // couldn't stand on its own — this effect used to overwrite it every render.
  const appName = useAppFlavor((s) => s.productName);

  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeId);
    const APP_NAME = appName;
    let title = APP_NAME;

    if (activeTab?.table) {
      const { profileName, database } = resolveConnectionParts(
        profiles,
        activeTab.connectionId,
      );
      const dbTable = database
        ? `${database}.${activeTab.table}`
        : activeTab.table;
      title = profileName
        ? `${profileName} · ${dbTable} — ${APP_NAME}`
        : `${dbTable} — ${APP_NAME}`;
    } else if (activeTab) {
      // A query / structure / security tab: identify the connection at least.
      const label = resolveConnectionLabel(profiles, activeTab.connectionId);
      title = label ? `${label} — ${APP_NAME}` : APP_NAME;
    } else if (selectedConnectionId) {
      const label = resolveConnectionLabel(profiles, selectedConnectionId);
      title = label ? `${label} — ${APP_NAME}` : APP_NAME;
    }

    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {
        // Capability-scoped IPC; never let a title update break the UI.
      });
  }, [tabs, activeId, profiles, selectedConnectionId, appName]);

  return null;
}
