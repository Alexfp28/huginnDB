/**
 * Sidebar panel listing the user's saved queries with search, edit,
 * delete, and "open in new tab" actions. Backed by the
 * `useSavedQueries` zustand store (persisted to localStorage).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, Pencil, Play, Search, Trash2 } from "lucide-react";
import { useSavedQueries, type SavedQuery } from "@/stores/savedQueries";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SaveQueryDialog } from "@/components/SaveQueryDialog";

export function SavedQueriesPanel({
  connectionId,
}: {
  connectionId: string | null;
}) {
  const { t } = useTranslation();
  const items = useSavedQueries((s) => s.items);
  const remove = useSavedQueries((s) => s.remove);
  const openTab = useTabs((s) => s.open);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<SavedQuery | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const filtered = useMemo(() => {
    if (!filter.trim()) return items;
    const q = filter.toLowerCase();
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q)) ||
        i.sql.toLowerCase().includes(q),
    );
  }, [items, filter]);

  function runQuery(q: SavedQuery) {
    if (!connectionId) {
      alert(t("saved.connectFirst"));
      return;
    }
    openTab({
      kind: "query",
      title: q.name,
      connectionId,
      query: q.sql,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("saved.title")}
        </div>
        <span className="text-[10px] text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("saved.filterPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {items.length === 0
              ? t("saved.emptyNone")
              : t("saved.emptyNoMatch")}
          </div>
        )}
        {filtered.map((q) => (
          <div
            key={q.id}
            className="group border-b border-border/40 px-3 py-2 hover:bg-accent/30"
          >
            <div className="flex items-start gap-2">
              <Bookmark className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{q.name}</div>
                {q.description && (
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">
                    {q.description}
                  </div>
                )}
                {q.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {q.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => runQuery(q)}
                  title={t("saved.openInTab")}
                >
                  <Play className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => {
                    setEditing(q);
                    setDialogOpen(true);
                  }}
                  title={t("saved.edit")}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => {
                    if (confirm(t("saved.deleteConfirm", { name: q.name })))
                      remove(q.id);
                  }}
                  title={t("saved.delete")}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <SaveQueryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sql={editing?.sql ?? ""}
        connectionId={editing?.connectionId ?? connectionId}
        existing={editing}
      />
    </div>
  );
}
