/**
 * The last thing between a draft and everyone who pulls from the origin.
 *
 * A `ConfirmDialog` rather than a toast-and-hope, for the reason gotcha #44
 * gives: a failure has to say why *in* the dialog, which stays open, so the user
 * can fix it and try again without losing the draft. The impact report is
 * rendered inside it rather than only in the pane behind it — a preview the user
 * has to remember from another screen is a preview they did not read.
 */

import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { ImpactReport } from "@/components/origins/ImpactReport";
import type { OriginPublishImpact } from "@/types";

export function PublishConfirmDialog({
  open,
  onOpenChange,
  impact,
  path,
  revision,
  saving,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  impact: OriginPublishImpact | null;
  path: string;
  /** The revision about to be written — `base.revision + 1`. */
  revision: number;
  saving: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const silent =
    !!impact &&
    (impact.connections.silentlyDropped || impact.environments.silentlyDropped);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("originEditor.confirm.title", { revision })}
      description={
        <div className="space-y-1">
          <p className="break-all font-mono text-[11px]">{path}</p>
          {silent && (
            <p className="text-destructive">
              {t("originEditor.confirm.silentWarning")}
            </p>
          )}
        </div>
      }
      confirmLabel={t("originEditor.confirm.publish")}
      confirming={saving}
      confirmingLabel={t("originEditor.confirm.publishing")}
      error={error}
      onConfirm={onConfirm}
    >
      {impact && (
        <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border p-3">
          <ImpactReport impact={impact} />
        </div>
      )}
    </ConfirmDialog>
  );
}
