/**
 * Confirm dropping a table/collection or a view.
 *
 * One component for both: `dropTable` vs `dropView` and two i18n prefixes. Both
 * always confirm — unlike `EmptyTableDialog`, there is no "don't ask again"
 * preference, because dropping a definition is not something to skip confirming.
 *
 * For a table, the dialog also names the foreign keys on *other* tables that
 * reference it, before the user confirms. The server refuses such a drop, and
 * its refusal was the only signal there used to be — one that on MySQL 5.7 and
 * MariaDB names no table at all. The lookup is best-effort on purpose: a
 * failure shows nothing and leaves the button alone, since the server has the
 * last word either way (FK checks can be off, Postgres has `CASCADE`).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { notify } from "@/lib/notify";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/lib/tauri";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import type { IncomingForeignKey, TableInfo } from "@/types";

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
  // `undefined` while the lookup runs; `[]` both for "none" and for a lookup
  // that failed — neither has anything to warn about.
  const [references, setReferences] = useState<
    IncomingForeignKey[] | undefined
  >(kind === "table" ? undefined : []);

  useEffect(() => {
    if (kind !== "table") return;
    let cancelled = false;
    api
      .listReferencingForeignKeys(connectionId, target.schema, target.name)
      .then((fks) => !cancelled && setReferences(fks))
      .catch(() => !cancelled && setReferences([]));
    return () => {
      cancelled = true;
    };
  }, [kind, connectionId, target.schema, target.name]);

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
          // The tree does lose the row, but a `DROP` is irreversible and runs
          // on a server that may take its time — and the tree may be filtered,
          // scrolled elsewhere, or not even the panel in front of the user.
          notify.success(t(`${prefix}.done`, { name: target.name }));
          onDone();
        })
      }
    >
      {references === undefined ? (
        <p className="text-2xs text-muted-foreground">
          {t("schema.drop.checkingReferences")}
        </p>
      ) : references.length > 0 ? (
        <ReferencesNotice references={references} ownSchema={target.schema} />
      ) : null}
    </ConfirmDialog>
  );
}

function ReferencesNotice({
  references,
  ownSchema,
}: {
  references: IncomingForeignKey[];
  ownSchema: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-2xs text-warning">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {t("schema.drop.referencedBy", { count: references.length })}
        </p>
        <ul className="space-y-0.5 font-mono">
          {references.map((fk) => (
            <li
              key={`${fk.schema ?? ""}.${fk.table}.${fk.constraint}`}
              className="break-all"
            >
              {/* The schema only when it differs: a cross-schema child is
                  the one the user would otherwise look for in the wrong
                  place, and repeating the current one on every line is noise. */}
              {fk.schema && fk.schema !== ownSchema ? `${fk.schema}.` : ""}
              {fk.table} ({fk.columns.join(", ")}) → {fk.constraint}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          {t("schema.drop.referencedByHint")}
        </p>
      </div>
    </div>
  );
}
