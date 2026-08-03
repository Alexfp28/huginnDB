/**
 * Asked when a *second* `huginndb …` launch forwards a connection to the
 * already-running instance (single-instance consolidation). The user decides
 * whether the incoming connection lands in the window that's already open,
 * or in a brand new one — with an opt-out to stop asking and always apply
 * the same choice.
 *
 * The main window was already focused in Rust (`handle_second_instance`);
 * this dialog only routes the connection.
 */

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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  /** Display name of the incoming connection, for the prompt copy. */
  connectionName: string;
  dontAskAgain: boolean;
  onDontAskAgainChange: (value: boolean) => void;
  /** Open the connection in a freshly opened window. */
  onNewWindow: () => void;
  /** Open the connection in the current (already-focused) window. */
  onCurrentWindow: () => void;
  onCancel: () => void;
}

export function CliConnectChoiceDialog({
  open,
  connectionName,
  dontAskAgain,
  onDontAskAgainChange,
  onNewWindow,
  onCurrentWindow,
  onCancel,
}: Props) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("cliConnect.title")}</DialogTitle>
          <DialogDescription>
            {t("cliConnect.description", { name: connectionName })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
          <Label
            htmlFor="cli-connect-dont-ask"
            className="text-xs font-normal text-muted-foreground"
          >
            {t("cliConnect.dontAskAgain")}
          </Label>
          <Switch
            id="cli-connect-dont-ask"
            checked={dontAskAgain}
            onCheckedChange={onDontAskAgainChange}
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("cliConnect.cancel")}
          </Button>
          <Button variant="outline" onClick={onCurrentWindow}>
            {t("cliConnect.currentWindow")}
          </Button>
          <Button onClick={onNewWindow}>{t("cliConnect.newWindow")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
