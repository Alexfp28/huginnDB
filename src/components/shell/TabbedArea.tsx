/**
 * Editor-style workspace: a nested dockview instance whose panels are the
 * open table-data and query-editor tabs. Splitting and dragging a tab to
 * another group come for free from dockview. "Float in new window"
 * (`WorkspaceTab.detachToWindow`) is deliberately NOT dockview's
 * `addFloatingGroup` — that keeps the floating panel confined to the inner
 * workspace's own bounds (see CLAUDE.md's floating-window session note). It
 * instead opens a real `WebviewWindow` via `open_tab_window` and removes the
 * tab from this store, so it can be dragged anywhere on the desktop; see
 * `DetachedTabWindow`.
 *
 * `useTabs` stays the single source of truth for *which* tabs exist and
 * which is active; the inner dockview is a view that we reconcile against
 * it (store → dockview for add/remove, both directions for the active
 * panel). Keeping the store authoritative means the per-connection
 * persistence in `persistedTabs.ts` — which derives its snapshot from
 * `useTabs` — keeps working untouched. The trade-off is that split geometry
 * lives only for the session: on restart, restored tabs come back in the
 * default tabbed arrangement.
 *
 * All tab removal flows through the store (the custom tab's close button
 * and middle-click call `useTabs.close`), so add/remove is strictly
 * unidirectional (store → dockview) and can't feed back on itself.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanelsTopLeft, Pin, PinOff, Plus, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTranslation } from "react-i18next";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabs } from "@/stores/session/tabs";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AppTab } from "@/types";
import { useUi } from "@/stores/session/ui";
import { usePreferences } from "@/stores/preferences/preferences";
import { useConnections } from "@/stores/session/connections";
import { useEnvironments } from "@/stores/session/environments";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useTabSwitcher } from "@/components/shell/TabSwitcher";
import { useCommandPalette } from "@/components/shell/CommandPalette";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { ConnectionDialog } from "@/components/connection/dialogs/ConnectionDialog";
import { getBinding, formatComboForDisplay } from "@/lib/keybindings";
import {
  resolveConnectionLabel,
  resolveConnectionDriver,
} from "@/lib/connectionLabel";
import { DriverBadge } from "@/components/common/DriverBadge";
import { TableDataTab } from "@/components/grid/TableDataTab";
import { QueryEditorTab } from "@/components/query/QueryEditorTab";
import { StructureEditorTab } from "@/components/schema/StructureEditorTab";
import { ViewEditorTab } from "@/components/schema/ViewEditorTab";
import { SecurityTab } from "@/components/schema/SecurityTab";
import { WorkspacePicker } from "@/components/connection/WorkspacePicker";
import {
  huginnDockviewThemeInner,
  registerInnerDockviewApi,
  clearInnerDockviewApi,
  consumePendingInternalLayout,
  syncTabPanels,
} from "@/lib/dockview";
import { scheduleSaveActive } from "@/stores/session/persistedTabs";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import type { TabAccentStyle } from "@/types";

interface Props {
  connectionId: string | null;
}

/** Params carried on each dockview panel, mirroring the `AppTab` payload. */
interface TablePanelParams {
  connectionId: string;
  schema?: string;
  table: string;
}
interface QueryPanelParams {
  tabId: string;
  connectionId: string;
}
interface StructurePanelParams {
  tabId: string;
  connectionId: string;
  schema?: string;
  table?: string;
  mode: "new" | "edit";
}
interface ViewPanelParams {
  tabId: string;
  connectionId: string;
  schema?: string;
  view?: string;
  mode: "new" | "edit";
}

// ---------------------------------------------------------------------------
// Panel bodies — read their identity from the panel params and delegate to
// the existing feature components. Each panel keeps its own mounted React
// tree for the lifetime of the tab, so switching tabs no longer resets a
// table's filter draft or a query editor's scroll position.
// ---------------------------------------------------------------------------

function TablePanel(props: IDockviewPanelProps<TablePanelParams>) {
  const { connectionId, schema, table } = props.params;
  // The dockview panel id is the tab id (see the reconciler's addPanel call),
  // so we can key the grid-selection report off it without a new param.
  return (
    <TableDataTab
      tabId={props.api.id}
      connectionId={connectionId}
      schema={schema}
      table={table}
    />
  );
}

function QueryPanel(props: IDockviewPanelProps<QueryPanelParams>) {
  const { tabId, connectionId } = props.params;
  return <QueryEditorTab tabId={tabId} connectionId={connectionId} />;
}

function SecurityPanel(props: IDockviewPanelProps<QueryPanelParams>) {
  const { tabId, connectionId } = props.params;
  return <SecurityTab tabId={tabId} connectionId={connectionId} />;
}

function StructurePanel(props: IDockviewPanelProps<StructurePanelParams>) {
  const { tabId, connectionId, schema, table, mode } = props.params;
  return (
    <StructureEditorTab
      tabId={tabId}
      connectionId={connectionId}
      schema={schema}
      table={table}
      mode={mode}
    />
  );
}

function ViewPanel(props: IDockviewPanelProps<ViewPanelParams>) {
  const { tabId, connectionId, schema, view, mode } = props.params;
  return (
    <ViewEditorTab
      tabId={tabId}
      connectionId={connectionId}
      schema={schema}
      view={view}
      mode={mode}
    />
  );
}

const INNER_COMPONENTS = {
  table: TablePanel,
  query: QueryPanel,
  structure: StructurePanel,
  view: ViewPanel,
  security: SecurityPanel,
};

// ---------------------------------------------------------------------------
// Custom tab header — replaces dockview's default tab so we own the label
// (with a connection prefix when tabs span multiple connections), the
// tooltip, and the close affordances (X button + middle-click).
// ---------------------------------------------------------------------------

/** Preset swatches offered in the tab colour picker (issue #24). Explicit hex
 *  so a user's chosen colour is stable regardless of theme. */
const TAB_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#0ea5e9",
  "#a855f7",
  "#ec4899",
];

/** Box-shadow for a per-tab custom colour, on the same edge as the active-tab
 *  accent rule in `index.css` for the given `tabAccentStyle` — so the two
 *  never compete for opposite sides of the tab. "boxed" uses the elevation
 *  shadow for the *default* brand accent, so a custom colour there draws a
 *  bottom-edge underline instead of fighting over the same box-shadow slot. */
function accentBoxShadow(style: TabAccentStyle, color: string): string {
  switch (style) {
    case "rail":
      return `inset 3px 0 0 0 ${color}`;
    case "boxed":
      return `inset 0 -2px 0 0 ${color}`;
    case "cap":
    default:
      return `inset 0 2px 0 0 ${color}`;
  }
}

/**
 * Custom equality for `WorkspaceTab`'s `tabs` subscription: only the fields
 * this component's render actually depends on (id/connectionId/kind/title
 * for the label + collision check, color/pinned for the accent + pin icon).
 * `useTabs` mutates `tabs` immutably on EVERY store action — including
 * `setViewState`, which `TableDataTab` fires on nearly every filter/sort/
 * search change — so a bare reference-equality subscription re-rendered
 * every open tab's header on every keystroke-driven query elsewhere, not
 * just on tab open/close/rename. Comparing by these fields instead means a
 * `viewState`/`initialFilters` change on some other tab no longer touches
 * this one.
 */
function tabsRelevantEqual(a: AppTab[], b: AppTab[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.connectionId !== y.connectionId ||
      x.kind !== y.kind ||
      x.title !== y.title ||
      x.color !== y.color ||
      x.pinned !== y.pinned
    ) {
      return false;
    }
  }
  return true;
}

function WorkspaceTab(props: IDockviewPanelHeaderProps) {
  const { t } = useTranslation();
  const id = props.api.id;
  const tabs = useStoreWithEqualityFn(
    useTabs,
    (s) => s.tabs,
    tabsRelevantEqual,
  );
  // Derive active state from the store (the source of truth), NOT from
  // `props.api.isActive`: dockview does not re-render this custom tab on an
  // active-panel change, so reading `isActive` at render time goes stale and
  // the highlight never moves when you switch tabs. Subscribing to `activeId`
  // forces the re-render and keeps both tabs' styling in sync.
  const isActive = useTabs((s) => s.activeId === id);
  const profiles = useConnections((s) => s.profiles);

  const { label, tooltip, driver } = useMemo(() => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return { label: id, tooltip: id, driver: undefined };

    // Prefix the connection/database context whenever it's needed to tell tabs
    // apart: either more than one connection is in play, or another open tab
    // carries the same bare title (the same table opened on two connections /
    // databases — issue #22, where both rendered as an identical bare name). A
    // lone tab, or unique titles on a single connection, stay bare. The driver
    // badge (rendered unconditionally, see below) already gives every tab a
    // permanent visual anchor to its connection, so this text prefix is only
    // needed for the disambiguation cases, not as the primary "which
    // connection" cue anymore.
    const distinctConnections = new Set(tabs.map((x) => x.connectionId)).size;
    const titleCollision =
      tabs.filter((x) => x.kind === tab.kind && x.title === tab.title).length > 1;
    const showConn = distinctConnections > 1 || titleCollision;
    const connName = resolveConnectionLabel(profiles, tab.connectionId);
    return {
      label: showConn ? `${connName} · ${tab.title}` : tab.title,
      tooltip:
        tab.kind === "table"
          ? `${connName} / ${tab.schema ?? ""}${tab.schema ? "." : ""}${tab.table ?? ""}`
          : `${connName} / ${tab.title}`,
      driver: resolveConnectionDriver(profiles, tab.connectionId),
    };
  }, [tabs, profiles, id]);

  const thisTab = tabs.find((tb) => tb.id === id);
  // User-assigned tab colour (issue #24), rendered as an inset accent whose
  // edge follows `tabAccentStyle` (issue #35) — see `accentBoxShadow`.
  const tabColor = thisTab?.color;
  const tabAccentStyle = usePreferences((s) => s.prefs.ui.tabAccentStyle);
  const isPinned = !!thisTab?.pinned;

  // Route closing through the store so the reconciler does the actual panel
  // removal — keeps add/remove strictly store → dockview.
  const requestClose = () => useTabs.getState().close(id);
  const closeOthers = () => useTabs.getState().closeOthers(id);
  const closeToRight = () => useTabs.getState().closeToRight(id);
  const closeOthersInConnection = () =>
    useTabs.getState().closeOthersInConnection(id);
  const closeAll = () => useTabs.getState().closeAll();
  const setColor = (color: string | null) =>
    useTabs.getState().setColor(id, color);
  const togglePin = () => useTabs.getState().setPinned(id, !isPinned);
  // Pop this tab out into a real, independent OS window (see
  // `open_tab_window` / `DetachedTabWindow`) — unlike dockview's
  // `addFloatingGroup`, it isn't confined to the inner workspace's bounds
  // and can be dragged anywhere on the desktop. Closing that window is the
  // whole story for this tab, so it's removed from this window right away
  // rather than waiting for a close signal that never comes back.
  const detachToWindow = async () => {
    if (!thisTab) return;
    try {
      await api.openTabWindow(thisTab, label);
      useTabs.getState().close(id);
    } catch (e) {
      console.error("Failed to open detached tab window:", e);
    }
  };
  const hasOthers = tabs.length > 1;
  // Whether another tab of this connection exists (gates "close others in
  // this connection").
  const hasOthersInConnection =
    !!thisTab &&
    tabs.some((tb) => tb.id !== id && tb.connectionId === thisTab.connectionId);

  // Keep the active tab fully in view. dockview appends a newly-opened tab at
  // the end of the strip and can leave it clipped behind the right-hand
  // actions (the overflow ∨, the tab-switcher button, "+"), so an active tab
  // you just opened isn't visible. Scroll it into the scrollable tab list
  // whenever it becomes active; the rAF defers past dockview's panel-add
  // layout so the tab has its real width when we measure. `block: "nearest"`
  // keeps it from nudging any vertical scroll.
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isActive) return;
    const raf = requestAnimationFrame(() => {
      tabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
    return () => cancelAnimationFrame(raf);
  }, [isActive]);

  return (
    <ContextMenu>
      <SimpleTooltip label={tooltip} side="bottom">
      <ContextMenuTrigger asChild>
    <div
      ref={tabRef}
      className={cn(
        "group/tab flex h-full items-center gap-2 px-3 text-xs",
        // The active tab already carries a bg-background surface + a 2px brand
        // top cap from index.css (`.inner-dock .dv-active-tab`); here we add the
        // matching weight so the label reads as the active one too.
        isActive
          ? "font-medium text-foreground"
          : "text-muted-foreground/70",
      )}
      style={
        tabColor
          ? { boxShadow: accentBoxShadow(tabAccentStyle, tabColor) }
          : undefined
      }
      // Middle-click (wheel button) closes the tab, matching editor
      // conventions. `mousedown` preventDefault suppresses the browser's
      // middle-click autoscroll affordance.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          requestClose();
        }
      }}
    >
      {driver && <DriverBadge driver={driver} />}
      {isPinned && (
        <Pin className="h-3 w-3 shrink-0 -rotate-45 text-brand" />
      )}
      <span className="max-w-[220px] truncate">{label}</span>
      {/*
       * No explicit action menu here anymore — every action below (split,
       * float, colour, close variants) lives in the right-click context menu
       * on this same tab (see `ContextMenuContent` below). Drag-to-split
       * still works natively.
       */}
      <SimpleTooltip label={t("tabs.closeTab")} side="bottom">
        <button
          className={cn(
            "rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive",
            isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
          onClick={(e) => {
            e.stopPropagation();
            requestClose();
          }}
          // Same drag-suppression as the menu trigger.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </SimpleTooltip>
    </div>
      </ContextMenuTrigger>
      </SimpleTooltip>
      <ContextMenuContent className="text-xs">
        <ContextMenuItem onSelect={togglePin}>
          {isPinned ? (
            <PinOff className="mr-2 h-3.5 w-3.5" />
          ) : (
            <Pin className="mr-2 h-3.5 w-3.5" />
          )}
          {isPinned ? t("tabs.unpin") : t("tabs.pin")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            props.api.moveTo({ group: props.api.group, position: "right" })
          }
        >
          {t("tabs.splitRight")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            props.api.moveTo({ group: props.api.group, position: "bottom" })
          }
        >
          {t("tabs.splitDown")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={detachToWindow}>
          {t("tabs.floatPanel")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <div className="px-2 py-1.5">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t("tabs.color")}
          </div>
          <div className="flex items-center gap-1">
            {TAB_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-110",
                  tabColor === c &&
                    "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
                )}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
            <button
              type="button"
              onClick={() => setColor(null)}
              className={cn(
                "flex h-4 w-4 items-center justify-center rounded-full border border-border/50 text-muted-foreground hover:bg-accent",
                !tabColor &&
                  "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
              )}
              title={t("tabs.colorNone")}
            >
              <X className="h-2.5 w-2.5" />
            </button>
            <input
              type="color"
              value={tabColor ?? "#888888"}
              onChange={(e) => setColor(e.target.value)}
              className="h-4 w-6 cursor-pointer rounded border border-border/50 bg-transparent p-0"
              title={t("tabs.colorCustom")}
            />
          </div>
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={requestClose}>
          {t("tabs.closeTab")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onSelect={closeOthers}>
          {t("tabs.closeOthers")}
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasOthers} onSelect={closeToRight}>
          {t("tabs.closeToRight")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasOthersInConnection}
          onSelect={closeOthersInConnection}
        >
          {t("tabs.closeOthersInConnection")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={closeAll}>
          {t("tabs.closeAll")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Per-group right-slot actions: a button that lists all open tabs (the
 *  overflow / quick-switch affordance, with a live count) plus the "+" that
 *  opens a fresh query tab on the selected connection. */
function NewTabAction(_props: IDockviewHeaderActionsProps) {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  const tabCount = useTabs((s) => s.tabs.length);
  return (
    <div className="flex items-center gap-0.5 pr-1">
      <SimpleTooltip label={t("tabSwitcher.tooltip")} side="bottom">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={tabCount === 0}
          onClick={() => useTabSwitcher.getState().setOpen(true)}
        >
          <PanelsTopLeft className="h-3.5 w-3.5" />
          <span className="text-2xs tabular-nums">{tabCount}</span>
        </Button>
      </SimpleTooltip>
      <SimpleTooltip label={t("tabs.newQueryTooltip")} side="bottom">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-brand"
          disabled={!connectionId}
          onClick={() => {
            if (!connectionId) return;
            useTabs.getState().open({
              kind: "query",
              title: t("tabs.queryFileName"),
              connectionId: useTabs.getState().queryTargetFor(connectionId),
              query: "-- write a SQL query and press Ctrl+Enter\n",
            });
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </SimpleTooltip>
    </div>
  );
}

/** Small monospace key-cap, matching the shortcut style in `ShortcutRow`. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * Empty-state screen shown when no tabs are open.
 *
 * It used to be a logo, a line of text and a "New query" button floating
 * below the workspace picker (#110) with no relation to each other, plus a
 * lot of dead space on wide windows — the reported inconsistency. This
 * composes the same pieces (hero, hint, picker) into one column with a
 * shared visual frame: the "new query" action now sits inline with the hint
 * it belongs to instead of hanging on its own underneath, the picker gets a
 * console-style card so it reads as the deliberate focal panel rather than a
 * loose block, and a subtle dot-grid + brand glow fills the backdrop instead
 * of leaving flat empty space. A fresh install (no profiles, no picker to
 * show) now gets an actual "New connection" call to action instead of just
 * static hint text — previously the least useful screen in the app at the
 * moment you most need a way in. The keyboard-shortcut footer reads the
 * user's live rebindings (`getBinding`), never hardcoded combos, and doubles
 * as a real trigger for the command palette / preferences.
 */
function EmptyWatermark() {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  const hasProfiles = useConnections((s) => s.profiles.length > 0);
  const environments = useEnvironments((s) => s.environments);
  // Same guard as `WorkspacePicker` itself (gotcha #8) — a secondary window
  // never owns an environment, so switching is hidden there.
  const showEnvironments =
    getCurrentWindow().label === "main" && environments.length > 1;
  const showPicker = hasProfiles || showEnvironments;

  const [connDialogOpen, setConnDialogOpen] = useState(false);
  const togglePalette = useCommandPalette((s) => s.toggle);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const paletteCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleCommandPalette"),
  );
  const settingsCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "openSettings"),
  );

  function openNewQuery() {
    if (!connectionId) return;
    useTabs.getState().open({
      kind: "query",
      title: t("tabs.queryFileName"),
      connectionId: useTabs.getState().queryTargetFor(connectionId),
      query: "-- write a SQL query and press Ctrl+Enter\n",
    });
  }

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            maskImage:
              "radial-gradient(ellipse 60% 55% at 50% 32%, black 0%, transparent 75%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 60% 55% at 50% 32%, black 0%, transparent 75%)",
          }}
        />
        <div className="absolute left-1/2 top-[-140px] h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-brand/10 blur-[110px]" />
      </div>

      <div className="relative z-10 flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-7 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="relative">
            <div className="absolute inset-0 -z-10 scale-125 rounded-2xl bg-brand/15 blur-xl" />
            <img
              src="/image/huginn-app-icon.svg"
              alt="HuginnDB"
              className="h-14 w-14"
              draggable={false}
            />
          </div>
          <div className="font-mono text-xl font-semibold tracking-tight text-foreground">
            huginndb<span className="text-brand">_</span>
          </div>
          {!showPicker && (
            <p className="max-w-xs text-sm text-muted-foreground">
              {t("tabs.emptyConnectFirst")}
            </p>
          )}
        </div>

        {showPicker ? (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2.5 rounded-full border border-border/70 bg-card/60 py-1.5 pl-4 pr-1.5 text-sm text-muted-foreground">
              <span>
                {connectionId
                  ? t("tabs.emptyOpenSomething")
                  : t("tabs.emptyConnectFirst")}
              </span>
              {connectionId && (
                <Button
                  size="sm"
                  className="h-7 gap-1.5 rounded-full px-3"
                  onClick={openNewQuery}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("tabs.newQuery")}
                </Button>
              )}
            </div>

            <div className="w-full rounded-2xl border border-border/70 bg-card/50 p-5 shadow-sm">
              <WorkspacePicker />
            </div>
          </>
        ) : (
          <Button className="gap-1.5" onClick={() => setConnDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("menu.file.newConnection")}
          </Button>
        )}
      </div>

      <div className="relative z-10 flex items-center gap-5 pb-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => togglePalette()}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground"
        >
          <Kbd>{formatComboForDisplay(paletteCombo)}</Kbd>
          {t("commandPalette.title")}
        </button>
        <button
          type="button"
          onClick={() => openSettings()}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 hover:text-foreground"
        >
          <Kbd>{formatComboForDisplay(settingsCombo)}</Kbd>
          {t("settings.title")}
        </button>
      </div>

      <ConnectionDialog
        open={connDialogOpen}
        onOpenChange={setConnDialogOpen}
        initial={null}
      />
    </div>
  );
}

export function TabbedArea(_props: Props) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const tabAccentStyle = usePreferences((s) => s.prefs.ui.tabAccentStyle);
  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
    registerInnerDockviewApi(event.api);

    // If hydration ran before this dockview mounted, it stashed the saved
    // split/float geometry. Rebuild it now: `fromJSON` recreates the panels
    // (with the params we stored at addPanel) AND the group/pane geometry, so
    // it is the authoritative layout restore. The reconciler effect below
    // then runs as an idempotent verification pass (panels already present →
    // nothing added; orphans → removed). Guarded like `restoreOrInitLayout`:
    // on any drift (a dropped oversize tab, schema change) we swallow the
    // error and let the reconciler build the default tabbed layout instead —
    // this preserves the old "comes back tabbed" safety behaviour.
    const pending = consumePendingInternalLayout();
    if (pending) {
      try {
        event.api.fromJSON(pending as Parameters<DockviewApi["fromJSON"]>[0]);
      } catch (err) {
        console.warn("Failed to restore inner workspace layout:", err);
      }
    }

    // User clicking a tab (or dockview activating one after a removal)
    // flows back into the store so the active body and status bar agree.
    event.api.onDidActivePanelChange((panel) => {
      if (panel) useTabs.getState().setActive(panel.id);
    });

    // A pure split/float/resize gesture touches no tab or schema state, so
    // nothing else schedules a save for it — without this, split geometry
    // could go unpersisted until an unrelated tab edit happened to trigger
    // one (see issue #80).
    event.api.onDidLayoutChange(() => scheduleSaveActive());
  };

  // Clear the inner-dockview singleton on unmount so a stale handle from a
  // previous workspace can't be captured/restored against.
  useEffect(() => {
    return () => {
      if (api) clearInnerDockviewApi(api);
    };
  }, [api]);

  // Reconcile the dockview panels with the store: add panels for new tabs,
  // remove panels for closed ones. This is the only place panels are
  // added/removed during ordinary use, so the flow is strictly store →
  // dockview. `hydrateWorkspaceLayout` (environment switch) also drives panel
  // creation directly, via the same `syncTabPanels` helper — see its comment
  // for why that path can't just wait for this effect to converge.
  useEffect(() => {
    if (!api) return;
    syncTabPanels(api, tabs);
  }, [api, tabs]);

  // Mirror the store's active tab into dockview (e.g. when a tab is opened
  // from the schema explorer). `setActive` on the already-active panel is a
  // no-op, so this can't ping-pong with `onDidActivePanelChange`.
  useEffect(() => {
    if (!api || !activeId) return;
    const panel = api.getPanel(activeId);
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [api, activeId]);

  // Ease sibling panels into their new size when a drag-drop finishes,
  // instead of the instant jump dockview does by default (see the
  // `.dv-animate-resize` rule in index.css for why the class lives on this
  // root and not deeper). A *capture*-phase listener on the root fires
  // before dockview's own `drop` handler (registered directly on each
  // group's content element, bubble-phase — see dockview-core's
  // `DragAndDropObserver`), so the transition is already active by the time
  // dockview mutates the `.dv-view` sizes and has an old value to animate
  // from. Scoped to the native `drop` event specifically: a manual sash
  // drag never fires it, so interactive resizing is unaffected.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let clearTimer: number | undefined;
    const onDropCapture = () => {
      root.classList.add("dv-animate-resize");
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        root.classList.remove("dv-animate-resize");
      }, 260);
    };
    root.addEventListener("drop", onDropCapture, { capture: true });
    return () => {
      root.removeEventListener("drop", onDropCapture, { capture: true });
      window.clearTimeout(clearTimer);
    };
  }, []);

  return (
    // Explicit positioned, full-size wrapper. The nested DockviewReact root
    // itself is `height/width: 100%`, but it also creates a shell element
    // sized via ResizeObserver and absolutely-positioned drag overlays, so
    // we make sure the box it lives in is unambiguously sized and a
    // positioned ancestor — otherwise the overlays anchor against an outer
    // dockview's shell and the vertical layout collapses on the first split.
    <div
      ref={rootRef}
      className="inner-dock relative h-full w-full"
      data-tab-accent={tabAccentStyle}
    >
      <DockviewReact
        components={INNER_COMPONENTS}
        defaultTabComponent={WorkspaceTab}
        watermarkComponent={EmptyWatermark}
        rightHeaderActionsComponent={NewTabAction}
        onReady={onReady}
        theme={huginnDockviewThemeInner}
      />
    </div>
  );
}
