/**
 * Topbar dropdown for switching, creating, renaming and deleting environments.
 *
 * Rendered only in the main window: an environment scopes `tab_state.json`,
 * which secondary "New window" instances never touch (gotcha #8), so offering
 * the control there would suggest a switch that cannot happen.
 *
 * Switching tears down every live pool and rebuilds the incoming session, which
 * takes as long as reconnecting does. The trigger therefore reflects
 * `switching` — spinner, disabled — rather than looking instantaneous and
 * leaving the user clicking again mid-teardown.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Layers, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEnvironments, environmentLabel } from "@/stores/environments";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";

export function EnvironmentSwitcher() {
  const { t } = useTranslation();
  // Primitive / raw-state selectors only (gotcha #1) — the sorted list is
  // derived below with useMemo so its identity stays stable.
  const environments = useEnvironments((s) => s.environments);
  const activeId = useEnvironments((s) => s.activeId);
  const switching = useEnvironments((s) => s.switching);
  const switchTo = useEnvironments((s) => s.switchTo);
  const create = useEnvironments((s) => s.create);
  const update = useEnvironments((s) => s.update);
  const remove = useEnvironments((s) => s.remove);

  /** Open editor: `{ id: null }` creates, `{ id }` renames. */
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(
    null,
  );

  const ordered = useMemo(
    () => [...environments].sort((a, b) => a.order - b.order),
    [environments],
  );
  const active = useMemo(
    () => environments.find((e) => e.id === activeId) ?? null,
    [environments, activeId],
  );

  const defaultName = t("environments.defaultName");

  // Nothing useful to show before the first load resolves, and secondary windows
  // don't own an environment at all.
  if (getCurrentWindow().label !== "main") return null;
  if (!active) return null;

  async function submitEditor() {
    if (!editing) return;
    const name = editing.name.trim();
    if (editing.id) await update({ id: editing.id, name });
    else if (name) await create(name);
    setEditing(null);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={switching}
            className={cn(
              "flex h-6 max-w-[14rem] items-center gap-1.5 rounded px-2 text-xs",
              "hover:bg-accent disabled:opacity-60",
            )}
            title={t("environments.switcherTooltip")}
          >
            {switching ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Layers className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">
              {environmentLabel(active, defaultName)}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {ordered.map((env) => {
            const isActive = env.id === activeId;
            return (
              <DropdownMenuItem
                key={env.id}
                className="group/env gap-2"
                // Radix closes on select; `switchTo` is async and no-ops when
                // the id is already active.
                onSelect={() => void switchTo(env.id)}
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                />
                {env.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: env.color }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {environmentLabel(env, defaultName)}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 opacity-0 group-hover/env:opacity-70 hover:!opacity-100"
                  title={t("environments.rename")}
                  onClick={(e) => {
                    // Keep the menu open and don't trigger the row's switch.
                    e.preventDefault();
                    e.stopPropagation();
                    setEditing({ id: env.id, name: env.name });
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </span>
                {ordered.length > 1 && (
                  <span
                    role="button"
                    tabIndex={-1}
                    className="shrink-0 opacity-0 group-hover/env:opacity-70 hover:!opacity-100"
                    title={t("environments.delete")}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Discards this environment's tabs and layout. Connection
                      // profiles and credentials are untouched, and the prompt
                      // says so — the word "environment" alone could easily read
                      // as "delete these connections".
                      if (
                        confirmDestructive(
                          t("environments.deleteConfirm", {
                            name: environmentLabel(env, defaultName),
                          }),
                        )
                      ) {
                        void remove(env.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => setEditing({ id: null, name: "" })}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("environments.create")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {editing?.id
                ? t("environments.renameTitle")
                : t("environments.createTitle")}
            </DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={editing?.name ?? ""}
            placeholder={defaultName}
            onChange={(e) =>
              setEditing((prev) => (prev ? { ...prev, name: e.target.value } : prev))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitEditor();
            }}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              // Renaming to empty is allowed — it clears the user's name and the
              // localised default takes over. Creating one is not: an unnamed new
              // environment would be indistinguishable from the default.
              disabled={!editing?.id && !editing?.name.trim()}
              onClick={() => void submitEditor()}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
