/**
 * Create a MongoDB collection (#61) — the collection analogue of
 * `CreateDatabaseDialog`. Reached from the Mongo database context menu and the
 * single-DB Mongo toolbar.
 *
 * `connectionId` must already be scoped to the target database (a
 * `<parent>::db::<db>` view for a cluster), so the caller resolves it before
 * opening this.
 */

import { useTranslation } from "react-i18next";

import { NamePromptDialog } from "@/components/schema/dialogs/NamePromptDialog";
import { api } from "@/lib/tauri";

export function CreateCollectionDialog({
  connectionId,
  onClose,
  onDone,
}: {
  connectionId: string;
  onClose: () => void;
  /** Fired with the created collection's name so the caller can refresh the
   *  tree and/or toast success. */
  onDone: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <NamePromptDialog
      title={t("schema.createCollection.title")}
      description={t("schema.createCollection.description")}
      placeholder={t("schema.createCollection.namePlaceholder")}
      submitLabel={t("schema.createCollection.submit")}
      submittingLabel={t("schema.createCollection.creating")}
      formatError={(message) => t("schema.createCollection.failed", { message })}
      onClose={onClose}
      onSubmit={async (name) => {
        await api.createCollection(connectionId, name);
        onDone(name);
      }}
    />
  );
}
