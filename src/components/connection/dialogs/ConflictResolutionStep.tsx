/**
 * The "resolve conflicts" step of an import wizard.
 *
 * Byte-identical in `ImportProfilesDialog` and `ImportEnvironmentDialog` — the
 * bulk-action row, the scrolling list, the three-way per-item toggle and the
 * inline error, about 45 lines each. `ConflictBulkActions` and
 * `ProgressBar` were already extracted from the same pair; this is the
 * rest of it.
 */

import { useTranslation } from "react-i18next";

import { ConflictBulkActions } from "./ConflictBulkActions";
import type { ConflictAction, ImportConflict } from "@/types";

const ACTIONS: ConflictAction[] = ["rename", "overwrite", "skip"];

interface Props {
  conflicts: ImportConflict[];
  resolutions: Record<string, ConflictAction>;
  onResolve: (id: string, action: ConflictAction) => void;
  onResolveAll: (action: ConflictAction) => void;
  error?: string | null;
}

export function ConflictResolutionStep({
  conflicts,
  resolutions,
  onResolve,
  onResolveAll,
  error,
}: Props) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t("transfer.import.conflictsDescription", { count: conflicts.length })}
      </p>
      <ConflictBulkActions onSelect={onResolveAll} />
      <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
        {conflicts.map((c) => (
          <div key={c.id} className="space-y-1.5 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="truncate text-xs font-medium">
                {c.incoming_name}
              </span>
              {c.incoming_name !== c.existing_name && (
                <span className="text-[10px] text-muted-foreground">
                  {t("transfer.import.existingAs", { name: c.existing_name })}
                </span>
              )}
            </div>
            <div className="flex gap-1.5">
              {ACTIONS.map((action) => (
                <button
                  key={action}
                  onClick={() => onResolve(c.id, action)}
                  className={
                    "rounded px-2 py-0.5 text-[10px] font-medium uppercase transition-colors " +
                    (resolutions[c.id] === action
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/80")
                  }
                >
                  {t(`transfer.import.action.${action}`)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </>
  );
}
