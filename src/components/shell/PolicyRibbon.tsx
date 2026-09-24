/**
 * The window-wide notice that the managed policy is not in force: it is still
 * being read from its share, or it could not be applied. Either way no
 * connection reads or writes (the backend refuses; §5.4 of
 * `docs/POLICY_ROADMAP.md`), and without this bar that would look like every
 * connection had broken at once.
 *
 * Mounted beside `SandboxRibbon`, and like it renders nothing in the ordinary
 * case — an unmanaged machine, or an active policy — so it is safe to mount
 * unconditionally. Not dismissable: while it shows, nothing works, and the
 * link goes to where the reason is (Settings → Policy).
 */

import { useTranslation } from "react-i18next";
import { ShieldAlert, ShieldEllipsis } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { usePolicyState } from "@/lib/policy/access";
import { cn } from "@/lib/utils";

export function PolicyRibbon() {
  const { t } = useTranslation();
  const { state } = usePolicyState();
  const openSettings = useSettingsDialog((s) => s.openAt);

  if (state !== "pending" && state !== "broken") return null;
  const broken = state === "broken";
  const Icon = broken ? ShieldAlert : ShieldEllipsis;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex h-7 shrink-0 items-center justify-center gap-2 border-b px-3 text-2xs",
        broken
          ? "border-destructive/40 bg-destructive/15 text-destructive"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {t(broken ? "policy.ribbon.broken" : "policy.ribbon.pending")}
      </span>
      <Button
        variant="link"
        size="xs"
        className="h-auto shrink-0 p-0 text-2xs text-current hover:text-current"
        onClick={() => openSettings("policy")}
      >
        {t("policy.ribbon.details")}
      </Button>
    </div>
  );
}
