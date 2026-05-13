/**
 * Create / edit a connection profile.
 *
 * The dialog re-shapes itself based on the selected driver: SQLite hides
 * the network fields and asks only for a database file path. Passwords
 * are submitted to the backend separately from profile metadata so
 * `api.saveProfile(profile, password)` can route them to the OS
 * keychain.
 */

import { useEffect, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/tauri";
import { DEFAULT_PORTS } from "@/lib/constants";
import type { ConnectionProfile, Driver } from "@/types";
import { useConnections } from "@/stores/connections";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ConnectionProfile | null;
}

export function ConnectionDialog({ open, onOpenChange, initial }: Props) {
  const save = useConnections((s) => s.save);
  const [name, setName] = useState("");
  const [driver, setDriver] = useState<Driver>("postgres");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setDriver(initial.driver);
      setHost(initial.host);
      setPort(initial.port);
      setDatabase(initial.database);
      setUsername(initial.username);
      setSsl(initial.ssl);
      setPassword("");
    } else {
      setName("");
      setDriver("postgres");
      setHost("localhost");
      setPort(DEFAULT_PORTS.postgres);
      setDatabase("");
      setUsername("");
      setPassword("");
      setSsl(false);
    }
    setTestStatus(null);
  }, [open, initial]);

  function buildProfile(): ConnectionProfile {
    return {
      id: initial?.id ?? "",
      name,
      driver,
      host,
      port,
      database,
      username,
      ssl,
      ssh_tunnel: null,
    };
  }

  async function onTest() {
    setTestStatus("Testing...");
    try {
      await api.testConnection(buildProfile(), password || undefined);
      setTestStatus("Connection successful");
    } catch (e) {
      setTestStatus(`Failed: ${String(e)}`);
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      await save(buildProfile(), password || undefined);
      onOpenChange(false);
    } catch (e) {
      setTestStatus(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  function onDriverChange(d: Driver) {
    setDriver(d);
    if (port === DEFAULT_PORTS[driver] || port === 0) {
      setPort(DEFAULT_PORTS[d]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit connection" : "New connection"}</DialogTitle>
          <DialogDescription>
            Credentials are stored in the OS keychain, never written to disk in plaintext.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production DB" />
          </Field>
          <Field label="Driver">
            <Select value={driver} onValueChange={(v) => onDriverChange(v as Driver)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="postgres">PostgreSQL</SelectItem>
                <SelectItem value="mysql">MySQL</SelectItem>
                <SelectItem value="sqlite">SQLite</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {driver !== "sqlite" ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Field label="Host">
                    <Input value={host} onChange={(e) => setHost(e.target.value)} />
                  </Field>
                </div>
                <Field label="Port">
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Field label="Database">
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
              </Field>
              <Field label="Username">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={initial ? "(leave blank to keep current)" : ""}
                />
              </Field>
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <Label className="text-sm">SSL</Label>
                <Switch checked={ssl} onCheckedChange={setSsl} />
              </div>
            </>
          ) : (
            <Field label="Database file path">
              <Input
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="C:\\path\\to\\database.db"
              />
            </Field>
          )}
        </div>
        {testStatus && (
          <div
            className={`text-xs ${
              testStatus.startsWith("Connection successful")
                ? "text-emerald-400"
                : testStatus.startsWith("Testing")
                ? "text-muted-foreground"
                : "text-destructive"
            }`}
          >
            {testStatus}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onTest}>
            Test
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || !name}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
