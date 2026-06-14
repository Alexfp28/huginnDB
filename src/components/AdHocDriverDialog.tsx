/**
 * Driver picker shown when a CLI ad-hoc launch (`--host …`) arrives without
 * `--driver` and no default driver is configured in Preferences. Rather than
 * silently guessing a backend (the old behaviour, which mismatched MySQL
 * servers against the Postgres driver), we ask once and nudge the user to set
 * a default so future launches skip this.
 */

import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DriverBadge } from "@/components/DriverBadge";
import type { Driver } from "@/types";

const DRIVERS: { id: Driver; label: string }[] = [
  { id: "postgres", label: "PostgreSQL" },
  { id: "mysql", label: "MySQL" },
  { id: "sqlite", label: "SQLite" },
  { id: "mongodb", label: "MongoDB" },
];

interface Props {
  open: boolean;
  /** Name of the ad-hoc connection being created (for the prompt copy). */
  connectionName: string;
  onPick: (driver: Driver) => void;
  onCancel: () => void;
}

export function AdHocDriverDialog({
  open,
  connectionName,
  onPick,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("adhocDriver.title")}</DialogTitle>
          <DialogDescription>
            {t("adhocDriver.description", { name: connectionName })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {DRIVERS.map((d) => (
            <Button
              key={d.id}
              variant="outline"
              className="justify-start gap-2"
              onClick={() => onPick(d.id)}
            >
              <DriverBadge driver={d.id} />
              {d.label}
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("adhocDriver.note")}
        </p>
      </DialogContent>
    </Dialog>
  );
}
