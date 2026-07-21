/**
 * Editor-style workspace: a nested dockview instance whose panels are the
 * open table-data and query-editor tabs. Splitting, dragging a tab to
 * another group, and tearing one out into a floating window all come for
 * free from dockview.
 *
 * `useTabs` stays the single source of truth for *which* tabs exist and
 * which is active; the inner dockview is a view that we reconcile against
 * it (store → dockview for add/remove, both directions for the active
 * panel). Keeping the store authoritative means the per-connection
 * persistence in `persistedTabs.ts` — which derives its snapshot from
 * `useTabs` — keeps working untouched. The trade-off is that split/float
 * geometry lives only for the session: on restart, restored tabs come
 * back in the default tabbed arrangement.
 *
 * All tab removal flows through the store (the custom tab's close button
 * and middle-click call `useTabs.close`), so add/remove is strictly
 * unidirectional (store → dockview) and can't feed back on itself.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MoreVertical,
  PanelsTopLeft,
  Pin,
  PinOff,
  Plus,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
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
import { useTabs } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { usePreferences } from "@/stores/preferences";
import { useConnections } from "@/stores/connections";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useTabSwitcher } from "@/components/TabSwitcher";
import { resolveConnectionLabel } from "@/lib/connectionLabel";
import { TableDataTab } from "@/components/TableDataTab";
import { QueryEditorTab } from "@/components/QueryEditorTab";
import { StructureEditorTab } from "@/components/StructureEditorTab";
import { SecurityTab } from "@/components/SecurityTab";
import {
  huginnDockviewThemeInner,
  registerInnerDockviewApi,
  clearInnerDockviewApi,
  consumePendingInternalLayout,
} from "@/lib/dockview";
import { scheduleSaveActive } from "@/stores/persistedTabs";
import { cn } from "@/lib/utils";
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

const INNER_COMPONENTS = {
  table: TablePanel,
  query: QueryPanel,
  structure: StructurePanel,
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

function WorkspaceTab(props: IDockviewPanelHeaderProps) {
  const { t } = useTranslation();
  const id = props.api.id;
  const tabs = useTabs((s) => s.tabs);
  // Derive active state from the store (the source of truth), NOT from
  // `props.api.isActive`: dockview does not re-render this custom tab on an
  // active-panel change, so reading `isActive` at render time goes stale and
  // the highlight never moves when you switch tabs. Subscribing to `activeId`
  // forces the re-render and keeps both tabs' styling in sync.
  const isActive = useTabs((s) => s.activeId === id);
  const profiles = useConnections((s) => s.profiles);

  const { label, tooltip } = useMemo(() => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return { label: id, tooltip: id };

    // Prefix the connection/database context whenever it's needed to tell tabs
    // apart: either more than one connection is in play, or another open tab
    // carries the same bare title (the same table opened on two connections /
    // databases — issue #22, where both rendered as an identical bare name). A
    // lone tab, or unique titles on a single connection, stay bare.
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
      {isPinned && (
        <Pin className="h-3 w-3 shrink-0 -rotate-45 text-brand" />
      )}
      <span className="max-w-[220px] truncate">{label}</span>
      {/*
       * Explicit action menu (⋮). Drag-to-split should work natively, but
       * we surface the actions here as a reliable affordance — discoverable
       * for new users, and a working fallback if a webview quirk makes the
       * native drag drop overlay flaky in a nested dockview.
       */}
      <DropdownMenu>
        <SimpleTooltip label={t("tabs.actionsTooltip")} side="bottom">
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                // Reveal on hover AND on keyboard focus (focus-within on the
                // tab, or the button itself receiving focus) so the close/menu
                // actions aren't mouse-only.
                isActive
                  ? "opacity-100"
                  : "opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
              )}
              onClick={(e) => e.stopPropagation()}
              // Don't let dockview start a tab drag from the menu trigger.
              onMouseDown={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem onClick={togglePin}>
            {isPinned ? (
              <PinOff className="mr-2 h-3.5 w-3.5" />
            ) : (
              <Pin className="mr-2 h-3.5 w-3.5" />
            )}
            {isPinned ? t("tabs.unpin") : t("tabs.pin")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/*
           * Splits require a reference `group` — `panel.api.moveTo` silently
           * coerces `position` to `'center'` when `group` is undefined
           * (see dockviewPanelApi.js → DockviewPanelApiImpl.moveTo), which
           * is why a previous version of these handlers was a no-op.
           * Passing the panel's own group makes dockview create a new group
           * adjacent to it at the requested position.
           */}
          <DropdownMenuItem
            onClick={() =>
              props.api.moveTo({ group: props.api.group, position: "right" })
            }
          >
            {t("tabs.splitRight")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              props.api.moveTo({ group: props.api.group, position: "bottom" })
            }
          >
            {t("tabs.splitDown")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              const panel = props.containerApi.getPanel(id);
              if (panel) props.containerApi.addFloatingGroup(panel);
            }}
          >
            {t("tabs.floatPanel")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
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
              {/* Free-form colour, beyond the preset swatches (issue #35). A
                  rectangle (vs. the presets' circles) signals "custom". */}
              <input
                type="color"
                value={tabColor ?? "#888888"}
                onChange={(e) => setColor(e.target.value)}
                className="h-4 w-6 cursor-pointer rounded border border-border/50 bg-transparent p-0"
                title={t("tabs.colorCustom")}
              />
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={requestClose}>
            {t("tabs.closeTab")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasOthers} onClick={closeOthers}>
            {t("tabs.closeOthers")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasOthers} onClick={closeToRight}>
            {t("tabs.closeToRight")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!hasOthersInConnection}
            onClick={closeOthersInConnection}
          >
            {t("tabs.closeOthersInConnection")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={closeAll}>
            {t("tabs.closeAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
        <ContextMenuItem
          onSelect={() => {
            const panel = props.containerApi.getPanel(id);
            if (panel) props.containerApi.addFloatingGroup(panel);
          }}
        >
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
              connectionId,
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

/** Empty-state watermark shown when no tabs are open. */
function EmptyWatermark() {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <img
        src="/image/huginn-app-icon.svg"
        alt="HuginnDB"
        className="mb-1 h-16 w-16 opacity-90"
        draggable={false}
      />
      <div className="font-mono text-lg font-semibold text-foreground">
        huginndb
      </div>
      <div>
        {connectionId
          ? t("tabs.emptyOpenSomething")
          : t("tabs.emptyConnectFirst")}
      </div>
      {connectionId && (
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            useTabs.getState().open({
              kind: "query",
              title: t("tabs.queryFileName"),
              connectionId,
              query: "-- write a SQL query and press Ctrl+Enter\n",
            })
          }
        >
          {t("tabs.newQuery")}
        </Button>
      )}
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
  // added/removed, so the flow is strictly store → dockview.
  useEffect(() => {
    if (!api) return;
    for (const tab of tabs) {
      if (api.getPanel(tab.id)) continue;
      let params: Record<string, unknown>;
      if (tab.kind === "table") {
        params = {
          connectionId: tab.connectionId,
          schema: tab.schema,
          table: tab.table,
        };
      } else if (tab.kind === "structure") {
        params = {
          tabId: tab.id,
          connectionId: tab.connectionId,
          schema: tab.schema,
          table: tab.table,
          mode: tab.structureMode ?? "edit",
        };
      } else {
        params = { tabId: tab.id, connectionId: tab.connectionId };
      }
      api.addPanel({
        id: tab.id,
        component: tab.kind,
        params,
      });
    }
    const live = new Set(tabs.map((t) => t.id));
    for (const panel of api.panels) {
      if (!live.has(panel.id)) api.removePanel(panel);
    }
  }, [api, tabs]);

  // Mirror the store's active tab into dockview (e.g. when a tab is opened
  // from the schema explorer). `setActive` on the already-active panel is a
  // no-op, so this can't ping-pong with `onDidActivePanelChange`.
  useEffect(() => {
    if (!api || !activeId) return;
    const panel = api.getPanel(activeId);
    if (panel && !panel.api.isActive) panel.api.setActive();
  }, [api, activeId]);

  return (
    // Explicit positioned, full-size wrapper. The nested DockviewReact root
    // itself is `height/width: 100%`, but it also creates a shell element
    // sized via ResizeObserver and absolutely-positioned drag overlays, so
    // we make sure the box it lives in is unambiguously sized and a
    // positioned ancestor — otherwise the overlays anchor against an outer
    // dockview's shell and the vertical layout collapses on the first split.
    <div className="inner-dock relative h-full w-full" data-tab-accent={tabAccentStyle}>
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
