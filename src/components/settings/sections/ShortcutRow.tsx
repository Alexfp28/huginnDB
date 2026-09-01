/**
 * One action's row: every binding that fires it, as removable chips, plus a
 * "+" to add another.
 *
 * Two kinds of chip, and the difference is the point. A user binding is a
 * button — click it to re-record, click its × to drop it. A `fixed` binding
 * (today only `Mod+R`, which keeps the WebView from reloading the app) is
 * dimmed and inert: it is *shown* rather than hidden, because a shortcut the
 * user cannot discover is a shortcut they will report as a bug.
 *
 * Recording itself lives in `CaptureShortcutDialog` — a row cannot capture
 * inline any more, because a chord sequence needs somewhere to show its
 * progress.
 */

import { useTranslation } from "react-i18next";
import { Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatForDisplay, type ActionSpec } from "@/lib/keybindings";
import { PrefRow } from "./PrefRow";

interface Props {
  action: ActionSpec;
  /** User-editable bindings, primary first. May be empty (unbound). */
  bindings: string[];
  isDefault: boolean;
  /** `null` adds a binding; a string re-records that one. */
  onEdit: (replacing: string | null) => void;
  onRemove: (binding: string) => void;
  onReset: () => void;
}

export function ShortcutRow({
  action,
  bindings,
  isDefault,
  onEdit,
  onRemove,
  onReset,
}: Props) {
  const { t } = useTranslation();

  return (
    <PrefRow
      label={t(action.labelKey)}
      // Anchor for the command palette's "Shortcut: …" entries — mirrors the
      // `keybinding.<id>` prefIds its settings registry emits for `ACTIONS`.
      prefId={`keybinding.${action.id}`}
      description={action.descKey ? t(action.descKey) : undefined}
    >
      {/* `PrefRow` puts its control column in a `shrink-0`, so this container
          sizes to max-content and `flex-wrap` alone would never trigger. The
          cap is what makes it wrap: an action with three or four aliases
          squeezes the label otherwise. */}
      <div className="flex max-w-[20rem] flex-wrap items-center justify-end gap-1">
        <span
          className="rounded-sm border border-border/60 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70"
          title={t(`settings.shortcuts.scopes.${action.scope}`)}
        >
          {action.scope}
        </span>

        {bindings.length === 0 && (action.fixed ?? []).length === 0 && (
          <button
            type="button"
            onClick={() => onEdit(null)}
            className="rounded-sm border border-dashed border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-brand hover:text-foreground"
          >
            {t("settings.shortcuts.unassigned")}
          </button>
        )}

        {bindings.map((binding) => (
          <span
            key={binding}
            className="group flex items-center rounded-sm border border-border bg-muted font-mono text-[11px] text-muted-foreground focus-within:border-brand hover:border-brand"
          >
            <button
              type="button"
              onClick={() => onEdit(binding)}
              title={t("settings.shortcuts.rebind")}
              className="px-1.5 py-0.5 hover:text-foreground"
            >
              {formatForDisplay(binding)}
            </button>
            <button
              type="button"
              onClick={() => onRemove(binding)}
              title={t("settings.shortcuts.removeBinding")}
              className="px-1 py-0.5 text-muted-foreground/50 hover:text-destructive"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}

        {action.fixed?.map((binding) => (
          <span
            key={binding}
            title={t("settings.shortcuts.fixedHint")}
            className="rounded-sm border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground/50"
          >
            {formatForDisplay(binding)}
          </span>
        ))}

        <Button
          variant="ghost"
          size="icon"
          title={t("settings.shortcuts.addBinding")}
          onClick={() => onEdit(null)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={isDefault}
          title={t("settings.shortcuts.resetToDefault")}
          onClick={onReset}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </PrefRow>
  );
}
