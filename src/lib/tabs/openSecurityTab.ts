/**
 * Open (or focus, if already open) the "Security" tab for a connection.
 *
 * A one-liner over `useTabs.open`, but it lives next to `openQueryTab` for the
 * same reason that one does: the two surfaces that offer it (the connection
 * row's menu and the multi-DB explorer) are now in different domains, and the
 * `kind` string is the kind of thing that gets mistyped once and then silently
 * opens a second tab of a type nothing renders.
 */

import { useTabs } from "@/stores/session/tabs";

export function openSecurityTab(connectionId: string, title: string): void {
  useTabs.getState().open({ kind: "security", title, connectionId });
}
