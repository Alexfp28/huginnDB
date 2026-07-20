/**
 * MCP connector settings.
 *
 * Surfaces the bundled `huginndb-mcp` sidecar's on-disk path and generates
 * a ready-to-paste client config, so wiring up an AI tool doesn't require
 * hunting through the install directory or the source tree (see
 * `docs/MCP.md` and gotcha #20 in `CLAUDE.md`). This panel only reads
 * (profile list, sidecar path) — actually starting the server is the AI
 * client's job, never this app's.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/tauri";
import { useDocsDialog } from "@/stores/docsDialog";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type {
  ConnectionProfile,
  McpConnectorInfo,
  McpWritePolicy,
} from "@/types";

const WRITE_LEVELS: McpWritePolicy[] = ["read-only", "data", "full"];

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1 px-2 text-[11px]"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        toast.success(t("settings.mcp.copied"));
      }}
    >
      <Copy className="h-3 w-3" />
      {t("common.copy")}
    </Button>
  );
}

export function McpSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpConnectorInfo | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  useEffect(() => {
    void api
      .getMcpConnectorInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    void api
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Persist a connection's MCP write policy. Saves with no password so the
   * keychain entry is untouched (see `api.saveProfile`); the sidecar re-reads
   * this from `profiles.json` on its next write attempt, so no client restart
   * is needed. On failure we resync from disk rather than leave optimistic
   * state that never actually landed.
   */
  async function setWritePolicy(id: string, level: McpWritePolicy) {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    const updated = { ...profile, mcp_write: level };
    setProfiles((prev) => prev.map((p) => (p.id === id ? updated : p)));
    try {
      await api.saveProfile(updated);
    } catch {
      toast.error(t("settings.mcp.writePolicySaveError"));
      void api.listProfiles().then(setProfiles).catch(() => {});
    }
  }

  const allFilteredSelected =
    filteredProfiles.length > 0 &&
    filteredProfiles.every((p) => selected.has(p.id));

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const p of filteredProfiles) next.delete(p.id);
      } else {
        for (const p of filteredProfiles) next.add(p.id);
      }
      return next;
    });
  }

  const path = info?.binary_path ?? "";
  const ids = [...selected].join(",");
  const cliCommand = ids
    ? `claude mcp add huginndb -s user -- ${path} --connections ${ids}`
    : "";
  const jsonSnippet = ids
    ? JSON.stringify(
        {
          mcpServers: {
            huginndb: { command: path, args: ["--connections", ids] },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[12px] text-muted-foreground">
        {t("settings.mcp.intro")}
      </p>

      <div className="rounded-md border border-border bg-card/40 p-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("settings.mcp.binaryLabel")}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {path || "—"}
          </code>
          {path && <CopyButton text={path} />}
        </div>
        <div className="mt-2 text-[11px]">
          {info?.available ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              {t("settings.mcp.available")}
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              {t("settings.mcp.unavailable")}
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.mcp.connectionsLabel")}
          </span>
          {profiles.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {t("settings.mcp.selectedCount", {
                selected: selected.size,
                total: profiles.length,
              })}
            </span>
          )}
        </div>

        {profiles.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t("settings.mcp.noConnections")}
          </p>
        ) : (
          <>
            <div className="mb-1.5 flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  inputSize="xs"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("settings.mcp.filterPlaceholder")}
                  className="pl-6 pr-6"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter("")}
                    aria-label={t("common.clear")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                disabled={filteredProfiles.length === 0}
                onClick={toggleAllFiltered}
              >
                {allFilteredSelected
                  ? t("settings.mcp.deselectAll")
                  : t("settings.mcp.selectAll")}
              </Button>
            </div>

            <div className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
              {filteredProfiles.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-muted-foreground">
                  {t("settings.mcp.noMatches", { query: filter })}
                </p>
              ) : (
                filteredProfiles.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-brand"
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                      <span className="truncate text-xs">{p.name}</span>
                    </label>
                    <select
                      value={p.mcp_write ?? "read-only"}
                      onChange={(e) =>
                        void setWritePolicy(
                          p.id,
                          e.target.value as McpWritePolicy,
                        )
                      }
                      aria-label={t("settings.mcp.writePolicyLabel")}
                      title={t("settings.mcp.writePolicyLabel")}
                      className="h-6 shrink-0 rounded border border-border bg-background px-1.5 text-[11px]"
                    >
                      {WRITE_LEVELS.map((lvl) => (
                        <option key={lvl} value={lvl}>
                          {t(`settings.mcp.level.${lvl}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.mcp.writePolicyHint")}
            </p>
          </>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.mcp.claudeCodeLabel")}
          </span>
          {cliCommand && <CopyButton text={cliCommand} />}
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-[11px]">
          {cliCommand || t("settings.mcp.selectHint")}
        </pre>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.mcp.jsonLabel")}
          </span>
          {jsonSnippet && <CopyButton text={jsonSnippet} />}
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-[11px]">
          {jsonSnippet || t("settings.mcp.selectHint")}
        </pre>
      </div>

      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-[12px]"
        onClick={() => {
          useSettingsDialog.getState().setOpen(false);
          useDocsDialog.getState().openTo("mcp");
        }}
      >
        {t("settings.mcp.fullGuide")}
      </Button>
    </div>
  );
}
