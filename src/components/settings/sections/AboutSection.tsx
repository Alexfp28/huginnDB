/**
 * About panel — app version, tagline, repo link, the in-app update
 * controls, and the prefs-file paths on disk. The version is read at
 * mount time from the Tauri runtime (`getVersion`) so it always
 * matches the installed bundle, not a hardcoded string.
 *
 * The Updates card is its own component (`UpdatesCard`) — see
 * `./UpdatesCard.tsx`. This file stays focused on metadata.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "@/stores/update";
import { useAppFlavor } from "@/stores/appFlavor";
import { getCurrentVersion } from "@/lib/updater";
import { UpdatesCard } from "./UpdatesCard";
import { PatchNotesCard } from "./PatchNotesCard";

/** Build the per-OS prefs paths for a given state dir. The canary build lives
 *  under "HuginnDB-Canary", so hardcoding "HuginnDB" here would have shown the
 *  wrong (stable) location in the sandbox — another way the two looked alike. */
function prefsPaths(stateDir: string): { os: string; path: string }[] {
  return [
    { os: "Windows", path: `%APPDATA%\\${stateDir}\\prefs.json` },
    { os: "Linux", path: `$XDG_CONFIG_HOME/${stateDir}/prefs.json` },
    { os: "macOS", path: `~/Library/Application Support/${stateDir}/prefs.json` },
  ];
}

/**
 * Resolve the running app version. Prefers whatever the update store
 * already cached (populated by the on-launch check) and falls back to a
 * direct `getVersion()` call only if the About panel is opened before
 * the launch check has resolved.
 */
function useResolvedVersion(): string {
  const storeCurrent = useUpdateStore((s) => s.currentVersion);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (storeCurrent) return;
    let cancelled = false;
    void getCurrentVersion()
      .then((v) => {
        if (!cancelled) setFallback(v);
      })
      .catch(() => {
        // Ignored: the About page just shows "—" if the version cannot
        // be resolved (e.g. when running outside the Tauri shell).
      });
    return () => {
      cancelled = true;
    };
  }, [storeCurrent]);

  return storeCurrent ?? fallback ?? "—";
}

export function AboutSection() {
  const { t } = useTranslation();
  const currentVersion = useResolvedVersion();
  const productName = useAppFlavor((s) => s.productName);
  const stateDir = useAppFlavor((s) => s.stateDir);
  const prefsLocations = prefsPaths(stateDir);

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md border border-border bg-card/40 p-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {productName}
        </div>
        <div className="mt-1 font-mono text-base">{currentVersion}</div>
        <div className="mt-2 text-[12px] text-muted-foreground">
          {t("settings.about.tagline")}
        </div>
        <div className="mt-2 text-[12px]">
          <a
            href="https://github.com/Alexfp28/huginnDB"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            github.com/Alexfp28/huginnDB
          </a>
        </div>
      </div>

      <UpdatesCard currentVersion={currentVersion} />

      <PatchNotesCard currentVersion={currentVersion} />

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("settings.about.prefsLocation")}
        </div>
        <div className="divide-y divide-border/60 rounded-md border border-border">
          {prefsLocations.map((p) => (
            <div
              key={p.os}
              className="flex items-center justify-between gap-4 px-3 py-2"
            >
              <span className="text-xs">{p.os}</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {p.path}
              </code>
            </div>
          ))}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t("settings.about.tabStateHint", { file: "tab_state.json" })}
        </div>
      </div>
    </div>
  );
}
