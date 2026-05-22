/**
 * Tree-style explorer of databases / schemas / tables / columns for the
 * currently selected connection. Columns are lazy-loaded the first time
 * a table node is expanded. Single-click on a table opens it in a data tab.
 *
 * Tree structure (single-DB profile):
 *   schema
 *   ├─ tables  (expandable section)
 *   │   ├─ table_name  <row_count>
 *   │   │   └─ column_name  TYPE
 *   │   └─ …
 *   ├─ views   (expandable section)
 *   └─ indexes (expandable section — headers only for now)
 *
 * Multi-DB mode (profile.database === ""):
 *   database
 *   ├─ <schema subtree, same as single-DB mode>
 *   └─ …
 *
 * In multi-DB mode each database expansion opens a synthetic
 * `<parentId>::db::<db>` connection in the backend (see
 * `open_database_view`), and every nested node uses that synthetic id so
 * downstream commands like `list_tables` / `fetch_table_data` keep their
 * existing single-connection-id signatures.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Database,
  RefreshCw,
  Table as TableIcon,
  Eye,
  KeyRound,
  LayoutList,
} from "lucide-react";
import { useSchema, tableKey } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { usePreferences } from "@/stores/preferences";
import { api } from "@/lib/tauri";
import type { SchemaTableMetric } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, formatCount } from "@/lib/utils";
import type { TableInfo } from "@/types";

export function SchemaExplorer({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  // Multi-DB mode triggers when the parent profile has no `database` set
  // (e.g. the user wants to browse every database on the server). SQLite
  // profiles are inherently single-file, so they never enter this mode.
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isMultiDb =
    !!profile && profile.driver !== "sqlite" && profile.database === "";

  if (isMultiDb) {
    return <MultiDbExplorer parentId={connectionId} />;
  }
  return <SingleDbExplorer connectionId={connectionId} title={t("schema.title")} />;
}

// ---------------------------------------------------------------------------
// Single-database explorer (used directly for profiles with `database` set,
// and as the inner subtree of each database node in multi-DB mode).
// ---------------------------------------------------------------------------

function SingleDbExplorer({
  connectionId,
  title,
  headerLevel = "root",
  controlledFilter,
}: {
  connectionId: string;
  title: string;
  /**
   * `root` shows the standard "SCHEMA" header + refresh button. `nested`
   * skips the header chrome entirely — used when this subtree lives under a
   * database node and the outer multi-DB explorer already owns the chrome.
   */
  headerLevel?: "root" | "nested";
  /**
   * When provided, the filter is owned by a parent component (typically
   * [[MultiDbExplorer]], which renders one filter input shared across all
   * DBs). The local input is hidden and the local state is bypassed —
   * propagated by the parent so every nested DB filters by the same
   * needle, which was the whole point of the multi-DB unification.
   */
  controlledFilter?: string;
}) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  const loadColumns = useSchema((s) => s.loadColumns);
  const openTab = useTabs((s) => s.open);

  // Driver lookup: needed by the context menu to compose a driver-correct
  // "Copy SELECT" snippet. For synthetic multi-DB connection ids the
  // profile lives under the parent half of the id.
  const driver = useConnections((s) => {
    const direct = s.profiles.find((p) => p.id === connectionId);
    if (direct) return direct.driver;
    const sep = connectionId.indexOf("::db::");
    if (sep > 0) {
      const parent = s.profiles.find((p) => p.id === connectionId.slice(0, sep));
      if (parent) return parent.driver;
    }
    return undefined;
  });

  // When the filter is owned by the parent we ignore the local state and
  // hide the local input. We still declare the local state to keep the
  // hook order stable when toggling between controlled and uncontrolled
  // (the prop being defined/undefined doesn't change between renders in
  // practice — a `<DatabaseRoot>` is either inside a multi-DB tree or it
  // isn't — but defending against future restructures is cheap).
  const [localFilter, setLocalFilter] = useState("");
  const isControlled = controlledFilter !== undefined;
  const filter = isControlled ? controlledFilter : localFilter;
  const setFilter = isControlled ? () => {} : setLocalFilter;

  const [renameTarget, setRenameTarget] = useState<TableInfo | null>(null);
  const [dropTarget, setDropTarget] = useState<TableInfo | null>(null);

  useEffect(() => {
    // Fire refresh only when no successful fetch has happened yet AND no
    // fetch is currently in flight. Without the `!cs.loading` guard, every
    // `set({ loading: true })` call inside `refresh` would create a new `cs`
    // reference, re-trigger this effect, and launch a second concurrent fetch
    // before the first one finishes — a tight loop on slow drivers (MySQL).
    if (!cs || (!cs.initialized && !cs.loading)) refresh(connectionId);
  }, [connectionId, cs, refresh]);

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        {t("schema.loading")}
      </div>
    );
  }

  // Group tables by schema, then by kind within each schema. Apply the
  // filter at this stage so empty schemas drop out of the rendered list
  // entirely when nothing matches.
  const needle = filter.trim().toLowerCase();
  const bySchema: Record<string, { tables: TableInfo[]; views: TableInfo[] }> =
    {};
  for (const tbl of cs.tables) {
    if (needle && !tbl.name.toLowerCase().includes(needle)) continue;
    bySchema[tbl.schema] ??= { tables: [], views: [] };
    if (tbl.kind === "view") {
      bySchema[tbl.schema].views.push(tbl);
    } else {
      bySchema[tbl.schema].tables.push(tbl);
    }
  }
  const schemas = Object.keys(bySchema).sort();

  const tableActions: TableActions = {
    openTab,
    refresh: () => refresh(connectionId),
    onRename: (tbl) => setRenameTarget(tbl),
    onDrop: (tbl) => setDropTarget(tbl),
    driver,
  };

  return (
    <div className="flex h-full flex-col">
      {headerLevel === "root" && (
        <div className="flex items-center justify-between px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => refresh(connectionId)}
            disabled={cs.loading}
            title={t("schema.refresh")}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${cs.loading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      )}
      {!isControlled && (
        <div className="px-3 pb-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("schema.filterPlaceholder")}
            className="h-7 text-xs"
          />
        </div>
      )}
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {needle && schemas.length === 0 && (
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
              flattenSingleSchema || needle
                ? true
                : cs.expanded.has(schemaNodeKey);
            const { tables, views } = bySchema[schema];

            return (
              <div key={schema}>
                {/* Schema / database header — suppressed when we're a
                    nested explorer with a single schema to avoid a
                    duplicate database node (see comment above). */}
                {!flattenSingleSchema && (
                  <button
                    className="flex w-full items-center gap-1 px-2 py-1 hover:bg-accent/40"
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
                      forceOpen={!!needle}
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
                        forceOpen={!!needle}
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
        <RenameTableDialog
          connectionId={connectionId}
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onDone={() => {
            setRenameTarget(null);
            refresh(connectionId);
          }}
        />
      )}
      {dropTarget && (
        <DropTableDialog
          connectionId={connectionId}
          target={dropTarget}
          onClose={() => setDropTarget(null)}
          onDone={() => {
            setDropTarget(null);
            refresh(connectionId);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-DB explorer — for profiles whose `database` is blank. Lists every
// database the user can see on the server as a top-level node; expanding
// one lazily opens a synthetic connection (`open_database_view`) and the
// nested subtree behaves like a regular single-DB explorer pointed at that
// synthetic id.
// ---------------------------------------------------------------------------

function MultiDbExplorer({ parentId }: { parentId: string }) {
  const { t } = useTranslation();
  const cs = useSchema((s) => s.byConnection[parentId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  // Subscribe to the whole map so `matchingDbs` reactively recomputes
  // as each prefetch lands. The membership check is cheap (Map lookup
  // per database) so the broader subscription is fine here.
  const byConnection = useSchema((s) => s.byConnection);

  // Connection-level filter, shared across every database in the
  // explorer. Lifted up here so multi-DB connections have a single
  // search box instead of one per database — see plan A2. Each nested
  // SingleDbExplorer receives this value via `controlledFilter` and
  // hides its own input.
  const [filter, setFilter] = useState("");

  // Debounced needle drives the prefetch fan-out and the
  // matching-database computation. Without the delay, every keystroke
  // would queue an `openDatabaseView` + `list_tables` against every
  // database on the server.
  const [debouncedNeedle, setDebouncedNeedle] = useState("");
  useEffect(() => {
    const trimmed = filter.trim().toLowerCase();
    // Skip debouncing the empty case — clearing the filter should feel
    // instantaneous so the user immediately gets the full list back.
    if (trimmed.length === 0) {
      setDebouncedNeedle("");
      return;
    }
    const id = setTimeout(() => setDebouncedNeedle(trimmed), 250);
    return () => clearTimeout(id);
  }, [filter]);

  useEffect(() => {
    if (!cs || (!cs.initialized && !cs.loading)) refresh(parentId);
  }, [parentId, cs, refresh]);

  // MongoDB-Compass-style prefetch: while the user is searching, walk
  // every database we haven't loaded yet, open the synthetic child
  // connection, and pull its table list into the store. We mark a db
  // as "in-flight" the moment we start so concurrent renders don't
  // schedule it twice. Failures are swallowed — the matching
  // computation just won't include that DB until the user retries.
  // Limit to needle length >= 2 to avoid a full fan-out on a single
  // typed character (and on accidental focus changes).
  const inFlightPrefetch = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (debouncedNeedle.length < 2 || !cs) return;
    for (const db of cs.databases) {
      const childId = `${parentId}::db::${db.name}`;
      const childCs = byConnection[childId];
      if (childCs?.initialized || childCs?.loading) continue;
      if (inFlightPrefetch.current.has(childId)) continue;
      inFlightPrefetch.current.add(childId);
      api
        .openDatabaseView(parentId, db.name)
        .then((resolvedId) => refresh(resolvedId))
        .catch(() => {
          // Silent: a failed prefetch is reported via the database's
          // own subtree the next time the user expands it.
        })
        .finally(() => {
          inFlightPrefetch.current.delete(childId);
        });
    }
  }, [debouncedNeedle, cs, byConnection, parentId, refresh]);

  const filterActive = debouncedNeedle.length > 0;

  // Decide which databases to render. With an active filter we surface
  // (a) DBs whose own catalog name matches the needle (covers the case
  // where the user is looking for a database by name), and (b) DBs that
  // own at least one matching table — those auto-expand so the user
  // sees the matches without an extra click.
  //
  // This memo MUST live above the early return below: React relies on
  // hooks being called in the same order on every render, so a
  // conditional `if (!cs) return …` above this useMemo would skip the
  // hook on the first render and call it on subsequent ones — a Rules
  // of Hooks violation that blanked the whole multi-DB panel in 0.7.0
  // / 0.7.1 (no error UI, just an empty tree). See CLAUDE.md for the
  // broader family of cases (selectors / refs / memos slipping below
  // an early return).
  const matchingDbs = useMemo(() => {
    if (!filterActive || !cs) return null;
    const m = new Map<string, { byName: boolean; byTable: boolean }>();
    for (const db of cs.databases) {
      const childId = `${parentId}::db::${db.name}`;
      const tables = byConnection[childId]?.tables ?? [];
      const byTable = tables.some((t) =>
        t.name.toLowerCase().includes(debouncedNeedle),
      );
      const byName = db.name.toLowerCase().includes(debouncedNeedle);
      if (byName || byTable) m.set(db.name, { byName, byTable });
    }
    return m;
  }, [filterActive, debouncedNeedle, cs, byConnection, parentId]);

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">
        {t("schema.loading")}
      </div>
    );
  }

  // While prefetches are in flight we want to tell the user something
  // is happening — "no matches" would be misleading if the DBs simply
  // haven't reported yet.
  const prefetching =
    filterActive &&
    cs.databases.some((db) => {
      const childId = `${parentId}::db::${db.name}`;
      const c = byConnection[childId];
      return !c?.initialized;
    });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("schema.title")}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => refresh(parentId)}
          disabled={cs.loading}
          title={t("schema.refresh")}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${cs.loading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>
      <div className="px-3 pb-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("schema.filterPlaceholder")}
          className="h-7 text-xs"
        />
      </div>
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {filterActive && matchingDbs && matchingDbs.size === 0 && !prefetching && (
          <div className="px-3 py-2 text-xs italic text-muted-foreground">
            {t("schema.noMatches")}
          </div>
        )}
        {cs.databases
          .filter((db) => !matchingDbs || matchingDbs.has(db.name))
          .map((db) => {
            const match = matchingDbs?.get(db.name);
            // Auto-expand DBs that contain a table match so the result
            // is visible immediately. A name-only match keeps the DB
            // collapsed — the user is presumably picking the database,
            // not browsing inside it.
            const autoExpand = !!match?.byTable;
            return (
              <DatabaseRoot
                key={db.name}
                parentId={parentId}
                dbName={db.name}
                expanded={cs.expanded.has(`db:${db.name}`)}
                onToggle={() => toggleNode(parentId, `db:${db.name}`)}
                filter={filter}
                filterActive={filterActive}
                autoExpand={autoExpand}
              />
            );
          })}
      </div>
    </div>
  );
}

/** One database row in the multi-DB explorer. Lazily opens the synthetic
 *  child pool the first time it is expanded; subsequent expansions reuse
 *  it. */
function DatabaseRoot({
  parentId,
  dbName,
  expanded,
  onToggle,
  filter,
  filterActive,
  autoExpand,
}: {
  parentId: string;
  dbName: string;
  expanded: boolean;
  onToggle: () => void;
  /** Shared connection-level filter, forwarded to the nested explorer. */
  filter: string;
  /** True when the parent filter has any content; auto-expands already-opened
   *  databases so search results surface without an extra click. */
  filterActive: boolean;
  /** True when the parent has determined this DB contains a table match
   *  for the current filter — auto-opens the subtree (Compass-style). */
  autoExpand?: boolean;
}) {
  const [childId, setChildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // Three ways the subtree can be open:
  //   1. The user clicked the chevron (`expanded`).
  //   2. The user is searching and the DB was already opened earlier
  //      (`filterActive && childId`).
  //   3. The Compass-style filter has determined this DB has matching
  //      tables and asks us to auto-open it (`autoExpand`).
  const effectiveExpanded =
    expanded || autoExpand || (filterActive && childId !== null);

  useEffect(() => {
    if (!effectiveExpanded || childId || opening) return;
    setOpening(true);
    setError(null);
    api
      .openDatabaseView(parentId, dbName)
      .then((id) => setChildId(id))
      .catch((e) => setError(String(e)))
      .finally(() => setOpening(false));
  }, [effectiveExpanded, childId, opening, parentId, dbName]);

  return (
    <div>
      <button
        className="flex w-full items-center gap-1 px-2 py-1 hover:bg-accent/40"
        onClick={onToggle}
      >
        {effectiveExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-xs">{dbName}</span>
      </button>
      {effectiveExpanded && (
        <div className="ml-3 border-l border-border/40">
          {error && (
            <div className="px-3 py-1 text-[11px] text-destructive">{error}</div>
          )}
          {opening && !childId && (
            <div className="px-3 py-1 text-[11px] italic text-muted-foreground">
              …
            </div>
          )}
          {childId && (
            <SingleDbExplorer
              connectionId={childId}
              title={dbName}
              headerLevel="nested"
              controlledFilter={filter}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (not exported — internal to this module)
// ---------------------------------------------------------------------------

interface TableActions {
  openTab: ReturnType<typeof useTabs.getState>["open"];
  refresh: () => void;
  onRename: (table: TableInfo) => void;
  onDrop: (table: TableInfo) => void;
  driver: "postgres" | "mysql" | "sqlite" | undefined;
}

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  items: TableInfo[];
  sectionKey: string;
  connectionId: string;
  cs: ReturnType<typeof useSchema.getState>["byConnection"][string];
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  actions: TableActions;
  /** Force every section to render open (used by the filter). */
  forceOpen?: boolean;
}

/** Renders the right-aligned per-table metric badge (row count or size). */
function tableMetricLabel(t: TableInfo, metric: SchemaTableMetric): string | null {
  if (metric === "row-count" && t.row_count !== undefined) {
    return formatCount(t.row_count);
  }
  if (metric === "size" && t.size_bytes !== undefined) {
    return formatBytes(t.size_bytes);
  }
  return null;
}

/** Expandable section listing a set of tables or views within a schema. */
function TableSection({
  label,
  icon,
  items,
  sectionKey,
  connectionId,
  cs,
  toggleNode,
  loadColumns,
  actions,
  forceOpen,
}: SectionProps) {
  // Inner i18n hook — the table loop shadows `t`, so we use the function
  // directly via `i18n.t` here is overkill; instead alias it.
  const { t: translate } = useTranslation();
  const isOpen = forceOpen ? true : cs.expanded.has(sectionKey);
  const metric = usePreferences((s) => s.prefs.ui.schemaTableMetric);

  return (
    <div>
      <button
        className="flex w-full items-center gap-1 py-0.5 pl-5 pr-2 hover:bg-accent/30"
        onClick={() => toggleNode(connectionId, sectionKey)}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        )}
        {icon}
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {items.length}
        </span>
      </button>

      {isOpen &&
        items.map((t) => (
          <TableRow
            key={tableKey(t.schema, t.name)}
            table={t}
            connectionId={connectionId}
            cs={cs}
            toggleNode={toggleNode}
            loadColumns={loadColumns}
            actions={actions}
            metric={metric}
            loadingLabel={translate("schema.loadingColumns")}
          />
        ))}
    </div>
  );
}

/** One table/view row + its expandable column list, wrapped in a context
 *  menu with the destructive (DROP) and renaming actions. */
function TableRow({
  table,
  connectionId,
  cs,
  toggleNode,
  loadColumns,
  actions,
  metric,
  loadingLabel,
}: {
  table: TableInfo;
  connectionId: string;
  cs: ReturnType<typeof useSchema.getState>["byConnection"][string];
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  actions: TableActions;
  metric: SchemaTableMetric;
  loadingLabel: string;
}) {
  const { t: ct } = useTranslation();
  const t = table;
  const k = tableKey(t.schema, t.name);
  const tableNodeKey = `table:${k}`;
  const tableOpen = cs.expanded.has(tableNodeKey);
  const cols = cs.columns[k];
  const isView = t.kind === "view";

  const copyName = () => {
    void navigator.clipboard.writeText(t.name);
  };
  const copySelect = () => {
    const qualified = qualifyForCopy(actions.driver, t.schema, t.name);
    void navigator.clipboard.writeText(`SELECT * FROM ${qualified};`);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <div className="flex items-center pl-8 pr-2 hover:bg-accent/30">
            <button
              onClick={() => {
                toggleNode(connectionId, tableNodeKey);
                if (!cols) loadColumns(connectionId, t.schema, t.name);
              }}
              className="flex flex-1 items-center gap-1 py-0.5"
            >
              {tableOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {isView ? (
                <Eye className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <TableIcon className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span
                className="truncate text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.openTab({
                    kind: "table",
                    title: t.name,
                    connectionId,
                    schema: t.schema,
                    table: t.name,
                  });
                }}
              >
                {t.name}
              </span>
              {(() => {
                const badge = tableMetricLabel(t, metric);
                return badge ? (
                  <span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground">
                    {badge}
                  </span>
                ) : null;
              })()}
            </button>
          </div>

          {tableOpen && (
            <div className="ml-10 border-l border-border/50 pl-2 pr-2">
              {cols ? (
                cols.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {c.is_primary_key && (
                      <KeyRound className="h-2.5 w-2.5 shrink-0 text-amber-400" />
                    )}
                    <span className="truncate">{c.name}</span>
                    <span className="ml-auto shrink-0 pl-2 text-[10px] uppercase">
                      {c.data_type}
                    </span>
                  </div>
                ))
              ) : (
                <div className="py-0.5 pl-1 text-[11px] italic text-muted-foreground">
                  {loadingLabel}
                </div>
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() =>
            actions.openTab({
              kind: "table",
              title: t.name,
              connectionId,
              schema: t.schema,
              table: t.name,
            })
          }
        >
          {ct("schema.context.open")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={copyName}>
          {ct("schema.context.copyName")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={copySelect}>
          {ct("schema.context.copySelect")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.refresh()}>
          {ct("schema.context.refresh")}
        </ContextMenuItem>
        {/* Views fall through to read-only; we only expose DDL on base tables. */}
        {!isView && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => actions.onRename(t)}>
              {ct("schema.context.rename")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => actions.onDrop(t)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              {ct("schema.context.drop")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Build the table reference used inside the "Copy SELECT" snippet. We
 *  quote with the driver's conventional identifier delimiters so the
 *  snippet pastes cleanly into the query editor — even for case-sensitive
 *  Postgres identifiers or MySQL reserved words. */
function qualifyForCopy(
  driver: "postgres" | "mysql" | "sqlite" | undefined,
  schema: string,
  table: string,
): string {
  if (driver === "mysql") {
    return schema
      ? `\`${schema}\`.\`${table}\``
      : `\`${table}\``;
  }
  // postgres / sqlite / unknown — use double quotes.
  return schema ? `"${schema}"."${table}"` : `"${table}"`;
}

/** Modal for renaming a table. Validates against empty input and
 *  surfaces the backend error in-place. */
function RenameTableDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState(target.name);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === target.name) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.renameTable(connectionId, target.schema, target.name, trimmed);
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.rename.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.rename.description", { name: target.name })}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t("schema.rename.newName")}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.rename.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={
              submitting ||
              !newName.trim() ||
              newName.trim() === target.name
            }
          >
            {submitting ? t("schema.rename.renaming") : t("schema.rename.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Modal for dropping a table. Requires the user to retype the table
 *  name verbatim before the destructive button enables — same pattern
 *  GitHub uses for repository deletion. */
function DropTableDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (confirm !== target.name) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.dropTable(connectionId, target.schema, target.name);
      onDone();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.drop.title", { name: target.name })}</DialogTitle>
          <DialogDescription>{t("schema.drop.description")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={t("schema.drop.confirmInput", { name: target.name })}
        />
        {error && (
          <div className="text-xs text-destructive">
            {t("schema.drop.failed", { message: error })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={submitting || confirm !== target.name}
          >
            {submitting ? t("schema.drop.dropping") : t("schema.drop.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Collapsible "indexes" section header within a schema node. */
function IndexesSectionHeader({
  label,
  sectionKey,
  connectionId,
  expanded,
  toggleNode,
}: {
  label: string;
  sectionKey: string;
  connectionId: string;
  expanded: Set<string>;
  toggleNode: (connectionId: string, key: string) => void;
}) {
  const isOpen = expanded.has(sectionKey);
  return (
    <button
      className="flex w-full items-center gap-1 py-0.5 pl-5 pr-2 hover:bg-accent/30"
      onClick={() => toggleNode(connectionId, sectionKey)}
    >
      {isOpen ? (
        <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
      )}
      <LayoutList className="h-3 w-3 text-muted-foreground/70" />
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </button>
  );
}
