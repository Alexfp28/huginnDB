/**
 * Settings → Shortcuts.
 *
 * The list was eight flat rows, which needed no search and no grouping. It is
 * twenty-five now, and it will keep growing, so the surface has to answer the
 * three questions a shortcut list is actually asked: what fires this action,
 * what does this key do, and what have I changed.
 *
 * The third one is why "Reset all" clears the overrides map rather than
 * writing the defaults into it — an override that equals its default is not an
 * override, and the "modified" filter would be lying if it were.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { usePreferences, selectKeybindings } from "@/stores/preferences/preferences";
import {
  ACTIONS,
  CATEGORY_ORDER,
  allBindings,
  chordFromEvent,
  formatForDisplay,
  parseSequence,
  userBindings,
  type ActionId,
  type ActionSpec,
  type Category,
} from "@/lib/keybindings";
import { CaptureShortcutDialog } from "@/components/settings/dialogs/CaptureShortcutDialog";
import { ShortcutRow } from "./ShortcutRow";

type CategoryFilter = Category | "all";

/** What the row-level "+"/chip click is asking the capture dialog to do. */
interface CaptureTarget {
  action: ActionSpec;
  /** The binding being replaced, or `null` when adding another one. */
  replacing: string | null;
}

export function ShortcutsSection() {
  const { t } = useTranslation();
  const keybindings = usePreferences(selectKeybindings);
  const updateKeybindings = usePreferences((s) => s.updateKeybindings);
  const resetKeybindings = usePreferences((s) => s.resetKeybindings);

  const [query, setQuery] = useState("");
  /** When set, the search box is capturing keys and filtering by this chord
   *  instead of by text — the answer to "what does this key already do?". */
  const [keyQuery, setKeyQuery] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const modifiedCount = useMemo(
    () => ACTIONS.filter((a) => keybindings[a.id] !== undefined).length,
    [keybindings],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ACTIONS.filter((action) => {
      if (category !== "all" && action.category !== category) return false;
      if (modifiedOnly && keybindings[action.id] === undefined) return false;
      if (keyQuery) {
        // Match the chord anywhere in a binding, so searching `Mod+K` also
        // surfaces the sequence that starts with it.
        return allBindings(keybindings, action.id).some((b) =>
          parseSequence(b).includes(keyQuery),
        );
      }
      if (!needle) return true;
      const label = t(action.labelKey).toLowerCase();
      return label.includes(needle) || action.id.toLowerCase().includes(needle);
    });
  }, [category, modifiedOnly, keyQuery, query, keybindings, t]);

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      actions: visible.filter((a) => a.category === cat),
    })).filter((g) => g.actions.length > 0);
  }, [visible]);

  /** Write a binding list, dropping the key entirely when it matches the
   *  catalogue — see the note at the top about what "modified" means. */
  function setBindings(id: ActionId, bindings: string[]) {
    const spec = ACTIONS.find((a) => a.id === id);
    const isDefault =
      spec !== undefined &&
      spec.defaults.length === bindings.length &&
      spec.defaults.every((b, i) => b === bindings[i]);
    updateKeybindings({ [id]: isDefault ? undefined : bindings });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          {keyQuery === null ? (
            <>
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                inputSize="sm"
                className="pl-7"
                placeholder={t("settings.shortcuts.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </>
          ) : (
            <div
              className="flex h-8 items-center gap-2 rounded-md border border-brand bg-brand/5 px-2.5 text-xs"
              // Capture-phase, so the chord being searched for is swallowed
              // rather than triggering the very action it is looking for.
              onKeyDownCapture={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const chord = chordFromEvent(e.nativeEvent);
                if (chord !== null) setKeyQuery(chord);
              }}
              tabIndex={0}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              role="searchbox"
              aria-label={t("settings.shortcuts.searchByKey")}
            >
              <Keyboard className="h-3.5 w-3.5 shrink-0 text-brand" />
              {keyQuery ? (
                <span className="font-mono text-brand">{formatForDisplay(keyQuery)}</span>
              ) : (
                <span className="text-muted-foreground">
                  {t("settings.shortcuts.pressKey")}
                </span>
              )}
            </div>
          )}
        </div>

        <FilterChip
          active={keyQuery !== null}
          onClick={() => {
            setKeyQuery(keyQuery === null ? "" : null);
            setQuery("");
          }}
        >
          <Keyboard className="h-3 w-3" />
          {t("settings.shortcuts.searchByKey")}
        </FilterChip>
        <FilterChip active={modifiedOnly} onClick={() => setModifiedOnly((v) => !v)}>
          {t("settings.shortcuts.modifiedOnly", { count: modifiedCount })}
        </FilterChip>
      </div>

      <div className="flex flex-wrap gap-1">
        <FilterChip active={category === "all"} onClick={() => setCategory("all")}>
          {t("settings.shortcuts.categories.all")}
        </FilterChip>
        {CATEGORY_ORDER.map((cat) => (
          <FilterChip
            key={cat}
            active={category === cat}
            onClick={() => setCategory(cat)}
          >
            {t(`settings.shortcuts.categories.${cat}`)}
          </FilterChip>
        ))}
      </div>

      {grouped.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {t("settings.shortcuts.noMatches")}
        </p>
      ) : (
        grouped.map((group) => (
          <div key={group.category}>
            <div className="px-1 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t(`settings.shortcuts.categories.${group.category}`)}
            </div>
            {group.actions.map((action) => (
              <ShortcutRow
                key={action.id}
                action={action}
                bindings={userBindings(keybindings, action.id)}
                isDefault={keybindings[action.id] === undefined}
                onEdit={(replacing) => setCapture({ action, replacing })}
                onRemove={(binding) =>
                  setBindings(
                    action.id,
                    userBindings(keybindings, action.id).filter((b) => b !== binding),
                  )
                }
                onReset={() => updateKeybindings({ [action.id]: undefined })}
              />
            ))}
          </div>
        ))
      )}

      <div className="flex items-center justify-between border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
        <span>
          {t("settings.shortcuts.summary", {
            total: ACTIONS.length,
            modified: modifiedCount,
          })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={modifiedCount === 0}
          onClick={() => setConfirmReset(true)}
        >
          {t("settings.shortcuts.resetAll")}
        </Button>
      </div>

      <CaptureShortcutDialog
        action={capture?.action ?? null}
        keybindings={keybindings}
        replacing={capture?.replacing ?? null}
        onCancel={() => setCapture(null)}
        onSave={(binding, clearFrom) => {
          if (!capture) return;
          const { action, replacing } = capture;
          const current = userBindings(keybindings, action.id);
          const next = replacing
            ? current.map((b) => (b === replacing ? binding : b))
            : [...current, binding];
          // Strip the binding from whatever it collided with, in the same
          // write, so the two can never both be live for a frame.
          const patch: Record<string, string[] | undefined> = {};
          for (const other of clearFrom) {
            patch[other] = userBindings(keybindings, other).filter(
              (b) => parseSequence(b).join(" ") !== binding,
            );
          }
          patch[action.id] = next;
          updateKeybindings(patch);
          setCapture(null);
        }}
      />

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t("settings.shortcuts.resetAll")}
        description={t("settings.shortcuts.resetAllConfirm", { count: modifiedCount })}
        confirmLabel={t("settings.shortcuts.resetAll")}
        onConfirm={() => {
          resetKeybindings();
          setConfirmReset(false);
        }}
      />
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex items-center gap-1 rounded-full border border-brand bg-brand px-2.5 py-0.5 text-[11px] font-medium text-brand-foreground"
          : "flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-brand/60 hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}
