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
  // general
  | "openSettings"
  | "toggleCommandPalette"
  | "openCommandActions"
  | "newConnection"
  | "manageConnections"
  | "importProfiles"
  | "exportProfiles"
  | "manageJsonSchemas"
  | "importJsonSchemas"
  | "exportJsonSchemas"
  // tabs
  | "toggleTabSwitcher"
  | "newQuery"
  | "closeTab"
  | "closeAllTabs"
  | "togglePinTab"
  // query
  | "runQuery"
  // grid
  | "refreshData"
  | "expandSelectedCell"
  // schema
  | "refreshSchema"
  | "focusTreeFilter"
  | "clearTreeFilter"
  | "scopeFilterToConnection"
  | "disconnectAll"
  // panels
  | "togglePanelSchema"
  | "togglePanelSaved"
  | "togglePanelConsole"
  | "newWindow"
  | "resetLayout";

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

  // ── The schema tree's search ─────────────────────────────────────────────
  //
  // The first real inhabitants of the `tree` scope, which was declared with the
  // catalogue and has been unused since.
  //
  // `focusTreeFilter` is `global`, not `tree`, and that is not an oversight: a
  // `tree`-scoped binding is only audible once the focus is already inside the
  // panel (see `scopesAt`), so the action whose entire job is to *take* you
  // there could never fire. Mod+Shift+F is free (P, R and N are the taken
  // Mod+Shift letters) and is the muscle memory for "search everything".
  {
    id: "focusTreeFilter",
    category: "schema",
    scope: "global",
    defaults: ["Mod+Shift+F"],
    labelKey: "settings.shortcuts.focusTreeFilter",
    descKey: "settings.shortcuts.focusTreeFilterHint",
  },
  // Escape is a legal chord and `isTypeableChord("Escape")` is false, so it
  // fires with the cursor inside the filter input — the same reasoning that
  // keeps F5 working from the grid's search box. Radix menus portal to `body`,
  // outside `[data-kb-scope="tree"]`, so an open context menu's Escape resolves
  // at `global` and this never steals it.
  {
    id: "clearTreeFilter",
    category: "schema",
    scope: "tree",
    defaults: ["Escape"],
    labelKey: "settings.shortcuts.clearTreeFilter",
    descKey: "settings.shortcuts.clearTreeFilterHint",
  },
  // Ships unbound, like most of the catalogue: being here already makes it
  // searchable in the palette and bindable in Settings.
  {
    id: "scopeFilterToConnection",
    category: "schema",
    scope: "tree",
    defaults: [],
    labelKey: "settings.shortcuts.scopeFilterToConnection",
  },
  {
    id: "expandSelectedCell",
    category: "grid",
    scope: "grid",
    defaults: ["Space"],
    labelKey: "settings.shortcuts.expandSelectedCell",
  },

  // ── Actions the command palette already knew how to run ──────────────────
  //
  // These reuse the palette's and the menus' existing labels rather than
  // minting a second wording for the same command: one catalogue means one
  // name, and a shortcut called something different from the menu item it
  // fires is its own small bug.
  //
  // Most ship **unbound on purpose**. Being in the catalogue already makes an
  // action searchable and bindable; spending a default key on it would take
  // that key away from whatever the user actually reaches for. Only the four
  // with an unambiguous convention get one.
  {
    id: "newConnection",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.newConnection",
  },
  {
    id: "manageConnections",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.manageConnections",
  },
  {
    id: "importProfiles",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.importProfiles",
  },
  {
    id: "exportProfiles",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.exportProfiles",
  },
  {
    id: "manageJsonSchemas",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "jsonSchemas.title",
  },
  {
    id: "importJsonSchemas",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.importJsonSchemas",
  },
  {
    id: "exportJsonSchemas",
    category: "general",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.exportJsonSchemas",
  },
  {
    id: "newQuery",
    category: "tabs",
    scope: "global",
    defaults: ["Mod+T"],
    labelKey: "commandPalette.newQuery",
  },
  {
    id: "closeTab",
    category: "tabs",
    scope: "global",
    defaults: ["Mod+W"],
    labelKey: "commandPalette.closeTab",
  },
  {
    id: "closeAllTabs",
    category: "tabs",
    scope: "global",
    defaults: [],
    labelKey: "commandPalette.closeAllTabs",
  },
  {
    id: "togglePinTab",
    category: "tabs",
    scope: "global",
    defaults: [],
    labelKey: "commandPalette.pinTab",
  },
  {
    id: "disconnectAll",
    category: "schema",
    scope: "global",
    defaults: [],
    labelKey: "menu.file.disconnectAll",
  },
  {
    id: "togglePanelSchema",
    category: "panels",
    scope: "global",
    defaults: ["Mod+B"],
    labelKey: "settings.shortcuts.togglePanelSchema",
  },
  {
    id: "togglePanelSaved",
    category: "panels",
    scope: "global",
    defaults: [],
    labelKey: "settings.shortcuts.togglePanelSaved",
  },
  {
    id: "togglePanelConsole",
    category: "panels",
    scope: "global",
    defaults: ["Mod+`"],
    labelKey: "settings.shortcuts.togglePanelConsole",
  },
  {
    id: "newWindow",
    category: "panels",
    scope: "global",
    defaults: ["Mod+Shift+N"],
    labelKey: "menu.window.newWindow",
  },
  {
    id: "resetLayout",
    category: "panels",
    scope: "global",
    defaults: [],
    labelKey: "menu.window.resetLayout",
  },
];

export const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
