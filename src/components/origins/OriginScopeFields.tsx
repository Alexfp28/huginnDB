/**
 * The three slices of a shared origin a machine can subscribe to (#171), plus
 * the preview of what the file behind them actually holds.
 *
 * Shared by the "add origin" and "edit registration" forms in `OriginsSection`,
 * which ask the same question with two different defaults — a new registration
 * starts at everything, an existing one at whatever it already pulls.
 *
 * The preview is not decoration. Offering a subscription to "environments"
 * without saying whether the file publishes any makes the choice a guess, and
 * the interesting answer ("this file only carries connections anyway") is
 * otherwise invisible until after the first sync.
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, FileJson, Layers } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/tauri";
import { useDebouncedPreview } from "@/lib/useDebouncedPreview";
import { scopeWarnings, slicesAvailable } from "@/lib/origins/scope";
import type { OriginPeek, OriginScope } from "@/types";

/** What `useOriginPeek` knows about the path currently in the form. */
interface PeekState {
  peek: OriginPeek | null;
  /** The backend's own message. An unreachable share while a UNC path is half
   *  typed is the normal case, so this renders as a hint, never as an error. */
  error: string | null;
  loading: boolean;
}

/**
 * Read the file at `path` on a debounce, without registering anything.
 *
 * Two things here are load-bearing. The result is **discarded when the path has
 * moved on** — otherwise a slow read of a wrong path lands on top of a fast
 * read of the right one and the form describes a file the user is no longer
 * pointing at. And an empty path resets to "unknown" rather than keeping the
 * last successful peek, so clearing the field cannot leave stale counts
 * standing next to an empty input.
 */
export function useOriginPeek(path: string): PeekState {
  const [state, setState] = useState<PeekState>({
    peek: null,
    error: null,
    loading: false,
  });
  // Compared on arrival rather than cancelling in flight: the IPC call has no
  // abort, so the only correct thing to do with a stale answer is to drop it.
  const wanted = useRef(path);
  wanted.current = path;

  const run = useCallback(() => {
    const trimmed = path.trim();
    if (!trimmed) {
      setState({ peek: null, error: null, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    api
      .peekOriginFile(trimmed)
      .then((peek) => {
        if (wanted.current.trim() !== trimmed) return;
        setState({ peek, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (wanted.current.trim() !== trimmed) return;
        setState({ peek: null, error: String(e), loading: false });
      });
  }, [path]);

  useDebouncedPreview(path, run);
  return state;
}

/** One slice's row: a checkbox, what it does, and how much of it the file has. */
function SliceRow({
  checked,
  disabled,
  onChange,
  icon: Icon,
  label,
  hint,
  count,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  icon: typeof Database;
  label: string;
  hint: string;
  count: string | null;
}) {
  return (
    <label
      className={
        disabled
          ? "flex items-start gap-2 text-2xs opacity-50"
          : "flex items-start gap-2 text-2xs"
      }
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {label}
          {count && (
            <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-3xs text-muted-foreground">
              {count}
            </span>
          )}
        </span>
        <span className="block text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export function OriginScopeFields({
  value,
  onChange,
  path,
}: {
  value: OriginScope;
  onChange: (next: OriginScope) => void;
  /** The path the form currently holds, previewed as it changes. */
  path: string;
}) {
  const { t } = useTranslation();
  const { peek, error, loading } = useOriginPeek(path);
  const available = slicesAvailable(peek);
  const warnings = scopeWarnings(value, peek);

  // A slice the file cannot carry is shown unchecked and disabled rather than
  // hidden: a checkbox that disappears when a path is corrected reads as the
  // form losing the user's choice. The stored value is left alone — nothing is
  // written until save, and a profile-bundle path may yet be re-pointed at an
  // environment file in the same session.
  const effective = (slice: keyof OriginScope) =>
    available[slice] && value[slice];

  const set = (slice: keyof OriginScope) => (next: boolean) =>
    onChange({ ...value, [slice]: next });

  const count = (n: number | undefined, key: string) =>
    peek && n !== undefined ? t(key, { count: n }) : null;

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs font-semibold">{t("origins.scope.title")}</span>
        {loading && (
          <span className="text-3xs text-muted-foreground">
            {t("origins.scope.reading")}
          </span>
        )}
      </div>
      <p className="text-3xs text-muted-foreground">
        {t("origins.scope.description")}
      </p>

      <SliceRow
        checked={effective("connections")}
        disabled={!available.connections}
        onChange={set("connections")}
        icon={Database}
        label={t("origins.scope.connections")}
        hint={t("origins.scope.connectionsHint")}
        count={count(peek?.connections, "origins.scope.connectionsCount")}
      />
      <SliceRow
        checked={effective("environments")}
        disabled={!available.environments}
        onChange={set("environments")}
        icon={Layers}
        label={t("origins.scope.environments")}
        hint={t("origins.scope.environmentsHint")}
        count={count(peek?.environments, "origins.scope.environmentsCount")}
      />
      <SliceRow
        checked={effective("schemas")}
        disabled={!available.schemas}
        onChange={set("schemas")}
        icon={FileJson}
        label={t("origins.scope.schemas")}
        hint={t("origins.scope.schemasHint")}
        count={count(peek?.schemas, "origins.scope.schemasCount")}
      />

      {peek && !available.environments && (
        <p className="text-3xs text-muted-foreground">
          {t("origins.scope.profilesOnlyFile")}
        </p>
      )}
      {/* A path that cannot be read yet is a hint, not a failure: the share may
          simply be behind a VPN at the moment the user is configuring it, which
          `add_origin` deliberately allows. */}
      {error && !loading && path.trim() && (
        <p className="text-3xs text-muted-foreground">
          {t("origins.scope.unreadable")}
        </p>
      )}
      {warnings.map((key) => (
        <p key={key} className="text-3xs text-warning">
          {t(key)}
        </p>
      ))}
    </div>
  );
}
