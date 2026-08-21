/**
 * Left rail of the connection manager: the saved connections, searchable and
 * grouped, plus the multi-selection and its bulk delete.
 *
 * Split out of `ConnectionDialog`, where it accounted for a third of the
 * component while sharing nothing with the editor beside it except "which
 * profile is being edited". That is the whole contract now: `editingId` in,
 * `onEdit` out. Everything else — the search term, the selection, the range
 * anchor, the group collapse — is rail-local and was never read by the form.
 *
 * Selection follows the OS/data-grid convention: plain click selects one and
 * opens it, Ctrl/Cmd toggles into the multi-selection, Shift extends from the
 * last anchor over the *visible* rows (a collapsed group is not in the range).
 * Bulk delete always confirms, regardless of the "confirm destructive actions"
 * preference — deleting connections is destructive either way.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { DriverBadge } from "@/components/common/DriverBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sqliteFileLabel } from "@/lib/connectionLabel";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import { bucketByGroup, cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

export function ConnectionRail({
  profiles,
  active,
  editingId,
  onEdit,
  removeProfile,
}: {
  profiles: ConnectionProfile[];
  /** Ids with a live pool — drives the per-row status dot. */
  active: Set<string>;
  /** Profile open in the editor, or `null` for a new draft. */
  editingId: string | null;
  onEdit: (id: string | null) => void;
  /** `useConnections.remove`, for the bulk delete. */
  removeProfile: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();

  // Left-rail: search filter + multi-selection for bulk delete (#39/#43).
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  /** Anchor for Shift-range selection over the visible (non-collapsed) rows. */
  const lastClickedRef = useRef<string | null>(null);
  const groupCollapse = useConnectionGroupCollapse();
  // Dropping the editor to a new draft — "New connection", or `onDuplicate`
  // seeding a clone — means the rows below are no longer what is on screen, so
  // the selection goes with it. Ctrl/Shift-click never lands here: those always
  // set an id, so the multi-selection they build is never clobbered.
  useEffect(() => {
    if (editingId === null) setSelectedIds(new Set());
  }, [editingId]);

  const searching = search.trim().length > 0;

  /** Profiles matching the rail search box (name / host / database / group). */
  const filteredProfiles = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return profiles;
    return profiles.filter((p) =>
      [p.name, p.host, p.database, p.group, p.connection_string]
        .filter((x): x is string => !!x)
        .some((x) => x.toLowerCase().includes(term)),
    );
  }, [profiles, search]);

  const buckets = useMemo(
    () => bucketByGroup(filteredProfiles),
    [filteredProfiles],
  );

  /** Ids in render order, skipping collapsed groups — the domain over which
   *  Shift-range selection operates. An active search force-expands groups. */
  const visibleIds = useMemo(() => {
    const ids = buckets.ungrouped.map((p) => p.id);
    for (const g of buckets.groups) {
      const collapsed = !searching && groupCollapse.isCollapsed(g.name);
      if (!collapsed) ids.push(...g.items.map((p) => p.id));
    }
    return ids;
  }, [buckets, searching, groupCollapse]);

  /** Rail row click: plain = single-select + edit; Ctrl/Cmd = toggle into the
   *  multi-selection; Shift = range from the last anchor (OS-style, mirrors
   *  the data grid). */
  function onRowClick(id: string, e: React.MouseEvent) {
    if (e.shiftKey && lastClickedRef.current) {
      const a = visibleIds.indexOf(lastClickedRef.current);
      const b = visibleIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = visibleIds.slice(lo, hi + 1);
        setSelectedIds((prev) => new Set([...prev, ...range]));
      }
      onEdit(id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastClickedRef.current = id;
      onEdit(id);
      return;
    }
    setSelectedIds(new Set([id]));
    lastClickedRef.current = id;
    onEdit(id);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedRef.current = id;
  }

  /** Bulk-delete the multi-selection. Always confirmed via `bulkDeleteOpen`'s
   *  dialog, ignoring the "confirm destructive actions" preference — deleting
   *  connections is destructive regardless. */
  function onBulkDelete() {
    if (selectedIds.size === 0) return;
    setBulkDeleteOpen(true);
  }

  async function performBulkDelete() {
    const ids = Array.from(selectedIds);
    setBulkDeleting(true);
    try {
      for (const id of ids) {
        try {
          await removeProfile(id);
        } catch {
          // Best-effort: one keychain/disk failure shouldn't abort the rest.
        }
      }
      if (editingId && selectedIds.has(editingId)) onEdit(null);
      setSelectedIds(new Set());
      lastClickedRef.current = null;
    } finally {
      setBulkDeleting(false);
      setBulkDeleteOpen(false);
    }
  }

  /** One connection row in the rail. A `<div role="button">` rather than a
   *  `<button>` so the selection `<input type="checkbox">` can nest legally. */
  function renderRow(p: ConnectionProfile) {
    const isActive = active.has(p.id);
    const selected = editingId === p.id;
    const checked = selectedIds.has(p.id);
    const multi = selectedIds.size > 1;
    const subline =
      p.driver === "sqlite"
        ? sqliteFileLabel(p.database)
        : p.driver === "mongodb"
          ? p.connection_string || `${p.host}:${p.port}`
          : `${p.host}:${p.port}/${p.database}`;
    return (
      <div
        key={p.id}
        role="button"
        tabIndex={0}
        onClick={(e) => onRowClick(p.id, e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onEdit(p.id);
            setSelectedIds(new Set([p.id]));
            lastClickedRef.current = p.id;
          }
        }}
        className={cn(
          "group/row flex w-full cursor-pointer items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors",
          selected
            ? "border-primary bg-accent/40"
            : "border-transparent hover:bg-accent/30",
          checked && multi && "bg-accent/60",
        )}
      >
        {/* Checkbox reveals on hover / when selected; otherwise the live
            "connected" status dot occupies the same slot (grid convention). */}
        <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleSelect(p.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("connections.selectConnection", { name: p.name })}
            className={cn(
              "accent-brand cursor-pointer",
              checked ? "inline-block" : "hidden group-hover/row:inline-block",
            )}
          />
          <span
            className={cn(
              "absolute h-1.5 w-1.5 rounded-full",
              isActive ? "bg-brand" : "bg-muted-foreground/40",
              checked ? "hidden" : "group-hover/row:hidden",
            )}
            title={isActive ? t("connections.disconnectTooltip") : undefined}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{p.name}</span>
            <DriverBadge driver={p.driver} />
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {subline}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Left rail — saved connections (searchable, grouped tree) + new */}
      <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
        <div className="px-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => onEdit(null)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("connectionDialog.newConnection")}
          </Button>
        </div>
        {profiles.length > 0 && (
          <div className="px-2 pt-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("connectionDialog.searchPlaceholder")}
                className="h-8 pl-7 pr-7 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label={t("common.clear")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="mt-1 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("connectionDialog.listTitle")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {profiles.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-muted-foreground">
              {t("connectionDialog.emptyList")}
            </div>
          ) : filteredProfiles.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-muted-foreground">
              {t("connectionDialog.noMatches")}
            </div>
          ) : (
            <>
              {buckets.ungrouped.map(renderRow)}
              {buckets.groups.map(({ name, items }) => {
                const collapsed =
                  !searching && groupCollapse.isCollapsed(name);
                return (
                  <div key={name}>
                    <button
                      type="button"
                      onClick={() => groupCollapse.toggle(name)}
                      className="flex w-full items-center gap-1 px-3 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                    >
                      {collapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      <Folder className="h-3 w-3 shrink-0" />
                      <span className="truncate">{name}</span>
                      <span className="text-muted-foreground/60">
                        ({items.length})
                      </span>
                    </button>
                    {!collapsed && items.map(renderRow)}
                  </div>
                );
              })}
            </>
          )}
        </div>
        {selectedIds.size > 1 && (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {t("connections.selectedCount", { count: selectedIds.size })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 gap-1 px-2 text-destructive hover:text-destructive"
              onClick={onBulkDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("connectionDialog.delete")}
            </Button>
          </div>
        )}
      </aside>
    <ConfirmDialog
      open={bulkDeleteOpen}
      onOpenChange={setBulkDeleteOpen}
      title={t("connections.bulkDeleteTitle", { count: selectedIds.size })}
      description={t("connections.bulkDeleteConfirm", { count: selectedIds.size })}
      confirmLabel={t("connectionDialog.delete")}
      confirming={bulkDeleting}
      onConfirm={() => void performBulkDelete()}
    />
    </>
  );
}
