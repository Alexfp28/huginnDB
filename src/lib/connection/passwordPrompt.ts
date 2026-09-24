/**
 * Ask for a password a connect found missing, and put it where the next
 * connect will find it — see `components/connection/PasswordPromptHost.tsx`
 * for why the prompt exists.
 *
 * Where "remember" stores it depends on whose password it is:
 * - the person's own database user (the policy's `dbUser`, or their own
 *   choice on a shared connection), or a connection of their own →
 *   `remember_password`, under the account that user keys;
 * - a shared connection signing in as the published user → the password
 *   override (`set_secret_override`), since a plain keychain write there would
 *   be overwritten by the next sync.
 *
 * Stored only after the connect it was typed for has succeeded: a mistyped
 * password is not worth remembering.
 */

import { api } from "@/lib/tauri";
import { usePasswordRequest } from "@/stores/dialogs/passwordRequest";
import type { ConnectionProfile } from "@/types";

export interface AskedPassword {
  password: string;
  remember: boolean;
  /** Whether the connection signs in with a personal user. */
  personal: boolean;
}

export async function askForPassword(
  profile: ConnectionProfile,
): Promise<AskedPassword | null> {
  const creds = await api.personalCredentials(profile.id).catch(() => null);
  const answer = await usePasswordRequest.getState().request({
    profileId: profile.id,
    name: profile.name,
    username: creds?.username ?? profile.username,
  });
  if (!answer) return null;
  return { ...answer, personal: !!creds?.username };
}

export async function rememberAskedPassword(
  profile: ConnectionProfile,
  asked: AskedPassword,
): Promise<void> {
  if (!asked.remember) return;
  if (profile.origin_id && !asked.personal) {
    await api.setSecretOverride({
      profileId: profile.id,
      password: asked.password,
    });
    return;
  }
  await api.rememberPassword(profile.id, asked.password);
}
