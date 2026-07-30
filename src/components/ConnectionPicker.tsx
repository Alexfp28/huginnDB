/**
 * Searchable, folder-grouped list of saved connections (#110).
 *
 * Built for the empty workspace, which showed a logo and a disabled "New query"
 * button — nothing to act on when you had just opened the app. This turns that
 * screen into somewhere you can start: type, pick a connection, and you're on it.
 *
 * Deliberately flatter than [[ConnectionsTree]] in the sidebar: folders and
 * connections, and no schema underneath. Its job is to *choose* a connection, not
 * to browse one, and rendering live subtrees behind a watermark that vanishes the
 * moment a tab opens would be work thrown away.
 *
 * Folders come from the same `bucketByGroup` + `useConnectionGroupCollapse` pair
 * as everywhere else, so a folder folded here is folded in the tree, the File
 * menu and the status bar. While a search is active the folds are ignored: a
 * result hidden inside a collapsed folder reads as "no match".
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useConnectionGroupCollapse } from "@/lib/useConnectionGroups";
import { connectAndWarm } from "@/lib/connectFlow";
import { bucketByGroup, cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DriverBadge } from "@/components/DriverBadge";
import type { ConnectionProfile } from "@/types";

export function ConnectionPicker({
  className,
  onPicked,
}: {
  className?: string;
  /** Fired after a connection is focused — connected first if it wasn't. */
  onPicked?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const groupCollapse = useConnectionGroupCollapse();

  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;

  // Match the folder name too, so typing a client's folder surfaces everything
  // in it rather than only the connections that repeat the name.
  const matches = useMemo(
    () =>
      needle
        ? profiles.filter(
            (p) =>
              p.name.toLowerCase().includes(needle) ||
              (p.group ?? "").toLowerCase().includes(needle),
          )
        : profiles,
    [profiles, needle],
  );
  const buckets = useMemo(() => bucketByGroup(matches), [matches]);

  async function pick(p: ConnectionProfile) {
    if (connecting) return;
    if (!active.has(p.id)) {
      setConnecting(p.id);
      const ok = await connectAndWarm(p.id);
      setConnecting(null);
      if (!ok) return;
    }
    setSelected(p.id);
    onPicked?.(p.id);
  }

  function Row({ p, indented }: { p: ConnectionProfile; indented: boolean }) {
    const isActive = active.has(p.id);
    return (
      <button
        type="button"
        onClick={() => void pick(p)}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm py-1 pr-2 text-left text-xs transition-colors hover:bg-accent/50",
          indented ? "pl-6" : "pl-2",
          selected === p.id && "bg-brand/10",
        )}
      >
        {connecting === p.id ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              isActive ? "bg-brand" : "bg-muted-foreground/30",
            )}
          />
        )}
        <span
          className={cn(
            "flex-1 truncate",
            isActive ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {p.name}
        </span>
        <DriverBadge driver={p.driver} />
      </button>
    );
  }

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("connectionDialog.searchPlaceholder")}
        className="h-7 text-xs"
      />
      <div className="max-h-64 overflow-y-auto">
        {matches.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs italic text-muted-foreground">
            {searching ? t("commandPalette.noResults") : t("connectionsTree.empty")}
          </div>
        ) : (
          <>
            {buckets.ungrouped.map((p) => (
              <Row key={p.id} p={p} indented={false} />
            ))}
            {buckets.groups.map(({ name, items }) => {
              const collapsed = !searching && groupCollapse.isCollapsed(name);
              return (
                <div key={name}>
                  <button
                    type="button"
                    onClick={() => groupCollapse.toggle(name)}
                    disabled={searching}
                    className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground"
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    )}
                    <span className="truncate">{name}</span>
                    <span className="text-muted-foreground/60">
                      ({items.length})
                    </span>
                  </button>
                  {!collapsed &&
                    items.map((p) => <Row key={p.id} p={p} indented />)}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
