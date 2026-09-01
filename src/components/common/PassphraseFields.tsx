/**
 * The passphrase pair shown when an export is asked to include secrets.
 *
 * `ExportProfilesDialog` and `ExportEnvironmentDialog` carried this
 * ~45-line block identically, including the security warning, both
 * `PasswordInput`s, the mismatch message, and — as separate literals — the
 * minimum length the export is gated on. That last one is the reason to share:
 * a minimum enforced in two places is a minimum that can disagree with itself.
 *
 * The backend enforces nothing here beyond requiring *a* passphrase
 * (`build_exported_profiles`), so this component is the only thing standing
 * between the user and a one-character key over 600k PBKDF2 iterations.
 */

import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/common/PasswordInput";

/** Shortest passphrase an export will accept. */
export const MIN_PASSPHRASE_LENGTH = 8;

/**
 * Whether `passphrase` may be used to encrypt an export.
 *
 * Exported so a dialog can gate its submit button on the same rule the fields
 * validate against, rather than restating it.
 */
export function passphraseAccepted(
  passphrase: string,
  confirm: string,
): boolean {
  return (
    passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase === confirm
  );
}

interface Props {
  passphrase: string;
  confirm: string;
  onPassphraseChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  /** Disambiguates the input ids when two of these could share a page. */
  idPrefix?: string;
}

export function PassphraseFields({
  passphrase,
  confirm,
  onPassphraseChange,
  onConfirmChange,
  idPrefix = "export",
}: Props) {
  const { t } = useTranslation();
  // Only complain once the user has started typing the confirmation — flagging
  // a mismatch against an empty second field is just noise while they type.
  const mismatch =
    passphrase.length > 0 && confirm.length > 0 && passphrase !== confirm;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-2xs text-warning">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("transfer.export.securityWarning")}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-passphrase`} className="text-xs">
          {t("transfer.export.passphrase")}
        </Label>
        <PasswordInput
          id={`${idPrefix}-passphrase`}
          value={passphrase}
          onChange={(e) => onPassphraseChange(e.target.value)}
          placeholder={t("transfer.export.passphrasePlaceholder")}
          className="h-8 text-xs"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-passphrase-confirm`} className="text-xs">
          {t("transfer.export.passphraseConfirm")}
        </Label>
        <PasswordInput
          id={`${idPrefix}-passphrase-confirm`}
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          placeholder={t("transfer.export.passphraseConfirmPlaceholder")}
          className="h-8 text-xs"
        />
        {mismatch && (
          <p className="text-[11px] text-destructive">
            {t("transfer.export.passphraseMismatch")}
          </p>
        )}
      </div>
    </div>
  );
}
