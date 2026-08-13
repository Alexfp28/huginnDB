/**
 * Status-bar dropdown for switching, creating, renaming and deleting
 * environments. Lives in the bottom-left corner, next to `StatusConnections`,
 * so both "what's in play" controls sit together rather than splitting one
 * into the topbar and one into the status bar.
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

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { useEnvironments, environmentLabel } from "@/stores/session/environments";
import { useEnvironmentEditor } from "@/stores/dialogs/environmentEditor";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";

export function EnvironmentSwitcher() {
  const { t } = useTranslation();
  // Primitive / raw-state selectors only (gotcha #1) — the sorted list is
  // derived below with useMemo so its identity stays stable.
  const environments = useEnvironments((s) => s.environments);
  const activeId = useEnvironments((s) => s.activeId);
  const switching = useEnvironments((s) => s.switching);
  const switchTo = useEnvironments((s) => s.switchTo);
  const lastReplicate = useEnvironments((s) => s.lastReplicate);
  const remove = useEnvironments((s) => s.remove);

  const openCreate = useEnvironmentEditor((s) => s.openCreate);
  const openEdit = useEnvironmentEditor((s) => s.openEdit);

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className={cn(
            "flex max-w-[10rem] items-center gap-1.5 rounded-sm px-1 py-0.5 outline-none transition-colors",
            "hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
          )}
          title={t("environments.switcherTooltip")}
        >
          {switching ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: active.color || "hsl(var(--muted-foreground))" }}
            />
          )}
          <span className="truncate">
            {environmentLabel(active, defaultName)}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
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
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: env.color || "hsl(var(--muted-foreground))" }}
              />
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
                  openEdit({
                    id: env.id,
                    name: env.name,
                    color: env.color,
                    icon: env.icon,
                    themeId: env.themeId,
                  });
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
                    // Always asks, regardless of `ui.confirmDestructive`: an
                    // environment's tabs and pane layout exist nowhere else
                    // and can't be rebuilt from the database.
                    if (
                      confirmIrreversible(
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
          onSelect={() => openCreate(lastReplicate)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("environments.create")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
