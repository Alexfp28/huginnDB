/**
 * The one rendered instance of the "delete this environment" confirm dialog
 * (see `stores/dialogs/environmentDeleteConfirm.ts`). Mounted once in
 * `App.tsx`, next to `EnvironmentEditorDialog` — both `EnvironmentRail`'s
 * context menu and `EnvironmentSwitcher`'s dropdown open it via the store
 * instead of each rendering their own.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useEnvironmentDeleteConfirm } from "@/stores/dialogs/environmentDeleteConfirm";
import { useEnvironments } from "@/stores/session/environments";

export function EnvironmentDeleteConfirmDialog() {
  const { t } = useTranslation();
  const pending = useEnvironmentDeleteConfirm((s) => s.pending);
  const close = useEnvironmentDeleteConfirm((s) => s.close);
  const remove = useEnvironments((s) => s.remove);
  const [removing, setRemoving] = useState(false);

  async function onConfirm() {
    if (!pending) return;
    setRemoving(true);
    try {
      await remove(pending.id);
      close();
    } catch (e) {
      // Leave the dialog open: the environment is still there, so the user
      // can retry rather than being left thinking it was deleted.
      notify.error(String(e));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <ConfirmDialog
      open={!!pending}
      onOpenChange={(open) => !open && close()}
      title={t("environments.delete")}
      // Discards this environment's tabs and layout. Connection profiles and
      // credentials are untouched, and the prompt says so — "environment"
      // alone could easily read as "delete these connections". Always shown
      // regardless of `ui.confirmDestructive`: tabs and pane layout exist
      // nowhere else and can't be rebuilt from the database.
      description={t("environments.deleteConfirm", { name: pending?.label ?? "" })}
      confirmLabel={t("environments.delete")}
      confirming={removing}
      onConfirm={() => void onConfirm()}
    />
  );
}
