/**
 * "Security" tab — lists server-side users/roles for a connection and,
 * on row expand, lazy-loads the privileges granted to that user.
 *
 * Built on TanStack Table for the outer user list (sortable via the
 * standard header click, matching `DataGrid`'s conventions); the nested
 * privilege list per expanded row is a plain table fetched on demand so
 * opening the panel never pays for every user's grants up front.
 *
 * SQLite has no user/permission model — `listUsers` always resolves to an
 * empty array for it, rendered here as an explanatory empty state rather
 * than a blank table.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { PrivilegeInfo, UserInfo } from "@/types";

export function SecurityTab({
  connectionId,
}: {
  tabId: string;
  connectionId: string;
}) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sorting, setSorting] = useState<SortingState>([]);

  // Privileges cache, keyed by `UserInfo.name`. `undefined` = not fetched
  // yet, `"loading"` sentinel handled separately via `loadingUser`.
  const [privileges, setPrivileges] = useState<Record<string, PrivilegeInfo[]>>({});
  const [loadingUser, setLoadingUser] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api
      .listUsers(connectionId)
      .then(setUsers)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount
  useEffect(() => {
    refresh();
  }, []);

  const toggleRow = (user: UserInfo) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(user.name)) {
        next.delete(user.name);
      } else {
        next.add(user.name);
        if (!(user.name in privileges)) {
          setLoadingUser(user.name);
          api
            .listPrivileges(connectionId, user.name)
            .then((rows) =>
              setPrivileges((p) => ({ ...p, [user.name]: rows })),
            )
            .catch(() =>
              setPrivileges((p) => ({ ...p, [user.name]: [] })),
            )
            .finally(() => setLoadingUser(null));
        }
      }
      return next;
    });
  };

  const columns = useMemo<ColumnDef<UserInfo>[]>(
    () => [
      {
        id: "expander",
        header: () => null,
        cell: ({ row }) => (
          <button
            className="flex h-4 w-4 items-center justify-center text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              toggleRow(row.original);
            }}
          >
            {expanded.has(row.original.name) ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ),
        enableSorting: false,
        size: 28,
      },
      {
        accessorKey: "name",
        header: t("security.columns.user"),
        cell: ({ getValue }) => (
          <span className="font-medium">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "is_superuser",
        header: t("security.columns.superuser"),
        cell: ({ getValue }) =>
          getValue<boolean>() ? (
            <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
          ) : null,
      },
      {
        accessorKey: "can_login",
        header: t("security.columns.canLogin"),
        cell: ({ getValue }) => (getValue<boolean>() ? "✓" : ""),
      },
      {
        accessorKey: "roles",
        header: t("security.columns.roles"),
        cell: ({ getValue }) => {
          const roles = getValue<string[]>();
          return roles.length ? (
            <span className="text-xs text-muted-foreground">
              {roles.join(", ")}
            </span>
          ) : null;
        },
        enableSorting: false,
      },
    ],
    [expanded, privileges],
  );

  const table = useReactTable({
    data: users ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("security.title")}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={refresh}
          disabled={loading}
          title={t("security.refresh")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-destructive">{error}</div>
      )}

      {!error && users !== null && users.length === 0 && (
        <div className="px-3 py-4 text-xs text-muted-foreground">
          {t("security.empty")}
        </div>
      )}

      {!error && (users === null || users.length > 0) && (
        <div className="flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-background">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="border-b border-border/50">
                  {hg.headers.map((header) => {
                    const sort = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          "px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                          header.column.getCanSort() && "cursor-pointer select-none",
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <span className="inline-flex items-center gap-1">
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() &&
                            (sort === "asc" ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : sort === "desc" ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ArrowUpDown className="h-3 w-3 opacity-30" />
                            ))}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {users === null && (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-3 py-4 text-xs italic text-muted-foreground"
                  >
                    {t("security.loading")}
                  </td>
                </tr>
              )}
              {table.getRowModel().rows.map((row) => {
                const isOpen = expanded.has(row.original.name);
                return (
                  <Fragment key={row.id}>
                    <tr
                      className="cursor-pointer border-b border-border/30 hover:bg-accent/30"
                      onClick={() => toggleRow(row.original)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-1.5">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {isOpen && (
                      <tr className="bg-accent/10">
                        <td />
                        <td colSpan={columns.length - 1} className="px-3 py-2">
                          <PrivilegeList
                            loading={loadingUser === row.original.name}
                            privileges={privileges[row.original.name]}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PrivilegeList({
  loading,
  privileges,
}: {
  loading: boolean;
  privileges: PrivilegeInfo[] | undefined;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="text-xs italic text-muted-foreground">
        {t("security.loadingPrivileges")}
      </div>
    );
  }
  if (!privileges || privileges.length === 0) {
    return (
      <div className="text-xs italic text-muted-foreground">
        {t("security.noPrivileges")}
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="px-2 py-1 text-left font-medium">
            {t("security.columns.privilege")}
          </th>
          <th className="px-2 py-1 text-left font-medium">
            {t("security.columns.target")}
          </th>
        </tr>
      </thead>
      <tbody>
        {privileges.map((p, i) => (
          <tr key={i} className="border-t border-border/20">
            <td className="px-2 py-1">{p.privilege}</td>
            <td className="px-2 py-1 text-muted-foreground">
              {p.schema && p.table
                ? `${p.schema}.${p.table}`
                : p.schema
                  ? `${p.schema}.*`
                  : t("security.targetAll")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
