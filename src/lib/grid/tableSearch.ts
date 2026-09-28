/**
 * Put the focus in a table tab's own filter box — the find key's answer when a
 * table is what the user is looking at.
 *
 * Found through the DOM rather than a registry like `tableRefresh`'s: the box
 * lives three components below the tab (TableDataTab → DataGrid → GridToolbar
 * → GridSearchInput), and the only thing the caller knows is the tab id. The
 * tab's root carries `data-table-tab`, the input carries `data-grid-search`,
 * and scoping the query to the one tab means a second grid mounted elsewhere
 * (a query result, another dockview group) can never be the one that answers.
 */

export function focusTableSearch(tabId: string): boolean {
  // Compared through `dataset` rather than spliced into a selector, so an id
  // never has to be escaped to be matched.
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>("[data-table-tab]"),
  ).find((el) => el.dataset.tableTab === tabId);
  const input = tab?.querySelector<HTMLInputElement>("input[data-grid-search]");
  if (!input) return false;
  input.focus();
  // Select, so typing replaces the last search instead of appending to it —
  // what Ctrl+F does in every browser and editor.
  input.select();
  return true;
}
