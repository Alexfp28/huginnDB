/**
 * The one confirmation for deleting saved connections — a single profile from
 * the editor's Delete button, a checked batch from the rail, or every local
 * connection at once.
 *
 * It replaced two different confirmations that used to coexist: a native
 * `window.confirm` for the single delete and an in-app `ConfirmDialog` for the
 * bulk one. Neither said what a delete actually takes with it, which is the
 * point of this component: `delete_profile` also drops the OS-keychain entries,
 * the connection's tabs and "databases to show" filter **in every environment**,
 * and any JSON Schema bindings pinned to its columns. The list is built from
 * what applies to these targets — SQLite keeps no password, an untunnelled
 * profile keeps no SSH secret — because an enumeration that is right about the
 * actual rows reads as information, and a fixed one reads as boilerplate.
 *
 * ## Mount it conditionally
 *
 * There is no `open` prop, and that is deliberate. `useAsyncSubmit` leaves
 * `submitting` true after a success, because its contract assumes the success
 * path unmounts the dialog (gotcha #44). Here the *parent* — the connection
 * manager — stays open, so a hook living up there would be stuck for every
 * later delete. Rendering this only while there are targets makes the unmount
 * the reset.
 *
 * Profiles a shared origin publishes never reach here: the rail cannot check
 * them and "all local" excludes them by definition. That is not this
 * component's guard to enforce — deleting one is a no-op the next sync undoes,
 * so the refusal belongs at the boundary, in the backend.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useAsyncSubmit } from "@/lib/useAsyncSubmit";
import { useConnections } from "@/stores/session/connections";
import type { ConnectionProfile } from "@/types";

/** How many names to spell out before collapsing the rest into a count. */
const MAX_NAMES = 8;

export function DeleteConnectionsDialog({
  targets,
  onDeleted,
  onClose,
}: {
  /** Profiles to delete. Render this component only while non-empty. */
  targets: ConnectionProfile[];
  /** Called once every deletion has resolved, with the ids that were asked for. */
  onDeleted: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useConnections((s) => s.remove);
  const { submitting, error, run } = useAsyncSubmit();

  const names = useMemo(() => targets.map((p) => p.name), [targets]);
  const shown = names.slice(0, MAX_NAMES);
  const hidden = names.length - shown.length;

  // Only mention what these targets actually have. A SQLite profile has no
  // keychain entry at all (`delete_profile` skips it), and an untunnelled one
  // has no SSH secret.
  const sweeps = [
    targets.some((p) => p.driver !== "sqlite") && t("connections.deleteSweeps.password"),
    targets.some((p) => p.ssh_tunnel) && t("connections.deleteSweeps.sshSecret"),
    t("connections.deleteSweeps.tabs"),
    t("connections.deleteSweeps.visibility"),
    t("connections.deleteSweeps.jsonSchemas"),
  ].filter((x): x is string => !!x);

  function onConfirm() {
    const ids = targets.map((p) => p.id);
    run(async () => {
      for (const id of ids) {
        await remove(id);
      }
      onDeleted(ids);
    });
  }

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("connections.deleteTitle", { count: targets.length })}
      description={
        <span className="block">
          {shown.join(", ")}
          {hidden > 0 && ` — ${t("connections.deleteMoreNames", { count: hidden })}`}
        </span>
      }
      confirmLabel={t("connections.deleteAction", { count: targets.length })}
      confirming={submitting}
      confirmingLabel={t("connections.deleting")}
      error={error}
      onConfirm={onConfirm}
    >
      <div className="rounded-md bg-muted/50 px-3 py-2">
        <p className="text-[11px] text-muted-foreground">
          {t("connections.deleteSweeps.title")}
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
          {sweeps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-[11px] text-warning">
        {t("connections.deleteIrreversible")}
      </p>
    </ConfirmDialog>
  );
}
