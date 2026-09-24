/**
 * "Your credentials": the database user this person signs in as on a
 * connection they do not curate — managed policy phase 3.
 *
 * With a database user per person, the database itself enforces what the
 * policy says, and the shared password that could open another client never
 * has to reach this machine (the origin sync stops landing it). Three states:
 *
 * - **Pinned by the policy** (a rule's `dbUser`): the user is shown with a
 *   lock and cannot be changed; the password field of the dialog is what gets
 *   stored for it.
 * - **Chosen here**: the person's own user, with the way back to the shared
 *   one.
 * - **Neither**, on a connection from an origin: the offer to use one's own.
 *
 * Like `SecretOverrideNotice`, it reads the dialog's password field rather
 * than drawing another, and it is rendered in the banner for the same reason:
 * the password field is written out three times in `ConnectionDialog`.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { useConnections } from "@/stores/session/connections";
import type { ConnectionProfile, PersonalCredentials } from "@/types";

export function PersonalCredentialsNotice({
  profile,
  password,
  onChange,
  bare = false,
}: {
  /** The **stored** profile. */
  profile: ConnectionProfile;
  /** The dialog's password field as it stands. */
  password: string;
  /** Whether a personal user is in force, for the banner to hide the password
   *  override (which is about the published user's password). */
  onChange?: (personal: boolean) => void;
  /** Standing on its own rather than under the origin banner's text. */
  bare?: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useConnections((s) => s.refreshProfiles);
  const [creds, setCreds] = useState<PersonalCredentials | null>(null);
  const [user, setUser] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.personalCredentials(profile.id);
      setCreds(c);
      setUser(c.username ?? "");
      onChange?.(!!c.username);
    } catch {
      setCreds(null);
    }
  }, [profile.id, onChange]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!creds || profile.driver === "sqlite") return null;

  const pinned = creds.source === "policy";
  // A connection of one's own has its user edited by saving it; only a pin
  // from the policy is worth a word there.
  if (!profile.origin_id && !pinned) return null;

  async function save() {
    setBusy(true);
    try {
      await api.setPersonalCredentials({
        profileId: profile.id,
        username: pinned ? null : user.trim(),
        password: password || null,
      });
      await refresh();
      await load();
      notify.success(t("personalCredentials.saved"), {
        description: profile.name,
      });
    } catch (e) {
      notify.error(t("personalCredentials.saveFailed"), {
        description: String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await api.clearPersonalCredentials(profile.id);
      await refresh();
      await load();
      notify.success(t("personalCredentials.cleared"), {
        description: t("personalCredentials.clearedHint"),
      });
    } catch (e) {
      notify.error(t("personalCredentials.clearFailed"), {
        description: String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={
        bare ? "space-y-1.5" : "mt-1.5 space-y-1.5 border-t border-border pt-1.5"
      }
    >
      {pinned ? (
        <p className="flex items-center gap-1">
          <Lock aria-hidden className="h-3 w-3 shrink-0" />
          <span>
            {t("personalCredentials.pinned", { user: creds.username })}
          </span>
        </p>
      ) : creds.username ? (
        <p>
          {t("personalCredentials.own", {
            user: creds.username,
            shared: creds.publishedUsername,
          })}
        </p>
      ) : (
        <p>{t("personalCredentials.offer")}</p>
      )}
      <div className="flex items-center gap-2">
        {!pinned && (
          <Input
            size="xs"
            className="flex-1 font-mono text-2xs"
            aria-label={t("personalCredentials.user")}
            placeholder={creds.publishedUsername || t("personalCredentials.user")}
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        )}
        <span
          className={
            pinned ? "flex-1 text-muted-foreground" : "shrink-0 text-muted-foreground"
          }
        >
          {creds.hasPassword
            ? t("personalCredentials.passwordStored")
            : t("personalCredentials.passwordMissing")}
        </span>
        <Button
          size="xs"
          variant="ghost"
          loading={busy}
          disabled={pinned ? !password : !user.trim()}
          onClick={() => void save()}
        >
          {t("personalCredentials.save")}
        </Button>
        {(creds.username && !pinned) || (pinned && creds.hasPassword) ? (
          <Button
            size="xs"
            variant="ghost"
            loading={busy}
            onClick={() => void clear()}
          >
            {pinned
              ? t("personalCredentials.forgetPassword")
              : t("personalCredentials.useShared")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
