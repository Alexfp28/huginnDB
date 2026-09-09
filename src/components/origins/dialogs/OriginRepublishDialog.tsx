/**
 * "You corrected this connection on your own machine. Send it to everybody
 * else?"
 *
 * The hole this fills: a publisher who fixed a rotated password in the
 * connection dialog had fixed it *for themselves*. `save_profile` writes
 * `profiles.json` and this machine's keychain and stops there — the share still
 * carried the old envelope, and every consumer kept failing to connect until
 * somebody remembered to reopen the origin editor, find the row, flip its
 * secret to `fromKeychain` and publish. Two expressions of one intent, with a
 * silent window of broken connections in between.
 *
 * Deliberately a prompt and not an automatic write. Publishing reaches other
 * people's machines, `save_profile` does not, and a local correction is a
 * perfectly reasonable thing to make without sharing it (a per-machine host
 * override, a half-finished edit). The default is offered, never assumed.
 *
 * Mounted once in `App.tsx` and driven by `stores/dialogs/originRepublish` —
 * see that store for why the prompt must outlive the dialog that raises it.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { PasswordInput } from "@/components/common/PasswordInput";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useOriginEditor } from "@/stores/dialogs/originEditor";
import { useOriginRepublish } from "@/stores/dialogs/originRepublish";
import { useOrigins } from "@/stores/sync/origins";
import { useOriginSync } from "@/stores/sync/originSync";

export function OriginRepublishDialog() {
  const { t } = useTranslation();
  const pending = useOriginRepublish((s) => s.pending);
  const close = useOriginRepublish((s) => s.close);
  const openEditor = useOriginEditor((s) => s.open);
  const loadOrigins = useOrigins((s) => s.load);
  const syncAll = useOriginSync((s) => s.syncAll);

  const [passphrase, setPassphrase] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A second correction must not inherit the first one's typed passphrase or
  // its failure message.
  useEffect(() => {
    setPassphrase("");
    setError(null);
  }, [pending?.profileId, pending?.originId]);

  async function onConfirm() {
    if (!pending) return;
    setPublishing(true);
    setError(null);
    try {
      const outcome = await api.republishProfileToOrigin({
        originId: pending.originId,
        profileId: pending.profileId,
        withSecret: pending.withSecret,
        // Blank means "use the passphrase stored for this origin", which is
        // the case for every origin the publisher set up with one.
        passphrase: passphrase || null,
      });
      if (outcome.status === "conflict") {
        // Somebody else published while this correction was being made. There
        // is nothing sensible to do from a one-row prompt — the newer document
        // may have changed this very connection — so hand the whole thing to
        // the editor, which is built to show what moved underneath.
        close();
        openEditor(pending.originId);
        notify.warning(t("originRepublish.conflict"), {
          description: t("originRepublish.conflictHint"),
        });
        return;
      }
      // Publishing changes nothing on this machine by itself (`origin_doc`'s
      // first invariant), so the same post-publish refresh the editor does:
      // the registry's cached `maintainer`/revision, then a sweep so this
      // machine sees its own file the way a consumer will.
      await loadOrigins();
      await syncAll();
      notify.success(t("originRepublish.published"), {
        description: pending.profileName,
      });
      close();
    } catch (e) {
      // Left open with the reason on it: the likeliest failure is a missing
      // passphrase, and the field to fix that is right here.
      setError(String(e));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <ConfirmDialog
      open={!!pending}
      onOpenChange={(open) => !open && close()}
      title={t("originRepublish.title")}
      description={t(
        pending?.withSecret
          ? "originRepublish.descriptionWithSecret"
          : "originRepublish.description",
        { connection: pending?.profileName ?? "", origin: pending?.originName ?? "" },
      )}
      confirmLabel={t("originRepublish.confirm")}
      cancelLabel={t("originRepublish.keepLocal")}
      confirming={publishing}
      confirmingLabel={t("originRepublish.publishing")}
      error={error}
      onConfirm={() => void onConfirm()}
    >
      {/* Only when something will actually be encrypted. A republish that
        carries every envelope verbatim needs no passphrase at all, and asking
        for one there would suggest it did. */}
      {pending?.withSecret && (
        <label className="grid gap-1">
          <span className="text-xs text-muted-foreground">
            {t("originRepublish.passphrase")}
          </span>
          <PasswordInput
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder={t("originRepublish.passphrasePlaceholder")}
          />
        </label>
      )}
    </ConfirmDialog>
  );
}
