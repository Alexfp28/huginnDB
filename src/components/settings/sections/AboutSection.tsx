/**
 * Static "About" panel — version, repo link, where preferences live on
 * disk. Reveal-in-explorer is intentionally not wired here yet (would
 * need a small Tauri command); the path is shown so the user can find
 * the file manually.
 */

import { useTranslation } from "react-i18next";

const APP_VERSION = "0.1.0-alpha";

const PREFS_PATHS: { os: string; path: string }[] = [
  { os: "Windows", path: "%APPDATA%\\HuginnDB\\prefs.json" },
  { os: "Linux", path: "$XDG_CONFIG_HOME/HuginnDB/prefs.json" },
  { os: "macOS", path: "~/Library/Application Support/HuginnDB/prefs.json" },
];

export function AboutSection() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md border border-border bg-card/40 p-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          HuginnDB
        </div>
        <div className="mt-1 font-mono text-base">{APP_VERSION}</div>
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

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("settings.about.prefsLocation")}
        </div>
        <div className="divide-y divide-border/60 rounded-md border border-border">
          {PREFS_PATHS.map((p) => (
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
