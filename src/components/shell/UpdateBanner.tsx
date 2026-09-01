/**
 * Floating top-centred banner that announces a pending app update. Replaces
 * the corner Sonner toast we used to fire from `App.tsx` — that toast was
 * narrow, easy to miss, and stylistically inconsistent with the rest of
 * the app chrome.
 *
 * The component is intentionally self-contained: it pulls the available
 * version, install action and dismiss action from `useUpdateStore` itself
 * so callers only need to mount it once, gated on
 * `selectUpdateNotificationVisible`.
 */

import { useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdateStore } from "@/stores/update";
import { Button } from "@/components/ui/button";

interface Props {
  version: string;
}

export function UpdateBanner({ version }: Props) {
  const { t } = useTranslation();
  const status = useUpdateStore((s) => s.status);
  // Local "mounted" state drives the slide-in transition. We let the
  // browser commit the off-screen state on the first frame and then
  // toggle to `true`, which the Tailwind transition picks up.
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const install = () => {
    void useUpdateStore.getState().installAndRelaunch();
  };
  const dismiss = () => {
    useUpdateStore.getState().dismiss();
  };

  // Once the background download has finished, installing is instant (no
  // wait, no progress) — the copy and button reflect that instead of
  // implying there's still something to download.
  const readyToRestart = status === "readyToRestart";
  // Covers the gap between the click and the actual install() call (see
  // the "installing" status doc in stores/update.ts) — disables both
  // buttons so a slow click can't fire the install twice.
  const isInstalling = status === "installing" || status === "ready";
  const title =
    readyToRestart || isInstalling
      ? t("update.readyTitle", { version })
      : t("update.toastTitle", { version });
  const description =
    readyToRestart || isInstalling
      ? t("update.readyDescription")
      : t("update.toastDescription");
  const installLabel = isInstalling
    ? t("update.restarting")
    : readyToRestart
      ? t("update.restartNow")
      : t("update.install");

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4"
    >
      <div
        className={`pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-3 shadow-elevation-4 backdrop-blur transition-all duration-300 ease-out ${
          shown ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
        }`}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">
            {title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {description}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={dismiss}
            disabled={isInstalling}
          >
            {t("update.later")}
          </Button>
          <Button size="sm" onClick={install} disabled={isInstalling}>
            {isInstalling && <Loader2 className="h-3 w-3 animate-spin" />}
            {installLabel}
          </Button>
          <button
            aria-label={t("common.close")}
            onClick={dismiss}
            disabled={isInstalling}
            className="text-muted-foreground/60 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
