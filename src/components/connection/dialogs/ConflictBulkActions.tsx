/**
 * "Mark all as: …" row shown above a conflict list — lets the user set every
 * conflicting profile's resolution in one click instead of clicking through
 * each row individually, which is the tedious part of importing a bundle
 * with dozens of conflicts (e.g. re-importing many environments at once).
 * Shared by `ImportProfilesDialog` and `ImportEnvironmentDialog`, both of
 * which otherwise duplicate the same per-row action buttons.
 */

import { useTranslation } from "react-i18next";
import type { ConflictAction } from "@/types";

const ACTIONS: ConflictAction[] = ["rename", "overwrite", "skip"];

interface Props {
  onSelect: (action: ConflictAction) => void;
}

export function ConflictBulkActions({ onSelect }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase font-medium text-muted-foreground">
        {t("transfer.import.markAllAs")}
      </span>
      <div className="flex gap-1.5">
        {ACTIONS.map((action) => (
          <button
            key={action}
            onClick={() => onSelect(action)}
            className="rounded px-2 py-0.5 text-[10px] uppercase font-medium text-muted-foreground bg-muted hover:bg-muted/80 transition-colors"
          >
            {t(`transfer.import.action.${action}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
