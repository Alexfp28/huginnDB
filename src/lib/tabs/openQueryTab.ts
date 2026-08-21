/**
 * Open a query tab.
 *
 * Seven call sites assembled the `useTabs.open({ kind: "query", … })` payload
 * themselves, and the five that open an *empty* query each carried the seed text
 * as a raw English literal — `"-- write a SQL query and press Ctrl+Enter\n"` —
 * so a Spanish user got an English comment in a brand-new tab five different
 * ways. The seed is now an i18n key.
 *
 * `resolveTarget` routes the tab through `useTabs.queryTargetFor`, which lands
 * it on the database the user is currently looking at rather than the parent
 * connection. That is what every "new query here" affordance wants, so it is the
 * default — but `StatusBar`'s history menu passes `false` deliberately: it
 * reopens a *past* query on the connection it was originally run against, and
 * redirecting that to whichever database happens to be in front of the user
 * would reopen it against the wrong data.
 */

import i18n from "i18next";

import { useTabs } from "@/stores/session/tabs";

export interface OpenQueryTabOptions {
  /** SQL to seed the tab with. Omitted means a new, empty query. */
  sql?: string;
  /** Tab title. Defaults to the generic query-file name. */
  title?: string;
  /** Route through `queryTargetFor`. Defaults to `true`. */
  resolveTarget?: boolean;
}

/** Returns the new tab's id. */
export function openQueryTab(
  connectionId: string,
  opts: OpenQueryTabOptions = {},
): string {
  const tabs = useTabs.getState();
  return tabs.open({
    kind: "query",
    title: opts.title ?? i18n.t("tabs.queryFileName"),
    connectionId:
      opts.resolveTarget === false
        ? connectionId
        : tabs.queryTargetFor(connectionId),
    query: opts.sql ?? i18n.t("query.newTabPlaceholder"),
  });
}
