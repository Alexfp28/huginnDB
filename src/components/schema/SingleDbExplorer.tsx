/**
 * Single-database explorer: the schema → tables/views/indexes subtree.
 *
 * Used directly for a profile with `database` set, and as the inner subtree of
 * each database node in multi-DB mode (`DatabaseRoot` renders one per database).
 *
 * **The grouping `useMemo` MUST stay above the `if (!cs)` early return.** When a
 * multi-DB filter is cleared several nested explorers unmount while
 * `byConnection` is still settling, and `cs` can flip to `undefined` for a
 * render; a hook below the return would then be skipped on that render and
 * called again on the next — "rendered fewer hooks than expected", which took
 * the whole connection panel to a blank screen (the 1.0.1 bug). The comment at
 * the memo says the same thing; both are load-bearing.
 */

import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  RefreshCw,
  SquareTerminal,
  Table as TableIcon,
  Table2,
} from "lucide-react";
import { notify } from "@/lib/notify";

import { IndexesSectionHeader } from "@/components/schema/IndexesSectionHeader";
import { TableSection } from "@/components/schema/SchemaTableSection";
import { DropObjectDialog } from "@/components/schema/dialogs/DropObjectDialog";
import { EmptyTableDialog } from "@/components/schema/dialogs/EmptyTableDialog";
import {
  RenameObjectDialog,
} from "@/components/schema/dialogs/RenameObjectDialog";
import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import { supportsDdlEditing } from "@/lib/db/driver";
import { matchesPatterns } from "@/lib/schema/matchesFilter";
import { openQueryTab } from "@/lib/tabs/openQueryTab";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/stores/preferences/preferences";
import { useEnsureSchemaLoaded, useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import type { TableActions } from "@/components/schema/SchemaTableSection";
import type { TableInfo } from "@/types";

export const SingleDbExplorer = memo(function SingleDbExplorer({
  connectionId,
  headerLevel = "root",
  patterns,
  onTableOpen,
}: {
  connectionId: string;
  /**
   * `nested` skips the schema header when there's exactly one schema to
   * show (see `flattenSingleSchema` below) — used when this subtree lives
   * under a database node and the outer multi-DB explorer already owns
   * the database-level chrome.
   */
  headerLevel?: "root" | "nested";
  /**
   * The committed, parsed needle. Always owned by the tree
   * (`ConnectionsTree.tsx` → `useTreeSearch`), never re-derived here: the
   * string used to come down raw and every level re-split it, which is how a
   * database row could be decided by one needle while its contents were
   * filtered by another for the length of a debounce.
   */
  patterns: string[];
  /**
   * Optional callback fired when the user opens a table (click or context
   * menu). Used by the multi-DB parent to activate this database's scope
   * and collapse the others.
   */
  onTableOpen?: () => void;
}) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  const loadColumns = useSchema((s) => s.loadColumns);
  const openTab = useTabs((s) => s.open);

  // Needed by the context menu to compose a driver-correct "Copy SELECT"
  // snippet.
  const driver = useConnectionDriver(connectionId);

  // Which schema header (if any) currently has its right-click menu open —
  // there's one `ContextMenu` per schema rendered by the `schemas.map(...)`
  // below, so this can't be a `useState` inside that loop (Rules of Hooks);
  // tracking "which name" in the enclosing component instead works the same
  // way since only one context menu can realistically be open at a time.
  const [openSchemaMenu, setOpenSchemaMenu] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<TableInfo | null>(null);
  const [dropTarget, setDropTarget] = useState<TableInfo | null>(null);
  const [emptyTarget, setEmptyTarget] = useState<TableInfo | null>(null);
  const [renameViewTarget, setRenameViewTarget] = useState<TableInfo | null>(
    null,
  );
  const [dropViewTarget, setDropViewTarget] = useState<TableInfo | null>(null);
  // Create-database / create-collection / export / import / security used to be
  // an icon strip in this explorer's header. They are connection-level actions,
  // so they now live on the connection row's right-click menu
  // ([[ConnectionActionsMenu]]) — which is also where their driver conditions
  // and their dialogs moved.

  useEnsureSchemaLoaded(connectionId);

  // Group tables by schema, then by kind within each schema. Apply the
  // filter at this stage so empty schemas drop out of the rendered list
  // entirely when nothing matches.
  //
  // This hook MUST stay above the `if (!cs)` early return below. When a
  // multi-DB filter is cleared, several nested explorers unmount while
  // `byConnection` is still settling, and `cs` can flip to `undefined` for
  // a render before the slice reappears. A `useMemo` placed *after* the
  // early return would then be skipped on the `undefined` render and called
  // again on the next one — "rendered fewer hooks than expected", which
  // crashed the whole connection panel to a blank screen (the exact 1.0.1
  // multi-DB blank-panel bug). Keeping it here, reading `cs?.tables`, makes
  // the hook count constant. Memoising also keeps the grouping object
  // reference-stable so the `TableSection` subtree doesn't thrash on every
  // render of the surviving explorers (CLAUDE.md gotcha #1).
  const filtering = patterns.length > 0;
  const { bySchema, schemas } = useMemo(() => {
    const grouped: Record<
      string,
      { tables: TableInfo[]; views: TableInfo[] }
    > = {};
    for (const tbl of cs?.tables ?? []) {
      if (!matchesPatterns(tbl.name, patterns)) continue;
      grouped[tbl.schema] ??= { tables: [], views: [] };
      if (tbl.kind === "view") {
        grouped[tbl.schema].views.push(tbl);
      } else {
        grouped[tbl.schema].tables.push(tbl);
      }
    }
    return { bySchema: grouped, schemas: Object.keys(grouped).sort() };
  }, [cs?.tables, patterns]);

  // Stable regardless of whether `onTableOpen` is given: it's read at CALL
  // time, not baked into a branch chosen once — so this needs only its own
  // (possibly still-unstable, if the caller doesn't memoize it) identity to
  // settle, rather than recreating itself every render via a ternary.
  const wrappedOpenTab = useCallback<typeof openTab>(
    (config) => {
      onTableOpen?.();
      return openTab(config);
    },
    [onTableOpen, openTab],
  );

  /**
   * `TableSection`/`TableRow` are `memo()`-wrapped (gotcha #28), which is
   * worthless if their `actions` bundle is a fresh object every render —
   * exactly what this was before the fix, rebuilt unconditionally on every
   * `SingleDbExplorer` render regardless of whether any handler's
   * dependencies had actually changed.
   *
   * Placed here, ABOVE the `if (!cs)` early return below — same load-bearing
   * reason as the `bySchema`/`schemas` memo above: a `useMemo` placed after
   * a conditional return would be skipped whenever `cs` is momentarily
   * `undefined` (the 1.0.1 multi-DB blank-panel bug this file's header
   * comment documents), and this hook is no exception to that rule just
   * because it was added later.
   */
  const tableActions: TableActions = useMemo(
    () => ({
      openTab: wrappedOpenTab,
      refresh: () => refresh(connectionId),
      onRename: (tbl) => setRenameTarget(tbl),
      onDrop: (tbl) => setDropTarget(tbl),
      onEmpty: (tbl) => {
        // "Don't ask again" (#69): when the user has silenced the prompt,
        // empty straight away; otherwise route through the confirmation
        // dialog. This is a dedicated preference, not the global
        // `confirmDestructive`, so opting out here never weakens other
        // destructive confirmations.
        if (usePreferences.getState().prefs.ui.confirmEmptyTable) {
          setEmptyTarget(tbl);
          return;
        }
        void (async () => {
          try {
            await api.emptyTable(connectionId, tbl.schema, tbl.name);
            notify.success(t("schema.empty.emptied", { name: tbl.name }));
            refresh(connectionId);
          } catch (e) {
            notify.error(String(e));
          }
        })();
      },
      onRenameView: (tbl) => setRenameViewTarget(tbl),
      onDropView: (tbl) => setDropViewTarget(tbl),
      driver,
    }),
    [wrappedOpenTab, refresh, connectionId, t, driver],
  );

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        {t("schema.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="pb-1 text-sm">
        {filtering && schemas.length === 0 && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {(() => {
          // In multi-DB mode, MySQL and SQLite synthetic children report
          // every table under a single "schema" name that coincides with
          // the database name itself (`SELECT DATABASE()` on MySQL,
          // hard-coded "main" on SQLite). Re-rendering that as a Database
          // node under the database we just expanded looks like the
          // database is nested inside itself. When this nested explorer
          // sees exactly one schema, drop the redundant header and pin
          // the sections directly under the parent DB node. Postgres
          // multi-DB legitimately has multiple user schemas
          // (`public`, custom namespaces) — there we keep the per-schema
          // header so they remain distinguishable.
          const flattenSingleSchema =
            headerLevel === "nested" && schemas.length === 1;
          return schemas.map((schema) => {
            const schemaNodeKey = `schema:${schema}`;
            // Force-expand a schema when the filter is active so matching
            // tables under it are visible without the user having to click.
            const schemaOpen =
              flattenSingleSchema || filtering
                ? true
                : cs.expanded.has(schemaNodeKey);
            const { tables, views } = bySchema[schema];

            return (
              <div key={schema}>
                {/* Schema / database header — suppressed when we're a
                    nested explorer with a single schema to avoid a
                    duplicate database node (see comment above). Its
                    right-click menu is where table/view creation belongs
                    ([[schema.context.newTable]] used to live on an existing
                    table's own menu, which meant a database with zero
                    tables had no way to grow one from the tree). */}
                {!flattenSingleSchema && (
                  <ContextMenu
                    onOpenChange={(open) =>
                      setOpenSchemaMenu(open ? schema : null)
                    }
                  >
                    <ContextMenuTrigger asChild>
                      <button
                        className={cn(
                          "flex w-full items-center gap-1 px-2 py-1.5 hover:bg-accent/40",
                          openSchemaMenu === schema &&
                            "ring-1 ring-inset ring-ring",
                        )}
                        onClick={() => toggleNode(connectionId, schemaNodeKey)}
                      >
                        {schemaOpen ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        <Database className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="truncate text-xs">{schema}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {tables.length + views.length}
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuAction
                        icon={RefreshCw}
                        label={t("schema.refresh")}
                        onSelect={() => refresh(connectionId)}
                      />
                      <ContextMenuSeparator />
                      <ContextMenuAction
                        icon={Table2}
                        label={t("schema.context.newTable")}
                        onSelect={() =>
                          wrappedOpenTab({
                            kind: "structure",
                            structureMode: "new",
                            title: t("schema.context.newTable"),
                            connectionId,
                            schema,
                          })
                        }
                      />
                      {supportsDdlEditing(driver) && (
                        <ContextMenuAction
                          icon={Eye}
                          label={t("schema.context.newView")}
                          onSelect={() =>
                            wrappedOpenTab({
                              kind: "view",
                              viewMode: "new",
                              title: t("schema.context.newView"),
                              connectionId,
                              schema,
                            })
                          }
                        />
                      )}
                      <ContextMenuAction
                        icon={SquareTerminal}
                        label={t("schema.context.newQueryHere")}
                        onSelect={() =>
                          openQueryTab(connectionId)
                        }
                      />
                    </ContextMenuContent>
                  </ContextMenu>
                )}

                {schemaOpen && (
                  <div>
                    {/* Tables section */}
                    <TableSection
                      label={t("schema.sectionTables")}
                      icon={<TableIcon className="h-3 w-3 text-muted-foreground/70" />}
                      items={tables}
                      sectionKey={`${schemaNodeKey}:tables`}
                      connectionId={connectionId}
                      cs={cs}
                      toggleNode={toggleNode}
                      loadColumns={loadColumns}
                      actions={tableActions}
                      forceOpen={filtering}
                    />

                    {/* Views section */}
                    {views.length > 0 && (
                      <TableSection
                        label={t("schema.sectionViews")}
                        icon={<Eye className="h-3 w-3 text-muted-foreground/70" />}
                        items={views}
                        sectionKey={`${schemaNodeKey}:views`}
                        connectionId={connectionId}
                        cs={cs}
                        toggleNode={toggleNode}
                        loadColumns={loadColumns}
                        actions={tableActions}
                        forceOpen={filtering}
                      />
                    )}

                    {/* Indexes section header — content is per-table */}
                    <IndexesSectionHeader
                      label={t("schema.sectionIndexes")}
                      sectionKey={`${schemaNodeKey}:indexes`}
                      connectionId={connectionId}
                      expanded={cs.expanded}
                      toggleNode={toggleNode}
                    />
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>

      {renameTarget && (
        <RenameObjectDialog
          kind="table"
          connectionId={connectionId}
          target={renameTarget}
          driver={driver}
          databases={cs.databases.map((d) => d.name)}
          onClose={() => setRenameTarget(null)}
          onDone={() => {
            setRenameTarget(null);
            // `refreshTree`: a MongoDB rename can move the collection into
            // another database, whose slice is a sibling of this one.
            void useSchema.getState().refreshTree(connectionId);
          }}
        />
      )}
      {dropTarget && (
        <DropObjectDialog
          kind="table"
          connectionId={connectionId}
          target={dropTarget}
          onClose={() => setDropTarget(null)}
          onDone={() => {
            setDropTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {emptyTarget && (
        <EmptyTableDialog
          connectionId={connectionId}
          target={emptyTarget}
          onClose={() => setEmptyTarget(null)}
          onDone={() => {
            setEmptyTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {renameViewTarget && (
        <RenameObjectDialog
          kind="view"
          connectionId={connectionId}
          target={renameViewTarget}
          onClose={() => setRenameViewTarget(null)}
          onDone={() => {
            setRenameViewTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {dropViewTarget && (
        <DropObjectDialog
          kind="view"
          connectionId={connectionId}
          target={dropViewTarget}
          onClose={() => setDropViewTarget(null)}
          onDone={() => {
            setDropViewTarget(null);
            refresh(connectionId);
          }}
        />
      )}
    </div>
  );
});
