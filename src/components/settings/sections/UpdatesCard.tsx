/**
 * Updates panel rendered inside `AboutSection`.
 *
 * Self-contained: subscribes to whatever the global update store reports
 * and owns the manual "Check now" / "Install and relaunch" interactions.
 * Kept out of AboutSection.tsx so each file stays focused — one file for
 * app metadata, one file for the update lifecycle.
 *
 * The card has four mutually exclusive visual states, derived from the
 * store's `status` field:
 *
 *   • "available"   — shows release notes + install button + progress.
 *   • "downloading" — same as available, but the install button is
 *                     disabled and the progress bar animates.
 *   • "error"       — error line in place of the up-to-date message.
 *   • everything else (idle / checking / ready) — "you're on the latest"
 *                     reassurance line. We intentionally keep this
 *                     visible while `ready` because the relaunch happens
 *                     immediately after, so the user sees this only for
 *                     a frame.
 */

import { useTranslation } from "react-i18next";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateStore } from "@/stores/update";

interface Props {
  /** Resolved current version. Passed in so the parent owns the fallback path. */
  currentVersion: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdatesCard({ currentVersion }: Props) {
  const { t } = useTranslation();
  const status = useUpdateStore((s) => s.status);
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const releaseNotes = useUpdateStore((s) => s.releaseNotes);
  const downloadProgress = useUpdateStore((s) => s.downloadProgress);
  const error = useUpdateStore((s) => s.error);
  const checkManually = useUpdateStore((s) => s.checkManually);
  const installAndRelaunch = useUpdateStore((s) => s.installAndRelaunch);

  const isChecking = status === "checking";
  const isDownloading = status === "downloading";
  const isReadyToRestart = status === "readyToRestart";
  const hasUpdate =
    (status === "available" || isDownloading || isReadyToRestart) &&
    availableVersion !== null;
  const hasError = status === "error" && error !== null;
  // Only show the up-to-date reassurance when we're truly settled — not
  // mid-check, mid-download, or while bubbling an error.
  const showUpToDate = !hasUpdate && !hasError && !isChecking && !isDownloading;

  const progressPct =
    downloadProgress && downloadProgress.total
      ? Math.min(
          100,
          Math.round(
            (downloadProgress.downloaded / downloadProgress.total) * 100,
          ),
        )
      : null;

  return (
    <div className="rounded-md border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("update.sectionTitle")}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void checkManually();
          }}
          disabled={isChecking || isDownloading}
          className="h-7 gap-1.5 text-xs"
        >
          {isChecking ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {t("update.checkNow")}
        </Button>
      </div>

      {hasUpdate && (
        <div className="mt-3 space-y-2">
          <div className="text-[12px]">
            {t("update.availableLine", {
              current: currentVersion,
              next: availableVersion,
            })}
          </div>
          {releaseNotes && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                {t("update.releaseNotes")}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[10px]">
                {releaseNotes}
              </pre>
            </details>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                void installAndRelaunch();
              }}
              disabled={isDownloading}
              className="h-7 gap-1.5 text-xs"
            >
              {isDownloading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {isDownloading
                ? t("update.downloading")
                : isReadyToRestart
                  ? t("update.restartNow")
                  : t("update.installAndRelaunch")}
            </Button>
            <a
              href="https://github.com/Alexfp28/huginnDB/releases"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted-foreground hover:text-primary hover:underline"
            >
              {t("update.openReleases")}
            </a>
          </div>
          {isDownloading && downloadProgress && (
            <div className="mt-1 space-y-1">
              <div className="h-1 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${progressPct ?? 0}%` }}
                />
              </div>
              <div className="text-[10px] text-muted-foreground">
                {formatBytes(downloadProgress.downloaded)}
                {downloadProgress.total
                  ? ` / ${formatBytes(downloadProgress.total)}`
                  : ""}
              </div>
            </div>
          )}
        </div>
      )}

      {showUpToDate && (
        <div className="mt-2 text-[12px] text-muted-foreground">
          {t("update.upToDate", { version: currentVersion })}
        </div>
      )}

      {hasError && (
        <div className="mt-2 text-xs text-destructive">
          {t("update.errorPrefix")} {error}
        </div>
      )}
    </div>
  );
}
