/**
 * The action catalogue: every command the user can put a key on.
 *
 * This table is the single source of truth for *default* bindings —
 * `prefs.json` only ever stores overrides, so a missing or empty map is a
 * fully valid, fully functional state. Three rules the shape encodes:
 *
 * - `defaults` is a **list**. The first entry is the primary binding (what
 *   menus, the palette and tooltips display); the rest are aliases that fire
 *   just as well. A user override replaces the whole list.
 * - `fixed` holds bindings the user cannot rebind or remove, because
 *   intercepting them is a safety necessity rather than a preference — today
 *   that is only `Mod+R`, which has to keep the WebView from reloading the app
 *   out from under an open transaction.
 * - `scope` says *where* the action listens. `global` is anywhere; the rest
 *   only fire when the focus is inside a surface that declares the matching
 *   `data-kb-scope`. See `resolve.ts` for the overlap rule.
 */

/** Where an action listens. A surface declares its scope with `data-kb-scope`;
 *  `resolve.ts` decides which scopes a given focus position can reach. */
export type Scope = "global" | "editor" | "grid" | "tree" | "overlay";

/** Groups the Settings list. Ordering here is the ordering on screen. */
export type Category = "general" | "tabs" | "query" | "grid" | "schema" | "panels";

export const CATEGORY_ORDER: Category[] = [
  "general",
  "tabs",
  "query",
  "grid",
  "schema",
  "panels",
];

export type ActionId =
  | "openSettings"
  | "toggleCommandPalette"
  | "openCommandActions"
  | "toggleTabSwitcher"
  | "refreshData"
  | "refreshSchema"
  | "runQuery"
  | "expandSelectedCell";

export interface ActionSpec {
  id: ActionId;
  category: Category;
  scope: Scope;
  /** Default bindings, primary first. `[]` means "ships unbound". */
  defaults: string[];
  /** Bindings the user can neither change nor remove. Displayed, but greyed. */
  fixed?: string[];
  labelKey: string;
  descKey?: string;
}

export const ACTIONS: ActionSpec[] = [
  {
    id: "openSettings",
    category: "general",
    scope: "global",
    defaults: ["Mod+,"],
    labelKey: "settings.shortcuts.openSettings",
  },
  {
    id: "toggleCommandPalette",
    category: "general",
    scope: "global",
    defaults: ["Mod+K"],
    labelKey: "settings.shortcuts.toggleCommandPalette",
  },
  // Same palette, opened straight into its actions-only mode (`>`), mirroring
  // VS Code's Ctrl+Shift+P.
  {
    id: "openCommandActions",
    category: "general",
    scope: "global",
    defaults: ["Mod+Shift+P"],
    labelKey: "settings.shortcuts.openCommandActions",
  },
  {
    id: "toggleTabSwitcher",
    category: "tabs",
    scope: "global",
    defaults: ["Mod+P"],
    labelKey: "settings.shortcuts.toggleTabSwitcher",
  },
  {
    id: "refreshData",
    category: "grid",
    scope: "global",
    defaults: ["F5"],
    // Always intercepting the WebView's native reload is a safety necessity,
    // not a preference: a reload mid-edit drops the session. It used to be an
    // `if` branch in `App.tsx`; declaring it here is what lets the Settings UI
    // show it instead of hiding it.
    fixed: ["Mod+R"],
    labelKey: "settings.shortcuts.refreshData",
    descKey: "settings.shortcuts.refreshHint",
  },
  // Deliberately a *different* action from `refreshData`: F5 refreshes the
  // rows of the table you are looking at, this one re-reads the catalog
  // (databases, tables, and the columns of every open node) for the selected
  // connection and every per-database view under it.
  {
    id: "refreshSchema",
    category: "schema",
    scope: "global",
    defaults: ["Mod+Shift+R"],
    labelKey: "settings.shortcuts.refreshSchema",
  },
  {
    id: "runQuery",
    category: "query",
    scope: "editor",
    defaults: ["Mod+Enter"],
    labelKey: "settings.shortcuts.runQuery",
  },
  {
    id: "expandSelectedCell",
    category: "grid",
    scope: "grid",
    defaults: ["Space"],
    labelKey: "settings.shortcuts.expandSelectedCell",
  },
];

export const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
