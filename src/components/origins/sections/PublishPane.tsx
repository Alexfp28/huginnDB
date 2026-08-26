/**
 * Publication metadata, the passphrase, and the live impact report.
 *
 * `maintainer` and the revision note are **coordination, never permission**:
 * any writer can set them, and nothing in the sync path reads either. What
 * actually stops two publishers clobbering each other is the content hash the
 * save compares — which is why the header, not this pane, is where "someone else
 * published" shows up.
 *
 * Rotating the passphrase gets its own explicit switch rather than being
 * inferred from "the passphrase field has something in it". It is the one
 * operation that deliberately re-encrypts every envelope in the document, which
 * invalidates the whole team's `landedSecrets` cache — the impact report next to
 * it prices that in PBKDF2 rounds precisely so the switch is never flipped by
 * accident.
 */

import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  PassphraseFields,
  passphraseAccepted,
} from "@/components/common/PassphraseFields";
import { ImpactReport } from "@/components/origins/ImpactReport";
import type { OriginDraft, OriginPublishImpact } from "@/types";

export interface PassphraseState {
  /** New passphrase, used to encrypt anything resolved from the keychain. */
  value: string;
  confirm: string;
  /** When set, every kept envelope is decrypted with this and re-encrypted with
   *  `value`. Empty means no rotation. */
  rotateFrom: string;
  rotating: boolean;
}

/** Whether the passphrase fields are in a state a save can use. Exported so the
 *  header's Save button gates on the same rule this pane validates against. */
export function passphraseReady(
  state: PassphraseState,
  needed: boolean,
): boolean {
  if (!needed && !state.rotating) return true;
  if (!passphraseAccepted(state.value, state.confirm)) return false;
  return !state.rotating || state.rotateFrom.length > 0;
}

export function PublishPane({
  draft,
  impact,
  passphrase,
  /** Whether the document has a slot that must be encrypted at save time. */
  passphraseNeeded,
  hasStoredPassphrase,
  readOnly,
  onChange,
  onPassphraseChange,
}: {
  draft: OriginDraft;
  impact: OriginPublishImpact | null;
  passphrase: PassphraseState;
  passphraseNeeded: boolean;
  hasStoredPassphrase: boolean;
  readOnly: boolean;
  onChange: (next: OriginDraft) => void;
  onPassphraseChange: (next: PassphraseState) => void;
}) {
  const { t } = useTranslation();

  function patchMeta(changes: Partial<OriginDraft["meta"]>) {
    if (readOnly) return;
    onChange({ ...draft, meta: { ...draft.meta, ...changes } });
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {t("originEditor.publish.maintainer")}
          </span>
          <Input
            className="mt-1 h-8 text-xs"
            disabled={readOnly}
            placeholder={t("originEditor.publish.maintainerPlaceholder")}
            value={draft.meta.maintainer ?? ""}
            onChange={(e) => patchMeta({ maintainer: e.target.value || null })}
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-muted-foreground">
            {t("originEditor.publish.note")}
          </span>
          <Input
            className="mt-1 h-8 text-xs"
            disabled={readOnly}
            placeholder={t("originEditor.publish.notePlaceholder")}
            value={draft.meta.note ?? ""}
            onChange={(e) => patchMeta({ note: e.target.value || null })}
          />
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t("originEditor.publish.metadataHint")}
      </p>

      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold">
            {t("originEditor.publish.passphrase")}
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded accent-primary"
              disabled={readOnly}
              checked={passphrase.rotating}
              onChange={(e) =>
                onPassphraseChange({
                  ...passphrase,
                  rotating: e.target.checked,
                  rotateFrom: e.target.checked ? passphrase.rotateFrom : "",
                })
              }
            />
            {t("originEditor.publish.rotate")}
          </label>
        </div>

        {!passphraseNeeded && !passphrase.rotating ? (
          <p className="text-[11px] text-muted-foreground">
            {hasStoredPassphrase
              ? t("originEditor.publish.passphraseStored")
              : t("originEditor.publish.passphraseNotNeeded")}
          </p>
        ) : (
          <div className="space-y-3">
            {passphrase.rotating && (
              <div className="space-y-1.5">
                <Label htmlFor="origin-rotate-from" className="text-xs">
                  {t("originEditor.publish.rotateFrom")}
                </Label>
                <PasswordInput
                  id="origin-rotate-from"
                  className="h-8 text-xs"
                  disabled={readOnly}
                  value={passphrase.rotateFrom}
                  onChange={(e) =>
                    onPassphraseChange({
                      ...passphrase,
                      rotateFrom: e.target.value,
                    })
                  }
                />
                <p className="text-[10px] text-muted-foreground">
                  {t("originEditor.publish.rotateHint")}
                </p>
              </div>
            )}
            <PassphraseFields
              idPrefix="origin-doc"
              passphrase={passphrase.value}
              confirm={passphrase.confirm}
              onPassphraseChange={(v) =>
                onPassphraseChange({ ...passphrase, value: v })
              }
              onConfirmChange={(v) =>
                onPassphraseChange({ ...passphrase, confirm: v })
              }
            />
          </div>
        )}
      </div>

      {impact && <ImpactReport impact={impact} />}
    </div>
  );
}
