/**
 * Confirm deleting the selected rows of a table.
 *
 * It used to be a hand-rolled `<Dialog>` inside `TableDataTab` whose failure
 * went to the tab's generic error banner — the strip above the grid that fetch
 * errors use. The dialog stayed open on top of it, so the person who deleted a
 * row that other tables still reference saw a confirmation, clicked, and
 * nothing appeared to happen; the reason sat behind the scrim.
 *
 * Now the failure is said in the dialog, which stays open (CONTRIBUTING's rule
 * for a destructive action that has to explain why it failed). A refusal
 * because of a foreign key gets its own sentence and, best-effort, names the
 * tables that still point at this one — the server's own text names at most one
 * of them, and on some versions none.
 *
 * Mount it only while a delete is pending: `useAsyncSubmit` leaves `submitting`
 * set after a success on the assumption that the dialog goes away, so the hook
 * has to die with it or the next delete would open with a spinning button.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { isForeignKeyViolation } from "@/lib/db/driver";
import { api } from "@/lib/tauri";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import type { CellValue, IncomingForeignKey } from "@/types";

export function DeleteRowsDialog({
  connectionId,
  schema,
  table,
  pkColumns,
  pkValueRows,
  onDelete,
  onClose,
}: {
  connectionId: string;
  schema?: string;
  table: string;
  /** Primary-key column names, parallel to each tuple in `pkValueRows`. */
  pkColumns: string[];
  pkValueRows: CellValue[][];
  /** Performs the delete and whatever refresh follows; rejects on failure. */
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { submitting, error, run } = useAsyncSubmit();
  // `undefined` until a foreign-key refusal has been looked into; `[]` both for
  // "none found" and for a lookup that failed — neither has a list to show.
  const [references, setReferences] = useState<IncomingForeignKey[]>();

  const count = pkValueRows.length;
  const qualified = `${schema ? `${schema}.` : ""}${table}`;
  const blockedByForeignKey = error !== null && isForeignKeyViolation(error);

  function confirm() {
    setReferences(undefined);
    run(async () => {
      try {
        await onDelete();
      } catch (e) {
        if (isForeignKeyViolation(e)) {
          api
            .listReferencingForeignKeys(connectionId, schema, table)
            .then(setReferences)
            .catch(() => setReferences([]));
        }
        throw e;
      }
    });
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        count > 1
          ? t("tableData.deleteRowsTitle", { count })
          : t("tableData.deleteRowTitle")
      }
      description={
        count > 1 ? (
          <>
            {t("tableData.deleteRowsBodyLead", { count })}{" "}
            <span className="font-mono">{qualified}</span>
            {t("tableData.deleteBodyTrail")}
          </>
        ) : (
          <>
            {t("tableData.deleteRowBodyLead")}{" "}
            <span className="font-mono">{qualified}</span>{" "}
            {t("tableData.deleteBodyWhere")}{" "}
            <span className="font-mono">
              {pkColumns
                .map((name, i) => `${name} = ${String(pkValueRows[0]?.[i] ?? "")}`)
                .join(" AND ")}
            </span>
            {t("tableData.deleteBodyTrail")}
          </>
        )
      }
      confirmLabel={t("tableData.delete")}
      confirmingLabel={t("tableData.deleting")}
      confirming={submitting}
      error={
        error &&
        t(
          blockedByForeignKey
            ? "tableData.deleteBlockedByReference"
            : "tableData.deleteFailed",
          { message: error },
        )
      }
      onConfirm={confirm}
    >
      {blockedByForeignKey && references && references.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-2xs text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <p className="font-medium">
              {t("tableData.referencedBy", { count: references.length })}
            </p>
            <ul className="space-y-0.5 font-mono">
              {references.map((fk) => (
                <li
                  key={`${fk.schema ?? ""}.${fk.table}.${fk.constraint}`}
                  className="break-all"
                >
                  {fk.schema && fk.schema !== schema ? `${fk.schema}.` : ""}
                  {fk.table} ({fk.columns.join(", ")}) → {fk.constraint}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </ConfirmDialog>
  );
}
