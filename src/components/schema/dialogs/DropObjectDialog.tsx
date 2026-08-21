/**
 * Confirm dropping a table/collection or a view.
 *
 * One component for both: `dropTable` vs `dropView` and two i18n prefixes. Both
 * always confirm — unlike `EmptyTableDialog`, there is no "don't ask again"
 * preference, because dropping a definition is not something to skip confirming.
 */

import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/lib/tauri";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import type { TableInfo } from "@/types";

export function DropObjectDialog({
  connectionId,
  target,
  kind,
  onClose,
  onDone,
}: {
  connectionId: string;
  target: TableInfo;
  kind: "table" | "view";
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { submitting, error, run } = useAsyncSubmit();
  const prefix = kind === "table" ? "schema.drop" : "schema.dropView";

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(`${prefix}.title`, { name: target.name })}
      description={t(`${prefix}.description`)}
      confirmLabel={t("schema.drop.submit")}
      confirmingLabel={t("schema.drop.dropping")}
      confirmAutoFocus
      confirming={submitting}
      error={error && t(`${prefix}.failed`, { message: error })}
      onConfirm={() =>
        run(async () => {
          if (kind === "table") {
            await api.dropTable(connectionId, target.schema, target.name);
          } else {
            await api.dropView(connectionId, target.schema, target.name);
          }
          onDone();
        })
      }
    />
  );
}
