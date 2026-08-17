/**
 * "Save as view" / "Update view" for the aggregation editor.
 *
 * A MongoDB view is nothing but the pipeline plus a name and a source, so this
 * dialog has exactly those fields — and the source is fixed, because a view
 * that reads from a different collection than the pipeline you just previewed
 * is a different view. Creating and redefining share one form: the only
 * difference is which command runs (`create` vs `collMod`), which the caller
 * decides from whether the name already belongs to this tab's view.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The collection the pipeline reads from — shown, never edited here. */
  source: string;
  /** The view this tab is already bound to, if any. */
  boundView?: string;
  saving: boolean;
  onSubmit: (name: string) => void;
}

export function SaveViewDialog({
  open,
  onOpenChange,
  source,
  boundView,
  saving,
  onSubmit,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName(boundView ?? "");
  }, [open, boundView]);

  const trimmed = name.trim();
  const isUpdate = !!boundView && trimmed === boundView;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isUpdate
              ? t("aggregation.saveView.titleUpdate")
              : t("aggregation.saveView.titleCreate")}
          </DialogTitle>
          <DialogDescription>
            {t("aggregation.saveView.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>{t("aggregation.saveView.name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("aggregation.saveView.namePlaceholder")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && trimmed && !saving) onSubmit(trimmed);
              }}
            />
          </div>
          <div className="grid gap-1">
            <Label>{t("aggregation.saveView.source")}</Label>
            <Input value={source} readOnly disabled className="font-mono text-xs" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => onSubmit(trimmed)} disabled={!trimmed || saving}>
            {saving
              ? t("aggregation.saveView.saving")
              : isUpdate
                ? t("aggregation.saveView.submitUpdate")
                : t("aggregation.saveView.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
