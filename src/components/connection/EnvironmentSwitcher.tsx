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

import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Check,
  Database,
  FlaskConical,
  Globe,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
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
import { useEnvironments, environmentLabel } from "@/stores/session/environments";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";

/**
 * Accent colours offered for an environment. A fixed palette rather than a
 * free colour picker: these are read at a glance as a 8px dot next to a menu
 * label, so they have to stay distinguishable from each other and legible on
 * both themes — a picker would let the user choose a near-background grey and
 * quietly lose the affordance. Stored as the literal hex; the backend keeps it
 * opaque.
 */
const ENV_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#a855f7",
] as const;

/**
 * Icons offered for an environment, as lucide component keys. Stored by key,
 * never as a rendered glyph, so the set can grow without touching saved data —
 * an unknown key simply renders no icon (see `EnvIcon`).
 */
export const ENV_ICONS = {
  layers: Layers,
  server: Server,
  database: Database,
  flask: FlaskConical,
  building: Building2,
  globe: Globe,
} as const;

export type EnvIconKey = keyof typeof ENV_ICONS;

/** Render an environment's icon, or nothing when unset/unrecognised. */
export function EnvIcon({
  icon,
  className,
  style,
}: {
  icon: string | null;
  className?: string;
  style?: CSSProperties;
}) {
  const Cmp = icon ? ENV_ICONS[icon as EnvIconKey] : undefined;
  return Cmp ? <Cmp className={className} style={style} /> : null;
}

interface EnvironmentDraft {
  /** `null` creates; an id edits that environment. */
  id: string | null;
  name: string;
  color: string | null;
  icon: string | null;
}

export function EnvironmentSwitcher() {
  const { t } = useTranslation();
  // Primitive / raw-state selectors only (gotcha #1) — the sorted list is
  // derived below with useMemo so its identity stays stable.
  const environments = useEnvironments((s) => s.environments);
  const activeId = useEnvironments((s) => s.activeId);
  const switching = useEnvironments((s) => s.switching);
  const switchTo = useEnvironments((s) => s.switchTo);
  const createAndEnter = useEnvironments((s) => s.createAndEnter);
  const lastReplicate = useEnvironments((s) => s.lastReplicate);
  const update = useEnvironments((s) => s.update);
  /** Seeded from the last choice each time the create dialog opens. */
  const [replicate, setReplicate] = useState(lastReplicate);
  const remove = useEnvironments((s) => s.remove);

  /** Open editor: `{ id: null }` creates, `{ id }` edits an existing one. */
  const [editing, setEditing] = useState<EnvironmentDraft | null>(null);

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
    const { color, icon } = editing;
    if (editing.id) {
      await update({ id: editing.id, name, color, icon });
      setEditing(null);
      return;
    }
    if (!name) return;
    // Close first: creating replicates, switches and reconnects, which can take
    // as long as connecting does. Leaving the dialog up over it looks hung.
    setEditing(null);
    await createAndEnter({ name, color, icon }, replicate);
  }

  return (
    <>
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
            ) : active.icon ? (
              // The active environment's own icon replaces the generic one, so
              // the trigger is identifiable at a glance without reading it.
              <EnvIcon
                icon={active.icon}
                className="h-3 w-3 shrink-0"
                style={active.color ? { color: active.color } : undefined}
                />
            ) : (
              <Layers
                className="h-3 w-3 shrink-0"
                style={active.color ? { color: active.color } : undefined}
              />
            )}
            <span
              className="truncate"
              style={active.color ? { color: active.color } : undefined}
            >
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
                {env.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: env.color }}
                  />
                )}
                <EnvIcon
                  icon={env.icon}
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  style={env.color ? { color: env.color } : undefined}
                />
                <span
                  className="min-w-0 flex-1 truncate"
                  style={env.color ? { color: env.color } : undefined}
                >
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
                    setEditing({
                      id: env.id,
                      name: env.name,
                      color: env.color,
                      icon: env.icon,
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
            onSelect={() => {
              setReplicate(lastReplicate);
              setEditing({ id: null, name: "", color: null, icon: null });
            }}
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

          {/* Colour — click the selected swatch again to clear it. */}
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t("environments.color")}
            </div>
            <div className="flex items-center gap-1.5">
              {ENV_COLORS.map((c) => {
                const on = editing?.color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    aria-pressed={on}
                    className={cn(
                      "h-5 w-5 rounded-full ring-offset-2 ring-offset-background",
                      on && "ring-2 ring-foreground",
                    )}
                    style={{ backgroundColor: c }}
                    onClick={() =>
                      setEditing((p) =>
                        p ? { ...p, color: on ? null : c } : p,
                      )
                    }
                  />
                );
              })}
              <button
                type="button"
                className={cn(
                  "ml-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent",
                  !editing?.color && "text-foreground",
                )}
                onClick={() => setEditing((p) => (p ? { ...p, color: null } : p))}
              >
                {t("environments.none")}
              </button>
            </div>
          </div>

          {/* Icon — same toggle-to-clear behaviour. */}
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t("environments.icon")}
            </div>
            <div className="flex items-center gap-1">
              {(Object.keys(ENV_ICONS) as EnvIconKey[]).map((key) => {
                const on = editing?.icon === key;
                const Cmp = ENV_ICONS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={key}
                    aria-pressed={on}
                    className={cn(
                      "rounded p-1.5 hover:bg-accent",
                      on && "bg-accent text-foreground",
                    )}
                    onClick={() =>
                      setEditing((p) =>
                        p ? { ...p, icon: on ? null : key } : p,
                      )
                    }
                  >
                    <Cmp className="h-4 w-4" />
                  </button>
                );
              })}
              <button
                type="button"
                className={cn(
                  "ml-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent",
                  !editing?.icon && "text-foreground",
                )}
                onClick={() => setEditing((p) => (p ? { ...p, icon: null } : p))}
              >
                {t("environments.none")}
              </button>
            </div>
          </div>
          {/* Creating only. A new environment starts empty, which is rarely
              what you want when you're spinning one up alongside the work you
              already have open — these carry it over. Editing an existing
              environment must never touch its session, so the block is absent
              there rather than disabled. */}
          {editing && !editing.id && (
            <div className="space-y-1.5 rounded-md border border-border p-2.5">
              <div className="text-xs text-muted-foreground">
                {t("environments.replicateFrom", {
                  name: environmentLabel(active, defaultName),
                })}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={replicate.connections}
                  onChange={(e) =>
                    setReplicate((r) => ({ ...r, connections: e.target.checked }))
                  }
                />
                {t("environments.replicateConnections")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={replicate.layout}
                  onChange={(e) =>
                    setReplicate((r) => ({ ...r, layout: e.target.checked }))
                  }
                />
                {t("environments.replicateLayout")}
              </label>
            </div>
          )}

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
