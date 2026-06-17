/**
 * Asked when a *second* `huginndb …` launch forwards a connection to the
 * already-running window (single-instance consolidation). Rather than
 * spawning a separate window like a second IDE, we keep everything in one
 * window and let the user decide where the incoming connection lands: a brand
 * new workspace (e.g. keep "MySQL config" and "Mongo data" side by side) or
 * the workspace they are already in.
 *
 * The window itself was already focused in Rust (`handle_second_instance`);
 * this dialog only routes the connection.
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
  /** Display name of the incoming connection (for the prompt copy and the
   *  default new-workspace name). */
  connectionName: string;
  /** Open the connection in a freshly created workspace named `name`. */
  onNewWorkspace: (name: string) => void;
  /** Open the connection in the currently active workspace. */
  onActiveWorkspace: () => void;
  onCancel: () => void;
}

export function CliConnectChoiceDialog({
  open,
  connectionName,
  onNewWorkspace,
  onActiveWorkspace,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(connectionName);

  // Reset the editable name whenever a new intent arrives (the dialog is
  // reused across launches; a stale name from the previous one would be
  // confusing).
  useEffect(() => {
    if (open) setName(connectionName);
  }, [open, connectionName]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("cliConnect.title")}</DialogTitle>
          <DialogDescription>
            {t("cliConnect.description", { name: connectionName })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cli-connect-ws-name">
            {t("cliConnect.nameLabel")}
          </Label>
          <Input
            id="cli-connect-ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("cliConnect.cancel")}
          </Button>
          <Button variant="outline" onClick={onActiveWorkspace}>
            {t("cliConnect.activeWorkspace")}
          </Button>
          <Button
            onClick={() => onNewWorkspace(name.trim() || connectionName)}
          >
            {t("cliConnect.newWorkspace")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
