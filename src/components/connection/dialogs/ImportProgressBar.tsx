/**
 * Determinate progress bar shown while an import is decrypting/merging
 * connection profiles — shared by `ImportProfilesDialog` and
 * `ImportEnvironmentDialog`, both driven by the same
 * `huginndb://import-progress` event emitted from `apply_profile_imports`
 * (`src-tauri/src/commands/connection.rs`).
 *
 * That loop runs one 600 000-iteration PBKDF2 derivation per encrypted
 * secret, deliberately slow; a file bundling many profiles (an environment
 * export in particular) can take long enough that a bare spinner isn't
 * enough feedback — see CHANGELOG's "not responding" fix, which moved the
 * work off the main thread but didn't make it any faster.
 */

import { useTranslation } from "react-i18next";

interface Props {
  done: number;
  total: number;
}

export function ImportProgressBar({ done, total }: Props) {
  const { t } = useTranslation();
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t("transfer.import.progress", { done, total })}
      </p>
    </div>
  );
}
