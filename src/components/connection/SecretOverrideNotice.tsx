/**
 * The consumer's half of a shared origin's credentials: keep your own password
 * for a connection somebody else curates, and give it back when they catch up.
 *
 * Why this exists at all. A shared origin's value is that one person maintains
 * the credentials; its failure mode is that a server resets a password at 9am
 * and everyone else is locked out until that person republishes. The only thing
 * a consumer could do about it was retype the password into the connection
 * dialog on **every single connect** — `connect` takes one ad-hoc and persists
 * nothing, and `save_profile` is refused for an origin-owned profile because
 * the next sync would undo it. So the password was the one field where "the
 * file is authoritative" cost more than it bought, and this is the exception,
 * scoped to exactly that field.
 *
 * Rendered inside the read-only banner rather than beside the password input,
 * for a boring reason that decides it: the password field is written out three
 * times in `ConnectionDialog` (MongoDB, the SQL drivers, SQLite's absence of
 * one), and the banner is written once.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useConnections } from "@/stores/session/connections";
import type { ConnectionProfile } from "@/types";

export function SecretOverrideNotice({
  profile,
  password,
  sshSecret,
}: {
  /** The **stored** profile, not the draft: the override is a fact about what
   *  is on disk, and a draft cannot be trusted to still carry it. */
  profile: ConnectionProfile;
  /** The password field as it stands, which is what would be kept. */
  password: string;
  sshSecret: string;
}) {
  const { t } = useTranslation();
  const refresh = useConnections((s) => s.refreshProfiles);
  const [busy, setBusy] = useState(false);

  const override = profile.secret_override ?? null;
  const typed = !!password || !!sshSecret;

  async function keep() {
    setBusy(true);
    try {
      await api.setSecretOverride({
        profileId: profile.id,
        password: password || null,
        sshSecret: sshSecret || null,
      });
      await refresh();
      notify.success(t("secretOverride.kept"), { description: profile.name });
    } catch (e) {
      notify.error(t("secretOverride.keepFailed"), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setBusy(true);
    try {
      await api.clearSecretOverride(profile.id);
      await refresh();
      // The published secret is not back in the keychain yet — the sync that
      // re-lands it is the four-hourly one, or the next "Sync now". Saying
      // "released" and leaving it at that would read as "you are on the shared
      // password again", which is not true until then.
      notify.success(t("secretOverride.released"), {
        description: t("secretOverride.releasedHint"),
      });
    } catch (e) {
      notify.error(t("secretOverride.releaseFailed"), { description: String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (override) {
    return (
      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border pt-1.5">
        <span>
          {t("secretOverride.active", {
            since: new Date(override.setAt).toLocaleDateString(),
          })}
        </span>
        <Button
          size="xs"
          variant="ghost"
          loading={busy}
          onClick={() => void release()}
        >
          {t("secretOverride.release")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border pt-1.5">
      {/* Shown whether or not anything is typed: the point is to tell a locked
        out user that there is a way out at all, which they cannot discover from
        a disabled button they never look for. */}
      <span>{t("secretOverride.offer")}</span>
      <Button
        size="xs"
        variant="ghost"
        disabled={!typed}
        loading={busy}
        onClick={() => void keep()}
      >
        {t("secretOverride.keep")}
      </Button>
    </div>
  );
}
