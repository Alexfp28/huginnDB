/**
 * Adoption budgets for the component library — a ratchet, not a contract.
 *
 * `uiContracts.test.ts` states its own design rule at the top: a rule belongs
 * there only if its allowlist *can* be empty, because "one that needs
 * exceptions is a matter of taste". That rule is right and this file does not
 * bend it — it answers a different question. A contract says *this is a bug*.
 * A budget says *this is debt, and it may only shrink*. Two of the patterns the
 * primitives were built to replace have a hundred-plus call sites that predate
 * them, so they cannot be contracts today and would be lost as TODO comments if
 * they were left as prose. They are counted here instead.
 *
 * Note that `uiContracts.test.ts` explicitly *rejected* "ban native `title=`"
 * on exactly these grounds. This file is the answer to that rejection, not a
 * reversal of it: the ban is still not a contract, and the count is.
 *
 * ## How it works
 *
 * Each rule owns a map of `path -> count` seeded with today's real number, and
 * asserts the measured map equals it **exactly**. That is deliberate in both
 * directions:
 *
 * - Adding one fails the build. Debt cannot grow quietly.
 * - Removing one *also* fails, asking for the number to come down. A cleanup
 *   then shows up in the diff as `6` → `5` next to the change that earned it,
 *   which is the point: progress is legible in the history rather than being
 *   something you have to go and measure.
 *
 * The maps are sorted by debt descending, so each one doubles as a worklist in
 * priority order. Per file rather than per domain on purpose — a per-domain
 * total would let a new button in one file hide behind a deletion in its
 * neighbour, and the file-level number is what tells you whether a migration
 * finished a file or only visited it.
 *
 * ## How it ends
 *
 * A rule's budget reaching `{}` is the signal to move it into
 * `uiContracts.test.ts` as a real contract with an empty allowlist, and delete
 * it here. When both are gone, so is this file. If a count instead stalls above
 * zero because the remaining call sites are genuinely correct, that is not a
 * failure either — write the reason next to the entry and it becomes a
 * documented exception, which is more than the prose it replaced ever was.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/components";
const UI = join(ROOT, "ui");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(path);
  }
  return out;
}

/**
 * Same stripping as `uiContracts.test.ts`: comments and template literals go,
 * so a docstring quoting the pattern it forbids cannot fail its own rule. Both
 * files need it and neither exports it — duplicating six lines is cheaper than
 * a shared helper module that exists only to be imported twice, and this file
 * is meant to be deleted.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** Posix-separated, so the budgets read the same on Windows and in CI. */
const OUTSIDE_UI = walk(ROOT)
  .filter((p) => !p.startsWith(UI))
  .map((p) => p.split(/[\\/]/).join("/"));

/** Files with a non-zero count, as `path -> count`. Zeroes are omitted so an
 *  entry left behind by a finished migration fails rather than lingering. */
function census(count: (src: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of OUTSIDE_UI) {
    const n = count(code(file));
    if (n > 0) out[file] = n;
  }
  return out;
}

const total = (o: Record<string, number>) =>
  Object.values(o).reduce((a, b) => a + b, 0);

/**
 * Only the entries that moved, as `"budget -> measured"`.
 *
 * The assertion is on this rather than on the census itself because Vitest
 * abbreviates a diff between two 72-key objects to `{ …(72) }`, which tells you
 * a rule broke and nothing about where. Comparing deltas means the failure
 * output *is* the worklist: `{ "src/components/shell/StatusBar.tsx": "5 -> 6" }`.
 * A file missing from either side counts as zero, so a brand-new file with a
 * raw button and a finished migration's leftover entry both surface here.
 */
function delta(
  actual: Record<string, number>,
  budget: Record<string, number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(actual), ...Object.keys(budget)])) {
    const a = actual[key] ?? 0;
    const b = budget[key] ?? 0;
    if (a !== b) out[key] = `${b} -> ${a}`;
  }
  return out;
}

describe("raw <button> outside ui/", () => {
  /**
   * `IconButton` and `Button` exist so that a control's height, hover alpha,
   * focus ring and disabled treatment are decided once. Before them the app
   * had four hover alphas and three paddings across visually identical
   * buttons, and that is what these 138 remaining elements still are: each one
   * re-decides, in isolation, something the primitives already answer.
   *
   * Two examples of what the count is actually measuring, both found while
   * seeding it. `ConnectionsTree`'s "disconnect all" is a hand-rolled button
   * with `text-muted-foreground`, so the app's most destructive tree action
   * reads exactly like the refresh button beside it — while `IconButton`
   * already ships `tone="destructive"`, the API it wanted. `CellInput`'s
   * expand button paints an opaque `bg-background` patch (it has to; it is
   * `sticky`) resolved against a flat cell, which is the hairline seam that
   * shows when the cell underneath is focused and tinted.
   *
   * Counted as elements, not files: a file is not migrated until its last one
   * is gone, and only a per-element count can say how far in it is.
   *
   * **Not every entry is migratable, and `DocumentListView` is the worked
   * example.** Of its six, exactly one was chrome (the draft card's cancel) and
   * became an `IconButton`. The rest cannot, for two reasons worth writing down
   * before someone forces them through to make a number go down:
   *
   * - Three are not icon buttons at all. They render a glyph or a word — `∅`,
   *   the field's type name, "save" — and `IconButton` takes a `LucideIcon`.
   * - Two are inline affordances inside a field row, which is a flex line of
   *   monospace text at `leading-relaxed` whose `fontSize` is driven by the
   *   grid's Ctrl+wheel zoom. `IconButton`'s smallest shape is a fixed
   *   `h-6 w-6`; dropping one into that line pins the row height and **breaks
   *   the zoom**. The app has a real class of text-level actions that sit below
   *   the primitive layer's density floor, and the honest answer is that they
   *   are not buttons in the chrome sense rather than that `ui/` needs a
   *   sub-24px icon shape.
   *
   * So this budget stalls above zero, which is the case the header describes:
   * the reason lives next to the entry and the rule never graduates to a
   * contract. A number that would only go to zero by making the list view worse
   * is a number to stop pushing on.
   */
  const BUDGET: Record<string, number> = {
    "src/components/grid/CellPreview.tsx": 5,
    "src/components/shell/NotificationCard.tsx": 5,
    "src/components/shell/StatusBar.tsx": 5,
    "src/components/connection/dialogs/EnvironmentEditorDialog.tsx": 4,
    "src/components/grid/DocumentListView.tsx": 4,
    "src/components/pulse/PulseWindow.tsx": 4,
    "src/components/settings/sections/NotificationsSection.tsx": 4,
    "src/components/connection/ConnectionTreeRow.tsx": 3,
    "src/components/connection/dialogs/ConnectionDialog.tsx": 3,
    "src/components/connection/EnvironmentRail.tsx": 3,
    "src/components/connection/StatusConnections.tsx": 3,
    "src/components/grid/FkCombobox.tsx": 3,
    "src/components/schema/SchemaTableRow.tsx": 3,
    "src/components/settings/sections/ShortcutRow.tsx": 3,
    "src/components/shell/dialogs/DocsDialog.tsx": 3,
    "src/components/shell/TabSwitcher.tsx": 3,
    "src/components/shell/WorkspaceTab.tsx": 3,
    "src/components/common/VanishedEnvironmentNotice.tsx": 2,
    "src/components/common/VanishedOriginNotice.tsx": 2,
    "src/components/connection/ConnectionRailSection.tsx": 2,
    "src/components/connection/ConnectionsTree.tsx": 2,
    "src/components/connection/TreeFilterBox.tsx": 2,
    "src/components/grid/GridSearchInput.tsx": 2,
    "src/components/grid/ServerFilterChips.tsx": 2,
    "src/components/indexes/dialogs/IndexEditorDialog.tsx": 2,
    "src/components/pulse/PulsePanel.tsx": 2,
    "src/components/schema/dialogs/DatabaseVisibilityDialog.tsx": 2,
    "src/components/schema/StructureEditorTab.tsx": 2,
    "src/components/settings/sections/AppearanceSection.tsx": 2,
    "src/components/settings/sections/JsonSchemasSection.tsx": 2,
    "src/components/settings/sections/McpConnectionTree.tsx": 2,
    "src/components/settings/sections/PulseConnectionTree.tsx": 2,
    "src/components/shell/AppShell.tsx": 2,
    "src/components/shell/CommandPalette.tsx": 2,
    "src/components/shell/dialogs/WhatsNewDialog.tsx": 2,
    "src/components/shell/EmptyWatermark.tsx": 2,
    "src/components/shell/NotificationCenter.tsx": 2,
    "src/components/aggregation/AggregationTab.tsx": 1,
    "src/components/aggregation/StageCard.tsx": 1,
    "src/components/aggregation/StageRail.tsx": 1,
    "src/components/common/PasswordInput.tsx": 1,
    "src/components/connection/ConnectionRail.tsx": 1,
    "src/components/connection/dialogs/ConflictBulkActions.tsx": 1,
    "src/components/connection/dialogs/ConflictResolutionStep.tsx": 1,
    "src/components/connection/dialogs/ExportEnvironmentDialog.tsx": 1,
    "src/components/connection/dialogs/ExportProfilesDialog.tsx": 1,
    "src/components/connection/EnvironmentSwitcher.tsx": 1,
    "src/components/connection/GroupHeader.tsx": 1,
    "src/components/connection/WorkspacePicker.tsx": 1,
    "src/components/grid/CellInput.tsx": 1,
    "src/components/grid/DataGrid.tsx": 1,
    "src/components/grid/dialogs/CellEditor.tsx": 1,
    "src/components/grid/DraftRowView.tsx": 1,
    "src/components/jsonSchema/SchemaBindingBadge.tsx": 1,
    "src/components/origins/OriginEditorHeader.tsx": 1,
    "src/components/origins/OriginEditorOverlay.tsx": 1,
    "src/components/origins/sections/ConnectionsPane.tsx": 1,
    "src/components/origins/sections/EnvironmentsPane.tsx": 1,
    "src/components/query/Console.tsx": 1,
    "src/components/query/QueryEditorTab.tsx": 1,
    "src/components/schema/IndexesSectionHeader.tsx": 1,
    "src/components/schema/MultiDbExplorer.tsx": 1,
    "src/components/schema/SchemaTableSection.tsx": 1,
    "src/components/schema/SecurityTab.tsx": 1,
    "src/components/schema/SingleDbExplorer.tsx": 1,
    "src/components/settings/dialogs/CaptureShortcutDialog.tsx": 1,
    "src/components/settings/dialogs/SettingsDialog.tsx": 1,
    "src/components/settings/sections/ShortcutsSection.tsx": 1,
    "src/components/shell/ActivityBar.tsx": 1,
    "src/components/shell/ConsoleDock.tsx": 1,
    "src/components/shell/LayoutToggles.tsx": 1,
    "src/components/shell/UpdateBanner.tsx": 1,
  };

  it(`is down to ${136} in ${72} files`, () => {
    const measured = census(
      (src) => (src.match(/<button[\s/>]/g) || []).length,
    );
    expect(delta(measured, BUDGET)).toEqual({});
  });

  it("headline count only moves down", () => {
    expect(total(BUDGET)).toBeLessThanOrEqual(136);
  });
});

describe("the OS tooltip outside ui/", () => {
  /**
   * A native `title=` is the operating system's tooltip: its own delay, its own
   * look, no theme, and no coordination with the app's. `IconButton` omits
   * `title` from its props type to make that a compile error, and
   * `uiContracts.test.ts`'s rule H catches a `<Button size="icon" title=>`.
   * Neither reaches the 79 counted here.
   *
   * Rule H's shape is why: it fires only on `size="icon"`, so
   * `GridToolbar.tsx`'s `<Button size="sm" title={t("dataGrid.insertNewRow")}>`
   * — a labelled button showing an OS tooltip in the grid's main toolbar —
   * passes it cleanly. Widening rule H is not the fix, because a contract with
   * 79 violations cannot be merged; counting them is.
   *
   * **What counts.** A `title` that reaches the DOM: any lowercase (host) tag,
   * plus `Button` / `Switch` / `SelectTrigger`, which spread their props onto
   * one. A `title` prop on a component that renders it as *copy* — the heading
   * of `EmptyState`, `Panel`, `Section`, `NamePromptDialog`, `ConfirmDialog`,
   * `OverlayPalette` — is not a tooltip and is not counted; there were 43 of
   * those, and a rule that swept them in would be measuring nothing.
   *
   * **What is deliberately exempt.** `DropdownMenuItem` and `ContextMenuItem`.
   * `tooltip.tsx` documents the one place the OS tooltip is the correct choice:
   * inside open menu content, where a Radix tooltip fights the menu's own hover
   * and portal handling. Those are not debt, so they are not in the budget —
   * this is the "documented exception" the header describes, and it is why this
   * rule could not have been written as a contract even with the migration
   * finished.
   */
  const SPREADS_TO_DOM = new Set(["Button", "Switch", "SelectTrigger"]);

  const BUDGET: Record<string, number> = {
    "src/components/connection/ConnectionTreeRow.tsx": 8,
    "src/components/aggregation/StageCard.tsx": 4,
    "src/components/connection/EnvironmentSwitcher.tsx": 4,
    "src/components/grid/ServerFilterChips.tsx": 4,
    "src/components/pulse/PulseWindow.tsx": 4,
    "src/components/settings/sections/JsonSchemasSection.tsx": 4,
    "src/components/connection/StatusConnections.tsx": 3,
    "src/components/connection/TreeFilterBox.tsx": 3,
    "src/components/common/VanishedOriginNotice.tsx": 2,
    "src/components/connection/ConnectionRailRow.tsx": 2,
    "src/components/grid/CellPreview.tsx": 2,
    "src/components/grid/DocumentListView.tsx": 2,
    "src/components/grid/GridSearchInput.tsx": 2,
    "src/components/pulse/PulsePanel.tsx": 2,
    "src/components/query/QueryEditorTab.tsx": 2,
    "src/components/schema/StructureEditorTab.tsx": 2,
    "src/components/settings/sections/ShortcutRow.tsx": 2,
    "src/components/shell/TabSwitcher.tsx": 2,
    "src/components/grid/GridToolbar.tsx": 1,
    "src/components/common/DriverBadge.tsx": 1,
    "src/components/common/PasswordInput.tsx": 1,
    "src/components/common/VanishedEnvironmentNotice.tsx": 1,
    "src/components/connection/dialogs/EnvironmentEditorDialog.tsx": 1,
    "src/components/grid/dialogs/CellEditor.tsx": 1,
    "src/components/grid/DraftCellControl.tsx": 1,
    "src/components/grid/FkCombobox.tsx": 1,
    "src/components/grid/GridRow.tsx": 1,
    "src/components/grid/TableDataTab.tsx": 1,
    "src/components/jsonSchema/SchemaBindingBadge.tsx": 1,
    "src/components/origins/OriginEditorHeader.tsx": 1,
    "src/components/origins/sections/ConnectionsPane.tsx": 1,
    "src/components/origins/sections/EnvironmentsPane.tsx": 1,
    "src/components/origins/sections/SchemasPane.tsx": 1,
    "src/components/query/Console.tsx": 1,
    "src/components/schema/SchemaTableRow.tsx": 1,
    "src/components/settings/dialogs/CaptureShortcutDialog.tsx": 1,
    "src/components/settings/sections/McpConnectionTree.tsx": 1,
    "src/components/settings/sections/NotificationsSection.tsx": 1,
    "src/components/settings/sections/PulseConnectionTree.tsx": 1,
    "src/components/shell/WorkspaceTab.tsx": 1,
  };

  it(`is down to ${76} in ${40} files`, () => {
    const measured = census((src) => {
      let n = 0;
      for (const m of src.matchAll(/<([A-Za-z][\w.]*)\b([^>]*?)>/gs)) {
        const tag = m[1];
        if (!/\btitle=/.test(m[2])) continue;
        if (/^[a-z]/.test(tag) || SPREADS_TO_DOM.has(tag)) n++;
      }
      return n;
    });
    expect(delta(measured, BUDGET)).toEqual({});
  });

  it("headline count only moves down", () => {
    expect(total(BUDGET)).toBeLessThanOrEqual(76);
  });
});
