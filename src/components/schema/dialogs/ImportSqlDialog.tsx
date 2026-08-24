/**
 * Confirmation dialog for running a picked `.sql` file's statements against
 * a connection — the same `splitSql` + `executeBatch` runner the query
 * editor uses, no separate execution path (see `dump.rs`'s module docs).
 *
 * For a multi-DB connection the file's own destination is ambiguous: it may
 * already address a specific database itself (`USE db;` / qualified names),
 * or it may be generic and need the user to pick a target. The dialog offers
 * both — "run as-is" against the connection's own (database-less) pool, or a
 * specific database, resolved lazily via its synthetic child id.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/tauri";
import { openTrackedDatabaseView } from "@/stores/session/persistedTabs";

/** `"single"` — a single-DB profile (or a specific database's own menu):
 *  the target connection id is already known. `"multi"` — the connection's
 *  own menu on a multi-DB connection: the user picks a target database, or
 *  runs the batch against the parent connection as-is. */
export type ImportScope =
  | { kind: "single"; connectionId: string }
  | { kind: "multi"; parentId: string; databases: string[] };

/** Sentinel for "run against the connection as-is" — distinct from any real
 *  database name, which a `Select` value never accidentally collides with. */
const AS_IS = "__as_is__";

export function ImportSqlDialog({
  scope,
  statements,
  onClose,
  onImported,
}: {
  scope: ImportScope;
  statements: string[];
  onClose: () => void;
  /** Called with the connection id the batch actually ran against, so the
   *  caller can refresh that connection's schema tree. */
  onImported: (connectionId: string) => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<string>(
    scope.kind === "single" ? scope.connectionId : AS_IS,
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const connectionId =
        scope.kind === "single"
          ? scope.connectionId
          : target === AS_IS
            ? scope.parentId
            : await openTrackedDatabaseView(scope.parentId, target);
      const result = await api.executeBatch(connectionId, statements);
      const failed = result.statements.find((s) => s.error);
      if (failed) {
        notify.error(
          t("schema.importSql.failed", {
            index: failed.index + 1,
            message: failed.error,
          }),
        );
      } else {
        notify.success(
          t("schema.importSql.success", { count: result.statements.length }),
        );
      }
      onImported(connectionId);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("schema.importSql.title")}</DialogTitle>
          <DialogDescription>
            {t("schema.importSql.confirm", { count: statements.length })}
          </DialogDescription>
        </DialogHeader>

        {scope.kind === "multi" && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("schema.importSqlDialog.targetDatabase")}
            </label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AS_IS} className="text-xs">
                  {t("schema.importSqlDialog.targetAsIs")}
                </SelectItem>
                {scope.databases.map((name) => (
                  <SelectItem key={name} value={name} className="text-xs">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={running}
            onClick={() => void run()}
          >
            {running ? t("schema.importSqlDialog.running") : t("schema.importSql.title")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
