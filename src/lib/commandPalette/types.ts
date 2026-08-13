/**
 * Shape of a command-palette entry, plus the group ordering and the `>`/`@`/`#`
 * mode prefixes that scope a search — the two pieces every provider and the
 * palette UI itself agree on.
 *
 * Modes are VS Code's idea: a leading sigil narrows the index to one kind of
 * thing, so `#wrap` can only ever hit a preference and `@users` can only ever
 * hit a table. Without them, one flat list makes the palette worse as it grows
 * — a 2,000-table connection would bury every action. With no prefix typed
 * everything is searched, which stays the right default for "I don't know where
 * this lives".
 */

import type { ReactNode } from "react";

/**
 * Kind of entry, which is also its section header. Order here is the order the
 * groups appear in when the query is empty (see `GROUP_ORDER`).
 */
export type PaletteGroup =
  | "recent"
  | "actions"
  | "panels"
  | "settings"
  | "appearance"
  | "tabs"
  | "connections"
  | "environments"
  | "databases"
  | "schema"
  | "saved"
  | "history"
  | "help";

/** Display order + section-header labels for every group. */
export const GROUP_ORDER: { id: PaletteGroup; labelKey: string }[] = [
  { id: "recent", labelKey: "commandPalette.groupRecent" },
  { id: "actions", labelKey: "commandPalette.groupActions" },
  { id: "panels", labelKey: "commandPalette.groupPanels" },
  { id: "settings", labelKey: "commandPalette.groupSettings" },
  { id: "appearance", labelKey: "commandPalette.groupAppearance" },
  { id: "tabs", labelKey: "commandPalette.groupTabs" },
  { id: "connections", labelKey: "commandPalette.groupConnections" },
  { id: "environments", labelKey: "commandPalette.groupEnvironments" },
  { id: "databases", labelKey: "commandPalette.groupDatabases" },
  { id: "schema", labelKey: "commandPalette.groupTables" },
  { id: "saved", labelKey: "commandPalette.groupSaved" },
  { id: "history", labelKey: "commandPalette.groupHistory" },
  { id: "help", labelKey: "commandPalette.groupHelp" },
];

const GROUP_RANK = new Map(GROUP_ORDER.map((g, i) => [g.id, i]));

/** Sort key for a group, used as the tiebreak behind the fuzzy score. */
export function groupRank(group: PaletteGroup): number {
  return GROUP_RANK.get(group) ?? GROUP_ORDER.length;
}

/** A secondary action offered on the highlighted row via Alt+Enter. */
export interface PaletteAltAction {
  /** i18n key for the footer hint ("toggle", "disconnect", …). */
  hintKey: string;
  run: () => void;
  /**
   * Whether the palette stays open afterwards. `true` for repeatable
   * in-place edits (flipping a boolean preference), so the row's value badge
   * updates under the cursor instead of the modal vanishing.
   */
  keepOpen?: boolean;
}

export interface PaletteCommand {
  /**
   * Stable across renders and app restarts — it's the MRU key, so a churning
   * id (an array index, a timestamp) would silently break "recently used".
   */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Second line: where this lives or what it points at. */
  detail?: string;
  /** Extra match text, never rendered. */
  keywords?: string;
  icon: ReactNode;
  /** Right-aligned value chip — a setting's current value, a driver name. */
  badge?: string;
  /** Right-aligned key combo, when the action has a global shortcut. */
  combo?: string;
  /** Marks the entry as the thing already in effect (active tab, live theme). */
  current?: boolean;
  run: () => void;
  alt?: PaletteAltAction;
}

export interface PaletteMode {
  /** `""` is the catch-all mode: no prefix typed, everything searched. */
  prefix: string;
  labelKey: string;
  /** Groups this mode searches. Empty means "all of them". */
  groups: PaletteGroup[];
}

/**
 * Available modes, longest prefix first so `parseQuery` can match greedily if a
 * multi-character prefix is ever added.
 */
export const MODES: PaletteMode[] = [
  {
    prefix: ">",
    labelKey: "commandPalette.modeActions",
    groups: ["actions", "panels", "appearance"],
  },
  { prefix: "@", labelKey: "commandPalette.modeSchema", groups: ["schema", "databases"] },
  { prefix: "#", labelKey: "commandPalette.modeSettings", groups: ["settings"] },
  { prefix: "?", labelKey: "commandPalette.modeHelp", groups: ["help"] },
  {
    prefix: ":",
    labelKey: "commandPalette.modeGoto",
    groups: ["tabs", "connections", "environments"],
  },
];

export const ALL_MODE: PaletteMode = {
  prefix: "",
  labelKey: "commandPalette.modeAll",
  groups: [],
};

/** Split raw input into its mode and the remaining search text. */
export function parseQuery(raw: string): { mode: PaletteMode; query: string } {
  const mode = MODES.find((m) => raw.startsWith(m.prefix));
  if (!mode) return { mode: ALL_MODE, query: raw.trim() };
  return { mode, query: raw.slice(mode.prefix.length).trim() };
}

/** Whether `mode` searches `group`. */
export function modeIncludes(mode: PaletteMode, group: PaletteGroup): boolean {
  // "recent" is a presentation group synthesised by the palette, never a
  // provider's own group, so it is never filtered here.
  return mode.groups.length === 0 || mode.groups.includes(group);
}
