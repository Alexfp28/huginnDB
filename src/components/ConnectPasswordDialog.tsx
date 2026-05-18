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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ConnectionProfile } from "@/types";

interface Props {
  open: boolean;
  profile: ConnectionProfile | null;
  onCancel: () => void;
  onConnect: (password: string) => Promise<void>;
}

export function ConnectPasswordDialog({
  open,
  profile,
  onCancel,
  onConnect,
}: Props) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setConnecting(false);
      setError(null);
    }
  }, [open]);

  async function handleSubmit() {
    if (!password || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      await onConnect(password);
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("connectPassword.title")}</DialogTitle>
          <DialogDescription>
            {t("connectPassword.description", { name: profile?.name ?? "" })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1">
          <Label>{t("connectPassword.password")}</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoFocus
          />
        </div>

        {error && <div className="text-xs text-destructive">{error}</div>}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={connecting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!password || connecting}>
            {connecting
              ? t("connectPassword.connecting")
              : t("connectPassword.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
