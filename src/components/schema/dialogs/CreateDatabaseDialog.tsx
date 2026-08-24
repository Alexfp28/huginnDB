/**
 * `CREATE DATABASE` — the "+" in both the multi-DB explorer toolbar and the
 * single-DB root header. Postgres/MySQL only; see `create_database`'s doc
 * comment for why, and `supportsCreateDatabase` for the UI gate.
 */

import { useTranslation } from "react-i18next";

import { NamePromptDialog } from "@/components/schema/dialogs/NamePromptDialog";
import { api } from "@/lib/tauri";

export function CreateDatabaseDialog({
  connectionId,
  onClose,
  onDone,
}: {
  connectionId: string;
  onClose: () => void;
  /** Fired with the created database's name — a single-DB caller has no
   *  visible list to refresh, so it uses this to confirm success instead. */
  onDone: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <NamePromptDialog
      title={t("schema.createDatabase.title")}
      description={t("schema.createDatabase.description")}
      placeholder={t("schema.createDatabase.namePlaceholder")}
      submitLabel={t("schema.createDatabase.submit")}
      submittingLabel={t("schema.createDatabase.creating")}
      formatError={(message) => t("schema.createDatabase.failed", { message })}
      onClose={onClose}
      onSubmit={async (name) => {
        await api.createDatabase(connectionId, name);
        onDone(name);
      }}
    />
  );
}
