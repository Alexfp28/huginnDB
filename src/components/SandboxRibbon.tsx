/**
 * Persistent, unmissable banner shown ONLY in the canary sandbox build.
 *
 * The canary installs side-by-side with the stable app under a different name
 * and bundle id, but once you are inside the window the two are visually
 * identical — same UI, same shared keychain, and (until this) the same window
 * title. That makes it dangerously easy to think you are in your real stable
 * install when you are actually in the sandbox (or vice-versa). This ribbon
 * removes the ambiguity: a full-width amber bar pinned above the header,
 * non-dismissable, stating the flavor and the isolated state dir.
 *
 * Renders nothing in the stable build (`canary === false`), so it is safe to
 * mount unconditionally from `App.tsx`.
 */

import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import { useAppFlavor } from "@/stores/appFlavor";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function SandboxRibbon() {
  const { t } = useTranslation();
  // Primitive selectors keep Object.is stable (gotcha #1).
  const canary = useAppFlavor((s) => s.canary);
  const productName = useAppFlavor((s) => s.productName);
  const stateDir = useAppFlavor((s) => s.stateDir);

  if (!canary) return null;

  return (
    <SimpleTooltip label={t("sandbox.tooltip", { dir: stateDir })} side="bottom">
      <div
        role="status"
        aria-live="polite"
        className="flex h-6 shrink-0 items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-400 px-3 text-[11px] font-semibold uppercase tracking-wider text-amber-950 dark:bg-amber-500 dark:text-black"
      >
        <FlaskConical className="h-3.5 w-3.5" />
        <span className="truncate">{t("sandbox.ribbon", { product: productName })}</span>
        <span className="hidden opacity-70 sm:inline">·</span>
        <span className="hidden font-mono normal-case tracking-normal opacity-70 sm:inline">
          {t("sandbox.ribbonDetail", { dir: stateDir })}
        </span>
      </div>
    </SimpleTooltip>
  );
}
