/**
 * Create/rename dialog for environments — name, color, theme override, and
 * (create-only) replicate-from-current options. The avatar preview at the
 * top (initials over the chosen colour, Teams-style — see
 * `EnvironmentAvatar`) is live: it reflects the name/colour as the user
 * types/picks, before saving.
 *
 * There used to also be a lucide icon picker here; it's gone now that
 * environments render as an initials avatar everywhere (`EnvironmentAvatar`)
 * rather than a generic icon. `EnvironmentDraft.icon`/`Environment.icon`
 * still exist on the wire (a future custom-image upload will use that slot)
 * but this dialog no longer writes to it, and existing values are simply
 * never read for display — see `EnvironmentAvatar`'s header comment.
 *
 * Extracted out of `EnvironmentSwitcher` so `EnvironmentRail`'s "+" button
 * can open the same create flow without duplicating the form; both read/
 * write `useEnvironmentEditor` (see that store) and this is the one place
 * that renders the dialog.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEnvironments, environmentLabel } from "@/stores/session/environments";
import { useEnvironmentEditor } from "@/stores/dialogs/environmentEditor";
import { useThemeStore } from "@/stores/preferences/theme";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { EnvironmentAvatar } from "@/components/connection/EnvironmentAvatar";
import { cn } from "@/lib/utils";

/** Sentinel for "no override" in the theme `<Select>` — Radix rejects an
 *  empty-string item value, so `null` can't be the value directly. */
const NO_THEME_OVERRIDE = "__default__";

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

export function EnvironmentEditorDialog() {
  const { t } = useTranslation();
  const environments = useEnvironments((s) => s.environments);
  const activeId = useEnvironments((s) => s.activeId);
  const createAndEnter = useEnvironments((s) => s.createAndEnter);
  const update = useEnvironments((s) => s.update);
  const customThemes = useThemeStore((s) => s.customThemes);
  const themeChoices = useMemo(
    () => [...BUILT_IN_THEMES, ...customThemes],
    [customThemes],
  );

  const editing = useEnvironmentEditor((s) => s.editing);
  const replicate = useEnvironmentEditor((s) => s.replicate);
  const setReplicate = useEnvironmentEditor((s) => s.setReplicate);
  const patchDraft = useEnvironmentEditor((s) => s.update);
  const close = useEnvironmentEditor((s) => s.close);

  const active = environments.find((e) => e.id === activeId) ?? null;
  const defaultName = t("environments.defaultName");

  async function submitEditor() {
    if (!editing) return;
    const name = editing.name.trim();
    const { color, icon, themeId } = editing;
    if (editing.id) {
      await update({ id: editing.id, name, color, icon, themeId });
      close();
      return;
    }
    if (!name) return;
    // Close first: creating replicates, switches and reconnects, which can take
    // as long as connecting does. Leaving the dialog up over it looks hung.
    close();
    await createAndEnter({ name, color, icon, themeId }, replicate);
  }

  return (
    <Dialog open={!!editing} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {editing?.id
              ? t("environments.renameTitle")
              : t("environments.createTitle")}
          </DialogTitle>
        </DialogHeader>
        {/* Live avatar preview — reflects name/colour as they're picked,
            same rendering `EnvironmentRail`/`EnvironmentSwitcher` use. */}
        <div className="flex items-center gap-3">
          <EnvironmentAvatar
            name={editing?.name.trim() || defaultName}
            color={editing?.color ?? null}
            size={48}
          />
          <Input
            autoFocus
            value={editing?.name ?? ""}
            placeholder={defaultName}
            onChange={(e) => patchDraft({ name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitEditor();
            }}
            className="flex-1"
          />
        </div>

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
                  onClick={() => patchDraft({ color: on ? null : c })}
                />
              );
            })}
            <button
              type="button"
              className={cn(
                "ml-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent",
                !editing?.color && "text-foreground",
              )}
              onClick={() => patchDraft({ color: null })}
            >
              {t("environments.none")}
            </button>
          </div>
        </div>

        {/* Theme override — always optional; "Default" keeps whatever theme
            the user has set in Settings > Appearance. */}
        <div>
          <div className="mb-1.5 text-xs text-muted-foreground">
            {t("environments.theme")}
          </div>
          <Select
            value={editing?.themeId ?? NO_THEME_OVERRIDE}
            onValueChange={(v) =>
              patchDraft({ themeId: v === NO_THEME_OVERRIDE ? null : v })
            }
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_THEME_OVERRIDE}>
                {t("environments.themeDefault")}
              </SelectItem>
              {themeChoices.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Creating only. A new environment starts empty, which is rarely
            what you want when you're spinning one up alongside the work you
            already have open — these carry it over. Editing an existing
            environment must never touch its session, so the block is absent
            there rather than disabled. */}
        {editing && !editing.id && active && (
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
                  setReplicate({ ...replicate, connections: e.target.checked })
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
                  setReplicate({ ...replicate, layout: e.target.checked })
                }
              />
              {t("environments.replicateLayout")}
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
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
  );
}
