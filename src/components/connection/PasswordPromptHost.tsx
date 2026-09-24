/**
 * The password prompt a connect shows when the keychain holds no password for
 * the user it signs in as — see `stores/dialogs/passwordRequest.ts` and
 * `lib/connection/passwordPrompt.ts`, which is what asks.
 *
 * It exists for managed policy phase 3: a person given their own database
 * user (a rule's `dbUser`, or their own choice on a shared connection) meets
 * an empty keychain on their first connect, every one of them. Before this
 * that was an error card telling them the keychain had no entry, which is
 * true and useless. It serves every connection with a missing password the
 * same way, not only those.
 *
 * Mounted once per window, like `ConfirmHost`.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DialogActions } from "@/components/ui/dialog-actions";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { usePasswordRequest } from "@/stores/dialogs/passwordRequest";

export function PasswordPromptHost() {
  const { t } = useTranslation();
  const current = usePasswordRequest((s) => s.current);
  const resolve = usePasswordRequest((s) => s.resolve);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);

  // A fresh prompt starts empty: the last one's password must never linger
  // into a prompt for a different connection.
  const askedFor = current?.profileId ?? null;
  useEffect(() => {
    setPassword("");
    setRemember(true);
  }, [askedFor]);

  const submit = () => {
    if (!password) return;
    resolve({ password, remember });
  };

  return (
    <Dialog open={!!current} onOpenChange={(open) => !open && resolve(null)}>
      {current && (
        <DialogContent tier="prompt">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {t("passwordPrompt.title", { name: current.name })}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription className="text-xs">
              {t("passwordPrompt.body", { user: current.username })}
            </DialogDescription>
            <form
              className="mt-3 grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Input
                type="password"
                autoFocus
                autoComplete="current-password"
                aria-label={t("passwordPrompt.password")}
                placeholder={t("passwordPrompt.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Checkbox
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                label={
                  <span className="text-xs">{t("passwordPrompt.remember")}</span>
                }
              />
            </form>
          </DialogBody>
          <DialogActions
            onCancel={() => resolve(null)}
            cancelLabel={t("common.cancel")}
            confirmLabel={t("passwordPrompt.connect")}
            onConfirm={submit}
            confirmDisabled={!password}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
