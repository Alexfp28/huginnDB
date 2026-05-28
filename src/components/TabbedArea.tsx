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

import { useEffect, useMemo, useState } from "react";
import { MoreVertical, Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
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
import { useConnections } from "@/stores/connections";
import { Button } from "@/components/ui/button";
import { TableDataTab } from "@/components/TableDataTab";
import { QueryEditorTab } from "@/components/QueryEditorTab";
import { huginnDockviewTheme } from "@/lib/dockview";
import { cn } from "@/lib/utils";

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

// ---------------------------------------------------------------------------
// Panel bodies — read their identity from the panel params and delegate to
// the existing feature components. Each panel keeps its own mounted React
// tree for the lifetime of the tab, so switching tabs no longer resets a
// table's filter draft or a query editor's scroll position.
// ---------------------------------------------------------------------------

function TablePanel(props: IDockviewPanelProps<TablePanelParams>) {
  const { connectionId, schema, table } = props.params;
  return (
    <TableDataTab connectionId={connectionId} schema={schema} table={table} />
  );
}

function QueryPanel(props: IDockviewPanelProps<QueryPanelParams>) {
  const { tabId, connectionId } = props.params;
  return <QueryEditorTab tabId={tabId} connectionId={connectionId} />;
}

const INNER_COMPONENTS = {
  table: TablePanel,
  query: QueryPanel,
};

// ---------------------------------------------------------------------------
// Custom tab header — replaces dockview's default tab so we own the label
// (with a connection prefix when tabs span multiple connections), the
// tooltip, and the close affordances (X button + middle-click).
// ---------------------------------------------------------------------------

function WorkspaceTab(props: IDockviewPanelHeaderProps) {
  const { t } = useTranslation();
  const id = props.api.id;
  const tabs = useTabs((s) => s.tabs);
  const profiles = useConnections((s) => s.profiles);

  const { label, tooltip } = useMemo(() => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return { label: id, tooltip: id };

    const profileById = new Map(profiles.map((p) => [p.id, p.name]));
    // Synthetic multi-DB ids look like `<parentId>::db::<db>`; resolve the
    // parent's display name and append the database (see open_database_view).
    const resolveConn = (cid: string): string => {
      const direct = profileById.get(cid);
      if (direct) return direct;
      const sep = cid.indexOf("::db::");
      if (sep > 0) {
        const parent = profileById.get(cid.slice(0, sep));
        const db = cid.slice(sep + "::db::".length);
        if (parent) return `${parent} · ${db}`;
      }
      return cid;
    };

    const showConn = new Set(tabs.map((x) => x.connectionId)).size > 1;
    const connName = resolveConn(tab.connectionId);
    return {
      label: showConn ? `${connName} · ${tab.title}` : tab.title,
      tooltip:
        tab.kind === "table"
          ? `${connName} / ${tab.schema ?? ""}${tab.schema ? "." : ""}${tab.table ?? ""}`
          : `${connName} / ${tab.title}`,
    };
  }, [tabs, profiles, id]);

  // Route closing through the store so the reconciler does the actual panel
  // removal — keeps add/remove strictly store → dockview.
  const requestClose = () => useTabs.getState().close(id);

  return (
    <div
      className={cn(
        "group/tab flex h-full items-center gap-2 px-3 text-xs",
        props.api.isActive ? "text-foreground" : "text-muted-foreground/70",
      )}
      title={tooltip}
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
      <span className="max-w-[220px] truncate">{label}</span>
      {/*
       * Explicit action menu (⋮). Drag-to-split should work natively, but
       * we surface the actions here as a reliable affordance — discoverable
       * for new users, and a working fallback if a webview quirk makes the
       * native drag drop overlay flaky in a nested dockview.
       */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "transition-opacity",
              props.api.isActive
                ? "opacity-60 hover:opacity-100"
                : "opacity-0 group-hover/tab:opacity-60 group-hover/tab:hover:opacity-100",
            )}
            onClick={(e) => e.stopPropagation()}
            // Don't let dockview start a tab drag from the menu trigger.
            onMouseDown={(e) => e.stopPropagation()}
            title={t("tabs.actionsTooltip")}
          >
            <MoreVertical className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem
            onClick={() => props.api.moveTo({ position: "right" })}
          >
            {t("tabs.splitRight")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => props.api.moveTo({ position: "bottom" })}
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
          <DropdownMenuItem onClick={requestClose}>
            {t("tabs.closeTab")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        className={cn(
          "transition-opacity",
          props.api.isActive
            ? "opacity-60 hover:opacity-100"
            : "opacity-0 group-hover/tab:opacity-60 group-hover/tab:hover:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          requestClose();
        }}
        // Same drag-suppression as the menu trigger.
        onMouseDown={(e) => e.stopPropagation()}
        title={t("tabs.closeTab")}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Per-group "+" action that opens a fresh query tab on the selected
 *  connection. Rendered in the group header's right slot. */
function NewTabAction(_props: IDockviewHeaderActionsProps) {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground/60 hover:text-muted-foreground"
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
      title={t("tabs.newQueryTooltip")}
    >
      <Plus className="h-3.5 w-3.5" />
    </Button>
  );
}

/** Empty-state watermark shown when no tabs are open. */
function EmptyWatermark() {
  const { t } = useTranslation();
  const connectionId = useUi((s) => s.selectedConnectionId);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
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
  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
    // User clicking a tab (or dockview activating one after a removal)
    // flows back into the store so the active body and status bar agree.
    event.api.onDidActivePanelChange((panel) => {
      if (panel) useTabs.getState().setActive(panel.id);
    });
  };

  // Reconcile the dockview panels with the store: add panels for new tabs,
  // remove panels for closed ones. This is the only place panels are
  // added/removed, so the flow is strictly store → dockview.
  useEffect(() => {
    if (!api) return;
    for (const tab of tabs) {
      if (api.getPanel(tab.id)) continue;
      const params =
        tab.kind === "table"
          ? {
              connectionId: tab.connectionId,
              schema: tab.schema,
              table: tab.table,
            }
          : { tabId: tab.id, connectionId: tab.connectionId };
      api.addPanel({
        id: tab.id,
        component: tab.kind === "table" ? "table" : "query",
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
    <div className="h-full">
      <DockviewReact
        components={INNER_COMPONENTS}
        defaultTabComponent={WorkspaceTab}
        watermarkComponent={EmptyWatermark}
        rightHeaderActionsComponent={NewTabAction}
        onReady={onReady}
        theme={huginnDockviewTheme}
      />
    </div>
  );
}
