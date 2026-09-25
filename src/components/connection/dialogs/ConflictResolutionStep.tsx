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

import { Segmented } from "@/components/ui/segmented";
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
                <span className="text-3xs text-muted-foreground">
                  {t("transfer.import.existingAs", { name: c.existing_name })}
                </span>
              )}
            </div>
            {/* A single choice per conflict, so a radiogroup rather than
                three independent buttons. Every conflict is seeded with the
                wizard's default action, so one segment is always checked and
                the group is always reachable by Tab. */}
            <Segmented
              size="sm"
              value={resolutions[c.id]}
              onValueChange={(action) => onResolve(c.id, action)}
              options={ACTIONS.map((action) => ({
                value: action,
                label: t(`transfer.import.action.${action}`),
              }))}
              aria-label={c.incoming_name}
            />
          </div>
        ))}
      </div>
      {error && <p className="text-2xs text-destructive">{error}</p>}
    </>
  );
}
