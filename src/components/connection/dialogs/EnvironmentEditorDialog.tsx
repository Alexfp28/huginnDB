/**
 * Create/rename dialog for environments — name, avatar image, color, theme
 * override, and (create-only) replicate-from-current options. The avatar
 * preview at the top (the custom image, or initials over the chosen colour
 * Teams-style — see `EnvironmentAvatar`) is live: it reflects the
 * name/image/colour as the user types/picks, before saving.
 *
 * The avatar image writes to `EnvironmentDraft.icon`, the slot the old lucide
 * icon picker used to own — see `lib/environmentAvatar.ts` for why it is stored
 * inline as a downscaled `data:` URL and what happens to legacy icon keys.
 * Two ways in, because they cost nothing to share: the native picker, and
 * dropping a file on the preview.
 *
 * Extracted out of `EnvironmentSwitcher` so `EnvironmentRail`'s "+" button
 * can open the same create flow without duplicating the form; both read/
 * write `useEnvironmentEditor` (see that store) and this is the one place
 * that renders the dialog.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { ImagePlus, X } from "lucide-react";
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
import {
  useEnvironments,
  environmentLabel,
} from "@/stores/session/environments";
import { useEnvironmentEditor } from "@/stores/dialogs/environmentEditor";
import { useThemeStore } from "@/stores/preferences/theme";
import { BUILT_IN_THEMES } from "@/lib/themes";
import { EnvironmentAvatar } from "@/components/connection/EnvironmentAvatar";
import {
  avatarImageFromFile,
  isAvatarImage,
  pickAvatarImage,
} from "@/lib/environmentAvatar";
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
  const setLocalOverrides = useEnvironments((s) => s.setLocalOverrides);
  /** Editing a mirrored environment's cosmetics writes a local override
   *  instead of the synced fields — see `EnvironmentDraft.originId`. */
  const isMirrored = !!editing?.originId;

  /** Purely visual drop affordance on the preview tile. */
  const [dragOver, setDragOver] = useState(false);

  const active = environments.find((e) => e.id === activeId) ?? null;
  const defaultName = t("environments.defaultName");
  const hasImage = isAvatarImage(editing?.icon);

  async function chooseImage() {
    try {
      const icon = await pickAvatarImage(t("environments.imagePickTitle"));
      if (icon) patchDraft({ icon });
    } catch (e) {
      notify.error(t("environments.imageError", { error: String(e) }));
    }
  }

  async function dropImage(file: File | undefined) {
    if (!file) return;
    try {
      patchDraft({ icon: await avatarImageFromFile(file) });
    } catch (e) {
      notify.error(t("environments.imageError", { error: String(e) }));
    }
  }

  async function submitEditor() {
    if (!editing) return;
    const name = editing.name.trim();
    const { color, icon, themeId } = editing;
    if (editing.id) {
      if (isMirrored) {
        // Never touches the synced name/color/icon/theme — those still
        // follow the origin. This only records this machine's own
        // preference over them.
        await setLocalOverrides({
          id: editing.id,
          localName: name || null,
          localColor: color,
          localIcon: icon,
          localThemeId: themeId,
        });
      } else {
        await update({ id: editing.id, name, color, icon, themeId });
      }
      close();
      return;
    }
    if (!name) return;
    // Close first: creating replicates, switches and reconnects, which can take
    // as long as connecting does. Leaving the dialog up over it looks hung.
    close();
    await createAndEnter({ name, color, icon, themeId }, replicate);
  }

  /** Drop every local override for the environment being edited, falling
   *  back to whatever the origin publishes. Only offered for a mirrored
   *  environment — a plain local one has no synced value to fall back to. */
  async function clearLocalOverrides() {
    if (!editing?.id) return;
    await setLocalOverrides({
      id: editing.id,
      localName: null,
      localColor: null,
      localIcon: null,
      localThemeId: null,
    });
    close();
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
        {isMirrored && (
          <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
            {t("environments.mirroredCosmeticsHint")}
          </p>
        )}
        {/* Live avatar preview — reflects name/image/colour as they're picked,
            same rendering `EnvironmentRail`/`EnvironmentSwitcher` use. It is
            also the drop target for an image file: dropping on the thing that
            shows the result is the affordance users try first, and the button
            below covers the case where they don't. */}
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "relative shrink-0 rounded-[13px] outline-offset-2 transition-colors",
              dragOver && "outline-dashed outline-2 outline-brand",
            )}
            onDragOver={(e) => {
              // Both handlers must preventDefault or the webview navigates to
              // the dropped file instead of handing it to us.
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              // `dragleave` also fires when the pointer crosses into a child
              // (the avatar itself, the clear button), which would flicker the
              // outline off and on for the whole hover.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOver(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void dropImage(e.dataTransfer.files[0]);
            }}
          >
            <EnvironmentAvatar
              name={editing?.name.trim() || defaultName}
              color={editing?.color ?? null}
              icon={editing?.icon ?? null}
              size={48}
            />
            {hasImage && (
              <button
                type="button"
                title={t("environments.imageRemove")}
                aria-label={t("environments.imageRemove")}
                // Clearing writes `null`, not the previous lucide key: the icon
                // picker is gone, so "no image" is the only other state.
                onClick={() => patchDraft({ icon: null })}
                className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground shadow-elevation-1 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Input
              autoFocus
              value={editing?.name ?? ""}
              placeholder={defaultName}
              onChange={(e) => patchDraft({ name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitEditor();
              }}
            />
            <button
              type="button"
              onClick={() => void chooseImage()}
              className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              {hasImage
                ? t("environments.imageReplace")
                : t("environments.imageUpload")}
            </button>
          </div>
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
          {isMirrored && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground"
              onClick={() => void clearLocalOverrides()}
            >
              {t("environments.clearLocalOverride")}
            </Button>
          )}
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
