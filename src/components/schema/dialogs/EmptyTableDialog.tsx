/**
 * Confirmation for emptying a table (#69).
 *
 * Unlike the always-on DROP confirmation this carries a "don't ask again"
 * checkbox that flips the dedicated `ui.confirmEmptyTable` preference off, so a
 * power user who empties log tables often can silence just this prompt.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/lib/tauri";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import { usePreferences } from "@/stores/preferences/preferences";
import type { TableInfo } from "@/types";

export function EmptyTableDialog({
  connectionId,
  target,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const updateUi = usePreferences((s) => s.updateUi);
  const { submitting, error, run } = useAsyncSubmit();
  const [dontAsk, setDontAsk] = useState(false);

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("schema.empty.title", { name: target.name })}
      description={t("schema.empty.description")}
      confirmLabel={t("schema.empty.submit")}
      confirmingLabel={t("schema.empty.emptying")}
      confirmAutoFocus
      confirming={submitting}
      error={error && t("schema.empty.failed", { message: error })}
      onConfirm={() =>
        run(async () => {
          await api.emptyTable(connectionId, target.schema, target.name);
          if (dontAsk) updateUi({ confirmEmptyTable: false });
          notify.success(t("schema.empty.emptied", { name: target.name }));
          onDone();
        })
      }
    >
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="accent-brand"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        {t("schema.empty.dontAskAgain")}
      </label>
    </ConfirmDialog>
  );
}
