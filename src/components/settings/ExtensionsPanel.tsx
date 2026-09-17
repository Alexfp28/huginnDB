/**
 * Colour themes from an Open VSX registry, docked beside the workspace.
 *
 * **A panel and not a dialog, which was the second attempt.** The first was a
 * dialog opened from Settings → Appearance, and it was wrong twice over:
 * picking variants after a download needs a dialog of its own, so installing
 * anything meant a dialog stacked on a dialog on a settings modal; and the
 * only way in was a small icon button in the theme list's header, which is
 * exactly the kind of affordance nobody finds. As a dock occupant it sits
 * beside the app the way VS Code's own does, the variant picker becomes the
 * only modal in the flow, and the entry point is a labelled button in the
 * activity bar.
 *
 * Three things here are decisions rather than layout:
 *
 * **The result count is approximate, and says so.** The registry's `Themes`
 * category covers icon themes, and its search response cannot say which hits
 * are colour themes — only each extension's manifest can, which the backend
 * fetches per candidate and filters on. A page of 24 hits routinely yields a
 * dozen rows, so an exact-looking figure would never match the list under it.
 *
 * **Installing reuses the variant picker rather than guessing.** An extension
 * contributes several themes and nothing says which light and dark variants
 * are counterparts, so a download hands off to `ImportVsCodeThemeDialog` — the
 * same dialog a local `.vsix` goes through. One path, one set of rules.
 *
 * **An update never silently rewrites a palette the user has edited.** The
 * backend tracks that per theme (`paletteEdited`, see gotcha #88); this panel
 * turns it into two visibly different outcomes rather than one button that
 * quietly behaves differently.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, RefreshCw, Search, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useThemeStore } from "@/stores/preferences/theme";
import { usePreferences } from "@/stores/preferences/preferences";
import type { ThemeImportResult, VsixPayload } from "@/lib/vscodeTheme";
import type {
  InstalledThemeSource,
  RegistryTheme,
  ThemeUpdate,
} from "@/lib/vscodeTheme/types";
import { ImportVsCodeThemeDialog } from "./dialogs/ImportVsCodeThemeDialog";

const PAGE_SIZE = 24;

interface Props {
  /** False while the dock is showing another occupant. The panel stays
   *  mounted (its search results and scroll position are worth keeping) but
   *  does not fetch — same contract as the Pulse panel. */
  active: boolean;
}

export function ExtensionsPanel({ active }: Props) {
  const { t } = useTranslation();
  const addImportedTheme = useThemeStore((s) => s.addImportedTheme);
  const applyThemeUpdate = useThemeStore((s) => s.applyThemeUpdate);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const activeThemeId = useThemeStore((s) => s.themeId);
  const installed = useThemeStore((s) => s.importedEditorThemes);
  const registryEnabled = usePreferences((s) => s.prefs.themes.registryEnabled);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<RegistryTheme[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [updates, setUpdates] = useState<ThemeUpdate[]>([]);

  /** The download awaiting a variant choice, plus where it came from. */
  const [pending, setPending] = useState<{
    payload: VsixPayload;
    theme: RegistryTheme;
    /** Present when this install is really an update of an existing family. */
    update?: ThemeUpdate;
  } | null>(null);

  // Guards against a slow search landing after a newer one. The registry is
  // occasionally slow, and out-of-order responses are how a list ends up
  // showing results for a query the user has already replaced.
  const requestSeq = useRef(0);
  const loadedOnce = useRef(false);

  const runSearch = useCallback(async (nextQuery: string, nextOffset: number) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.searchRegistryThemes(nextQuery, nextOffset, PAGE_SIZE);
      if (seq !== requestSeq.current) return;
      setItems(page.items);
      setTotal(page.total);
      setOffset(page.offset);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setItems([]);
      setError(String(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // First activation only: an empty query is a valid search here and returns
  // the most-downloaded themes, which is a better opening state than a blank
  // panel. Re-running it every time the dock switches back would spend
  // someone else's bandwidth to show what is already on screen.
  useEffect(() => {
    if (!active || !registryEnabled || loadedOnce.current) return;
    loadedOnce.current = true;
    void runSearch("", 0);
    void api
      .checkThemeUpdates()
      .then((report) => setUpdates(report.updates))
      .catch(() => setUpdates([]));
  }, [active, registryEnabled, runSearch]);

  async function beginInstall(theme: RegistryTheme, update?: ThemeUpdate) {
    setBusyId(`${theme.namespace}.${theme.name}`);
    try {
      setPending({ payload: await api.installRegistryTheme(theme), theme, update });
    } catch (e) {
      notify.error(String(e));
    } finally {
      setBusyId(null);
    }
  }

  function finishInstall(result: ThemeImportResult) {
    if (!pending) return;
    const source: InstalledThemeSource = {
      // Recorded per theme so that pointing the app at a different registry
      // later cannot silently re-target this theme's updates.
      registryUrl: new URL(pending.theme.downloadUrl).origin,
      namespace: pending.theme.namespace,
      name: pending.theme.name,
      version: pending.theme.version,
      lightPath: result.selection.lightPath,
      darkPath: result.selection.darkPath,
    };
    const update = pending.update;
    if (update) {
      applyThemeUpdate(
        { ...result, family: { ...result.family, id: update.familyId } },
        source,
        update.paletteEdited,
      );
      setUpdates((u) => u.filter((x) => x.familyId !== update.familyId));
      notify.success(
        t(
          update.paletteEdited
            ? "extensions.updatedEditorOnly"
            : "extensions.updated",
          { name: result.family.name },
        ),
      );
    } else {
      addImportedTheme(result, source);
      notify.success(t("settings.appearance.importSuccess", { name: result.family.name }));
    }
    setPending(null);
  }

  if (!registryEnabled) {
    return (
      <PanelFrame title={t("panels.extensions")}>
        <p className="p-3 text-xs text-muted-foreground">
          {t("extensions.disabled")}
        </p>
      </PanelFrame>
    );
  }

  return (
    <>
      <PanelFrame title={t("panels.extensions")}>
        <div className="flex h-full min-h-0 flex-col">
          <form
            className="flex gap-1.5 border-b border-border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query, 0);
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("extensions.searchPlaceholder")}
              className="h-7 flex-1 text-xs"
            />
            <Button type="submit" size="xs" disabled={loading}>
              <Search className="h-3 w-3" />
            </Button>
          </form>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {updates.length > 0 && (
              <div className="mb-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-2xs">
                <p className="mb-1 font-medium">
                  {t("extensions.updatesAvailable", { count: updates.length })}
                </p>
                <ul className="space-y-1">
                  {updates.map((u) => (
                    <li key={u.familyId} className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate">
                        {u.name} {u.installedVersion} → {u.availableVersion}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void beginInstall(u.theme, u)}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
                {updates.some((u) => u.paletteEdited) && (
                  <p className="mt-1 text-muted-foreground">
                    {t("extensions.paletteEditedNote")}
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-2xs text-destructive">
                {error}
              </p>
            )}

            {loading && items.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("extensions.loading")}
              </p>
            ) : items.length === 0 && !error ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("extensions.empty")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {items.map((theme) => {
                  const familyId = installedFamilyId(installed, theme);
                  return (
                    <ThemeRow
                      key={`${theme.namespace}.${theme.name}`}
                      theme={theme}
                      busy={busyId === `${theme.namespace}.${theme.name}`}
                      installedFamilyId={familyId}
                      isActive={familyId !== null && familyId === activeThemeId}
                      onInstall={() => void beginInstall(theme)}
                      onApply={() => familyId && setThemeId(familyId)}
                    />
                  );
                })}
              </ul>
            )}
          </div>

          {items.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-border p-2 text-2xs text-muted-foreground">
              {/* "about", never an exact figure — see the file header. */}
              <span className="min-w-0 truncate">
                {t("extensions.approxTotal", { count: total })}
              </span>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={offset === 0 || loading}
                  onClick={() => void runSearch(query, Math.max(0, offset - PAGE_SIZE))}
                >
                  {t("common.previous")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={offset + PAGE_SIZE >= total || loading}
                  onClick={() => void runSearch(query, offset + PAGE_SIZE)}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </PanelFrame>

      {/* The same picker a local `.vsix` goes through — an extension is
          several themes either way, and the pairing rules must not differ by
          where the file came from. Now the only modal in the flow. */}
      <ImportVsCodeThemeDialog
        payload={pending?.payload ?? null}
        onCancel={() => setPending(null)}
        onConfirm={finishInstall}
      />
    </>
  );
}

/**
 * Which installed family, if any, came from this extension.
 *
 * Matched on the family *name*, which is what the install recorded from the
 * extension's display name. The precise join key (`source.namespace/name`)
 * lives on disk rather than in the store, and pulling the whole library into
 * memory to light up one badge would be a second source of truth for what is
 * installed. A name collision shows an "installed" mark on the wrong row and
 * costs nothing else — the install path itself never consults this.
 */
function installedFamilyId(
  installed: Record<string, { label: string }>,
  theme: RegistryTheme,
): string | null {
  const hit = Object.entries(installed).find(
    ([, v]) => v.label.trim().toLowerCase() === theme.displayName.trim().toLowerCase(),
  );
  return hit ? hit[0] : null;
}

function PanelFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-3xs uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function ThemeRow({
  theme,
  busy,
  installedFamilyId,
  isActive,
  onInstall,
  onApply,
}: {
  theme: RegistryTheme;
  busy: boolean;
  installedFamilyId: string | null;
  isActive: boolean;
  onInstall: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="rounded-md border border-border p-2">
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {theme.displayName}
        </span>
        {isActive && <Check className="h-3 w-3 shrink-0 text-success" />}
      </div>
      <p className="text-3xs text-muted-foreground">
        {theme.namespace} · v{theme.version}
        {theme.license ? ` · ${theme.license}` : ""}
      </p>
      <p className="mt-1 line-clamp-2 text-2xs text-muted-foreground">{theme.description}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-3xs text-muted-foreground">
          {t("extensions.downloads", { count: theme.downloadCount })}
        </span>
        {theme.averageRating != null && (
          <span className="flex items-center gap-0.5 text-3xs text-muted-foreground">
            <Star className="h-2.5 w-2.5" />
            {theme.averageRating.toFixed(1)}
          </span>
        )}
        <span className="text-3xs text-muted-foreground">
          {t("extensions.variants", { count: theme.variants.length })}
        </span>
        <div className="ml-auto flex gap-1">
          {/* "Apply" only appears once a theme is installed and is not the
              active one — a button that does nothing visible is worse than
              no button. */}
          {installedFamilyId && !isActive && (
            <Button size="xs" variant="outline" onClick={onApply}>
              {t("extensions.apply")}
            </Button>
          )}
          <Button size="xs" variant={installedFamilyId ? "ghost" : "default"} disabled={busy} onClick={onInstall}>
            <Download className="mr-1 h-3 w-3" />
            {busy
              ? t("extensions.installing")
              : installedFamilyId
                ? t("extensions.reinstall")
                : t("extensions.install")}
          </Button>
        </div>
      </div>
    </li>
  );
}
