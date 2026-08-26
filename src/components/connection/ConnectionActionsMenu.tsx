/**
 * Right-click menu for a connection, wrapping whatever row represents it.
 *
 * These actions used to be an icon strip in the explorer's header. Once the
 * explorer became a subtree of the connections tree (#107) that strip repeated
 * under every expanded connection — five icons and a filter box each — so it
 * moved here, where a connection's actions belong: on the connection.
 *
 * It used to live inside `SchemaExplorer.tsx` "because everything it drives is
 * already there" — which was true only while the dialogs and the
 * export/import/security helpers were private to that file. They are now their
 * own modules, so the menu lives with the tree that renders it (its only
 * consumer, `ConnectionsTree`, was reaching across into `schema/` for it).
 *
 * What's offered is driver- and mode-aware, and the distinctions are the same
 * ones the two explorers already encoded: `CREATE DATABASE` is Postgres/MySQL
 * only, create-collection is MongoDB's stand-in for it, whole-database `.sql`
 * export/import needs exactly one target database (so never in multi-DB mode),
 * and the visible-databases subset only means anything when there are several.
 *
 * Connect/disconnect are delegated: the tree owns what those do to focus and to
 * its expansion overrides, and duplicating that here would let the two drift.
 */

import { cloneElement, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DatabaseZap,
  Download,
  FolderPlus,
  ListFilter,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Unplug,
  Upload,
} from "lucide-react";
import { notify } from "@/lib/notify";

import {
  ContextMenu,
  ContextMenuAction,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { CreateCollectionDialog } from "@/components/schema/dialogs/CreateCollectionDialog";
import { CreateDatabaseDialog } from "@/components/schema/dialogs/CreateDatabaseDialog";
import { DatabaseVisibilityDialog } from "@/components/schema/dialogs/DatabaseVisibilityDialog";
import {
  ExportDatabaseDialog,
  type ExportScope,
} from "@/components/schema/dialogs/ExportDatabaseDialog";
import {
  ImportSqlDialog,
  type ImportScope,
} from "@/components/schema/dialogs/ImportSqlDialog";
import { isServerWide } from "@/lib/connectionLabel";
import {
  supportsCreateCollection,
  supportsCreateDatabase,
  supportsSqlDump,
} from "@/lib/db/driver";
import { pickAndSplitSqlFile } from "@/lib/sql/pickSqlFile";
import { openSecurityTab } from "@/lib/tabs/openSecurityTab";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useTreeSearch } from "@/stores/session/treeSearch";

export function ConnectionActionsMenu({
  connectionId,
  onConnect,
  onDisconnect,
  children,
}: {
  connectionId: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** A single element (Radix `asChild` requirement) — cloned below to carry
   *  the "menu is open on me" ring while right-clicked. */
  children: React.ReactElement;
}) {
  const { t } = useTranslation();
  const profile = useConnections((s) =>
    s.profiles.find((p) => p.id === connectionId),
  );
  const isActive = useConnections((s) => s.active.has(connectionId));
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const refreshTree = useSchema((s) => s.refreshTree);
  const [createDbOpen, setCreateDbOpen] = useState(false);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [dbPickerOpen, setDbPickerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importStatements, setImportStatements] = useState<string[] | null>(
    null,
  );
  // Right-clicking to open the menu doesn't keep the row hovered (the
  // pointer moves onto the menu itself), so without this the row you
  // targeted looks indistinguishable from any other once the menu is open.
  // Mirrors the row's own `focus-visible:ring-ring` treatment, just driven
  // by the menu's open state instead of keyboard focus.
  const [menuOpen, setMenuOpen] = useState(false);

  const driver = profile?.driver;
  const isMultiDb = isServerWide(profile);
  const canCreateDatabase = supportsCreateDatabase(driver);
  const canCreateCollection = supportsCreateCollection(driver) && !isMultiDb;
  // Whole-database `.sql` export/import used to require single-DB mode
  // (nothing to pick a database *from* otherwise); the export/import
  // dialogs now handle multi-DB themselves — a database picker for export,
  // a target-database dropdown for import — so this is SQL-only, not also
  // single-DB-only.
  const canDumpSql = supportsSqlDump(driver);
  const databases = cs?.databases ?? [];
  const exportScope: ExportScope = isMultiDb
    ? { kind: "multi", parentId: connectionId, databases: databases.map((d) => d.name) }
    : { kind: "single", connectionId, databaseName: profile?.database || connectionId };
  const importScope: ImportScope = isMultiDb
    ? { kind: "multi", parentId: connectionId, databases: databases.map((d) => d.name) }
    : { kind: "single", connectionId };

  return (
    <>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          {cloneElement(children, {
            className: cn(
              children.props.className,
              menuOpen && "ring-1 ring-inset ring-ring",
            ),
          })}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isActive ? (
            <>
              <ContextMenuAction
                icon={RefreshCw}
                label={t("schema.refresh")}
                // `refreshTree`, not `refresh`: on a multi-DB connection the
                // tables under this row live in the per-database child slices,
                // and refreshing only the profile id left every one of them
                // stale (see the store's note on `refreshTree`).
                onSelect={() => void refreshTree(connectionId)}
              />
              {canCreateDatabase && (
                <ContextMenuAction
                  icon={DatabaseZap}
                  label={t("schema.createDatabase.title")}
                  onSelect={() => setCreateDbOpen(true)}
                />
              )}
              {canCreateCollection && (
                <ContextMenuAction
                  icon={FolderPlus}
                  label={t("schema.createCollection.title")}
                  onSelect={() => setCreateCollectionOpen(true)}
                />
              )}
              {isMultiDb && (
                <ContextMenuAction
                  icon={ListFilter}
                  // Nothing to choose from until the database list has loaded.
                  disabled={databases.length === 0}
                  label={t("schema.selectDatabases.title")}
                  onSelect={() => setDbPickerOpen(true)}
                />
              )}
              {/* Narrowing the tree's search to this connection. Deliberately
                  next to "Databases to show": both answer "I only care about
                  this much of the server right now", one for the search and one
                  for the tree. The difference is that this one is a modifier on
                  a needle and evaporates with it, while that one is a persisted
                  per-environment filter. */}
              <ContextMenuAction
                icon={Search}
                label={t("connectionsTree.filter.scopeHere")}
                onSelect={() => {
                  const search = useTreeSearch.getState();
                  search.narrowTo({ kind: "connection", connectionId });
                  search.requestFocus();
                }}
              />
              {canDumpSql && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuAction
                    icon={Download}
                    label={t("schema.exportDatabase.title")}
                    onSelect={() => setExportOpen(true)}
                  />
                  <ContextMenuAction
                    icon={Upload}
                    label={t("schema.importSql.title")}
                    onSelect={() =>
                      void pickAndSplitSqlFile(t).then((statements) => {
                        if (statements) setImportStatements(statements);
                      })
                    }
                  />
                </>
              )}
              <ContextMenuSeparator />
              <ContextMenuAction
                icon={ShieldCheck}
                label={t("security.title")}
                onSelect={() => openSecurityTab(connectionId, t("security.title"))}
              />
              {onDisconnect && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuAction
                    icon={Unplug}
                    label={t("statusBar.disconnect")}
                    onSelect={onDisconnect}
                  />
                </>
              )}
            </>
          ) : (
            onConnect && (
              <ContextMenuAction
                icon={Plug}
                label={t("connectionsTree.connect")}
                onSelect={onConnect}
              />
            )
          )}
        </ContextMenuContent>
      </ContextMenu>

      {createDbOpen && (
        <CreateDatabaseDialog
          connectionId={connectionId}
          onClose={() => setCreateDbOpen(false)}
          onDone={(name) => {
            setCreateDbOpen(false);
            refresh(connectionId);
            // Always toast, unlike the old multi-DB toolbar button, which relied
            // on the new node appearing in the tree as its own confirmation.
            // Driven from a connection row, the subtree may well be collapsed.
            notify.success(t("schema.createDatabase.createdSingleDb", { name }));
          }}
        />
      )}
      {createCollectionOpen && (
        <CreateCollectionDialog
          connectionId={connectionId}
          onClose={() => setCreateCollectionOpen(false)}
          onDone={(name) => {
            setCreateCollectionOpen(false);
            refresh(connectionId);
            notify.success(t("schema.createCollection.created", { name }));
          }}
        />
      )}
      {dbPickerOpen && (
        <DatabaseVisibilityDialog
          profileId={connectionId}
          databases={databases.map((db) => db.name)}
          onClose={() => setDbPickerOpen(false)}
        />
      )}
      {exportOpen && (
        <ExportDatabaseDialog scope={exportScope} onClose={() => setExportOpen(false)} />
      )}
      {importStatements && (
        <ImportSqlDialog
          scope={importScope}
          statements={importStatements}
          onClose={() => setImportStatements(null)}
          onImported={(id) => {
            setImportStatements(null);
            refresh(id);
          }}
        />
      )}
    </>
  );
}
