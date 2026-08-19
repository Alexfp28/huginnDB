/**
 * The "this environment is no longer published by its origin" notice (#108
 * continuous environment sync), and the two actions that resolve it.
 *
 * Environment-level twin of `VanishedOriginNotice` — same reasoning
 * throughout: a background sync must never open a modal (nobody is
 * guaranteed to be watching), so this sits as a banner and waits; neither
 * action is implicit, since another user editing the shared file must never
 * be able to destroy a local environment on its own.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Trash2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useEnvironments, environmentLabel } from "@/stores/session/environments";
import { useOriginSync } from "@/stores/sync/originSync";
import { confirmIrreversible } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";

/** Full notice with both actions. Renders nothing when there is no notice. */
export function VanishedEnvironmentNotice({
  environmentId,
  className,
}: {
  environmentId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const notice = useOriginSync((s) => s.vanishedEnvironments[environmentId]);
  const adoptEnvironment = useOriginSync((s) => s.adoptEnvironment);
  const retireEnvironment = useOriginSync((s) => s.retireEnvironment);
  const env = useEnvironments((s) =>
    s.environments.find((e) => e.id === environmentId),
  );
  const defaultName = t("environments.defaultName");
  const [busy, setBusy] = useState(false);

  if (!notice) return null;
  const name = env ? environmentLabel(env, defaultName) : environmentId;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      // Leave the notice standing: the decision was not recorded, so the user
      // can retry. Failing silently would look like the click did nothing.
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "m-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Unlink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">
            {t("origins.vanishedEnvironments.titleNamed", { name })}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {t("origins.vanishedEnvironments.body", { origin: notice.originName })}
          </p>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          disabled={busy}
          title={t("origins.vanishedEnvironments.keepTooltip")}
          className="flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
          onClick={() => void run(() => adoptEnvironment(environmentId))}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t("origins.vanishedEnvironments.keep")}
        </button>
        <button
          type="button"
          disabled={busy}
          className="flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
          onClick={() => {
            if (
              !confirmIrreversible(
                t("origins.vanishedEnvironments.retireConfirm", { name }),
              )
            ) {
              return;
            }
            void run(() => retireEnvironment(environmentId));
          }}
        >
          <Trash2 className="h-3 w-3" />
          {t("origins.vanishedEnvironments.retire")}
        </button>
      </div>
    </div>
  );
}
