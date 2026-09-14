/**
 * `CREATE DATABASE` — reachable from the connection's context menu and from
 * the empty-tree state a server with no databases now shows.
 *
 * Two shapes behind one dialog, because the user's intent is one intent. For
 * the SQL drivers it is `NamePromptDialog` unchanged: a name, a button. For
 * MongoDB it grows a second required field, because an empty MongoDB database
 * does not exist — the server materialises the namespace when its first
 * collection is written — so "create a database" there means "create a
 * database and its first collection", the same pair Compass asks for. See
 * `create_database`'s doc comment for the backend half and
 * `requiresInitialCollection` for the gate.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NamePromptDialog } from "@/components/schema/dialogs/NamePromptDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requiresInitialCollection } from "@/lib/db/driver";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";

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
  const driver = useConnections(
    (s) => s.profiles.find((p) => p.id === connectionId)?.driver,
  );
  const needsCollection = requiresInitialCollection(driver);
  const [collection, setCollection] = useState("");
  const trimmedCollection = collection.trim();

  return (
    <NamePromptDialog
      title={t("schema.createDatabase.title")}
      description={t(
        needsCollection
          ? "schema.createDatabase.descriptionMongo"
          : "schema.createDatabase.description",
      )}
      placeholder={t("schema.createDatabase.namePlaceholder")}
      submitLabel={t("schema.createDatabase.submit")}
      submittingLabel={t("schema.createDatabase.creating")}
      formatError={(message) => t("schema.createDatabase.failed", { message })}
      // The name alone is not enough on MongoDB: submitting without a
      // collection would reach the backend only to be refused there.
      canSubmit={() => !needsCollection || trimmedCollection.length > 0}
      onClose={onClose}
      onSubmit={async (name) => {
        await api.createDatabase(
          connectionId,
          name,
          needsCollection ? trimmedCollection : undefined,
        );
        onDone(name);
      }}
    >
      {needsCollection && (
        <div className="space-y-1 pt-1">
          <Label htmlFor="create-db-collection" className="text-xs">
            {t("schema.createDatabase.collectionLabel")}
          </Label>
          <Input
            id="create-db-collection"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder={t("schema.createDatabase.collectionPlaceholder")}
          />
        </div>
      )}
    </NamePromptDialog>
  );
}
