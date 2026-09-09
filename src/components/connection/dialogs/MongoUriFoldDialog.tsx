/**
 * "Turn this hand-written MongoDB URI back into the form, and lose what the
 * form cannot hold."
 *
 * The switch that leaves raw-edit mode used to be a silent no-op whenever the
 * URI was not representable, which made raw-edit a one-way door: a profile
 * saved from a pasted `mongodb+srv://` string could never be edited as a form
 * again, and nothing on screen said so. It now asks instead, and this is the
 * asking — one line per [`MongoUriLoss`] reason, so the user reads exactly what
 * they are giving up before they give it up.
 *
 * Driven by `useConnectionForm`'s `mongoFoldConflict`, not by a store: nothing
 * outside the open connection dialog can raise it.
 */

import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import type { MongoUriLoss } from "@/lib/db/mongoUri";

export function MongoUriFoldDialog({
  lost,
  onConfirm,
  onCancel,
}: {
  /** The reasons folding is lossy, or `null` when nothing is pending. */
  lost: MongoUriLoss[] | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      open={!!lost}
      onOpenChange={(open) => !open && onCancel()}
      title={t("connectionDialog.mongoFold.title")}
      description={t("connectionDialog.mongoFold.description")}
      confirmLabel={t("connectionDialog.mongoFold.confirm")}
      onConfirm={onConfirm}
    >
      {/* The reasons, not a rewording of them: each names the *thing* in the
        URI that will not survive, because "this URI is not representable" is
        true of all four and tells the user nothing about which one they typed. */}
      <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        {(lost ?? []).map((reason) => (
          <li key={reason}>{t(`connectionDialog.mongoFold.lost.${reason}`)}</li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
