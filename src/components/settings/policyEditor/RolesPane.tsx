/**
 * Roles and their rules: the heart of the policy. Master/detail — the roles
 * on the left, the selected role's rules in the middle, the selected rule's
 * fields on the right — the same shape as the origin editor's environments
 * pane, so a role with twelve rules stays one screen.
 *
 * Names of databases and relations are suggested from the catalog of an open
 * connection to the rule's server, and can always be typed: a pattern
 * (`v_factura_*`) or a table that does not exist yet is a legitimate rule.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { TreeRow } from "@/components/ui/tree-row";
import { databaseViewId } from "@/lib/connectionLabel";
import {
  addRole,
  canRemoveRole,
  expandDbUser,
  newRule,
  removeRole,
  renameRole,
  roleNames,
  rulesOf,
  setRules,
  type EndpointJson,
  type PolicyJson,
  type RuleJson,
} from "@/lib/policy/draft";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/session/connections";
import type { ConnectionProfile } from "@/types";
import { EndpointField, Field, PatternListField, PermissionGrid } from "./fields";

function endpointLabel(e: EndpointJson, anyLabel: string): string {
  if (e === "*") return anyLabel;
  if (e.path !== undefined) return e.path || "…";
  return [e.driver, e.host || "…", e.port].filter(Boolean).join(" · ");
}

/** An open connection to the rule's server, if there is one — the source of
 *  the name suggestions. */
function connectionFor(
  endpoint: EndpointJson,
  profiles: ConnectionProfile[],
  active: Set<string>,
): ConnectionProfile | undefined {
  if (endpoint === "*") return undefined;
  const open = profiles.filter((p) => active.has(p.id));
  if (endpoint.path !== undefined) {
    const want = endpoint.path.trim().replace(/\\/g, "/").toLowerCase();
    return open.find(
      (p) => p.driver === "sqlite" && p.database.replace(/\\/g, "/").toLowerCase() === want,
    );
  }
  const host = (endpoint.host ?? "").trim().toLowerCase();
  return open.find(
    (p) =>
      p.driver !== "sqlite" &&
      p.host.trim().toLowerCase() === host &&
      (!endpoint.driver || endpoint.driver === p.driver),
  );
}

/** Database and relation names on the rule's server, best effort. */
function useCatalog(
  profile: ConnectionProfile | undefined,
  databases: string[] | undefined,
): { databases: string[]; relations: string[] } {
  const [dbs, setDbs] = useState<string[]>([]);
  const [rels, setRels] = useState<string[]>([]);
  const id = profile?.id;
  const sqlite = profile?.driver === "sqlite";
  useEffect(() => {
    setDbs([]);
    if (!id || sqlite) return;
    let live = true;
    api
      .listDatabases(id)
      .then((list) => live && setDbs(list.map((d) => d.name)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, sqlite]);
  // Relations of the databases the rule names (the first few), or of the
  // connection's own database when it names none.
  const targets = useMemo(() => {
    if (!id) return [] as string[];
    if (sqlite) return [id];
    const named = (databases ?? []).filter((d) => !d.includes("*")).slice(0, 4);
    return named.length > 0 ? named.map((d) => databaseViewId(id, d)) : [id];
  }, [id, sqlite, databases]);
  const key = targets.join("|");
  useEffect(() => {
    setRels([]);
    if (targets.length === 0) return;
    let live = true;
    Promise.all(targets.map((t) => api.listTables(t).catch(() => [])))
      .then((lists) => {
        if (!live) return;
        const names = new Set<string>();
        for (const list of lists) for (const t of list) names.add(t.name);
        setRels([...names].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // `key` stands for `targets`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { databases: dbs, relations: rels };
}

function RuleEditor({
  rule,
  profiles,
  exampleUser,
  readOnly,
  onChange,
}: {
  rule: RuleJson;
  profiles: ConnectionProfile[];
  exampleUser: string;
  readOnly: boolean;
  onChange: (next: RuleJson) => void;
}) {
  const { t } = useTranslation();
  const active = useConnections((s) => s.active);
  const profile = connectionFor(rule.endpoint, profiles, active);
  const catalog = useCatalog(profile, rule.databases);
  const patch = (p: Partial<RuleJson>) => {
    const next: RuleJson = { ...rule, ...p };
    for (const k of Object.keys(p) as (keyof RuleJson)[]) {
      if (p[k] === undefined) delete next[k];
    }
    onChange(next);
  };
  const relations = rule.relations ?? {};
  const setRelations = (r: { allow?: string[]; deny?: string[] }) => {
    const clean: { allow?: string[]; deny?: string[] } = {};
    if (r.allow !== undefined) clean.allow = r.allow;
    if (r.deny && r.deny.length > 0) clean.deny = r.deny;
    patch({ relations: Object.keys(clean).length > 0 ? clean : undefined });
  };

  return (
    <div className="grid gap-4">
      <EndpointField
        value={rule.endpoint}
        profiles={profiles}
        readOnly={readOnly}
        onChange={(endpoint) => patch({ endpoint })}
      />
      {rule.endpoint !== "*" && !profile && (
        <p className="text-3xs text-muted-foreground">
          {t("policyEditor.rule.noCatalog")}
        </p>
      )}
      <PatternListField
        id="policy-rule-databases"
        label={t("policyEditor.rule.databases")}
        allLabel={t("policyEditor.rule.allDatabases")}
        value={rule.databases}
        suggestions={catalog.databases}
        readOnly={readOnly}
        onChange={(databases) => patch({ databases })}
      />
      <PatternListField
        id="policy-rule-allow"
        label={t("policyEditor.rule.allow")}
        hint={t("policyEditor.rule.allowHint")}
        allLabel={t("policyEditor.rule.allRelations")}
        value={relations.allow}
        suggestions={catalog.relations}
        readOnly={readOnly}
        onChange={(allow) => setRelations({ ...relations, allow })}
      />
      <PatternListField
        id="policy-rule-deny"
        label={t("policyEditor.rule.deny")}
        hint={t("policyEditor.rule.denyHint")}
        value={relations.deny ?? []}
        suggestions={catalog.relations}
        readOnly={readOnly}
        onChange={(deny) => setRelations({ ...relations, deny: deny ?? [] })}
      />
      <PermissionGrid
        human={rule.human ?? []}
        ai={rule.ai ?? []}
        readOnly={readOnly}
        onChange={({ human, ai }) => patch({ human, ai })}
      />
      <Field
        label={t("policyEditor.rule.dbUser")}
        hint={
          rule.dbUser?.trim()
            ? t("policyEditor.rule.dbUserExample", {
                account: exampleUser,
                user: expandDbUser(rule.dbUser, exampleUser),
              })
            : t("policyEditor.rule.dbUserHint")
        }
      >
        <Input
          size="sm"
          className="font-mono"
          aria-label={t("policyEditor.rule.dbUser")}
          placeholder="{user}"
          readOnly={readOnly}
          value={rule.dbUser ?? ""}
          onChange={(e) => patch({ dbUser: e.target.value === "" ? undefined : e.target.value })}
        />
      </Field>
    </div>
  );
}

export function RolesPane({
  doc,
  exampleUser,
  readOnly,
  onChange,
}: {
  doc: PolicyJson;
  exampleUser: string;
  readOnly: boolean;
  onChange: (next: PolicyJson) => void;
}) {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const roles = roleNames(doc);
  const [role, setRole] = useState<string | null>(roles[0] ?? null);
  const [ruleIndex, setRuleIndex] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const selected = role && roles.includes(role) ? role : (roles[0] ?? null);
  const rules = selected ? rulesOf(doc, selected) : [];
  const rule = rules[Math.min(ruleIndex, rules.length - 1)];

  const commitRename = () => {
    if (renaming && newName.trim() && newName !== renaming) {
      onChange(renameRole(doc, renaming, newName.trim()));
      setRole(newName.trim());
    }
    setRenaming(null);
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[200px_220px_minmax(0,1fr)] gap-4 overflow-hidden">
      {/* Roles */}
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          {t("policyEditor.roles.title")}
        </span>
        {roles.map((r) =>
          renaming === r ? (
            <Input
              key={r}
              size="xs"
              autoFocus
              aria-label={t("policyEditor.roles.rename")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <div key={r} className="group flex items-center">
              <TreeRow
                className={cn("flex-1 gap-2 px-2", r === selected && "bg-accent")}
                onClick={() => {
                  setRole(r);
                  setRuleIndex(0);
                }}
              >
                <span className="min-w-0 flex-1 truncate text-left text-xs">{r}</span>
                <span className="text-3xs text-muted-foreground">
                  {rulesOf(doc, r).length}
                </span>
              </TreeRow>
              {!readOnly && (
                <>
                  <IconButton
                    size="xs"
                    icon={Pencil}
                    label={t("policyEditor.roles.rename")}
                    onClick={() => {
                      setRenaming(r);
                      setNewName(r);
                    }}
                  />
                  <IconButton
                    size="xs"
                    icon={Trash2}
                    label={
                      canRemoveRole(doc, r)
                        ? t("policyEditor.roles.remove")
                        : t("policyEditor.roles.inUse")
                    }
                    disabled={!canRemoveRole(doc, r)}
                    onClick={() => onChange(removeRole(doc, r))}
                  />
                </>
              )}
            </div>
          ),
        )}
        {!readOnly && (
          <Button
            size="xs"
            variant="ghost"
            icon={Plus}
            className="justify-start"
            onClick={() => {
              let n = 1;
              while (roleNames(doc).includes(`role${n}`)) n += 1;
              onChange(addRole(doc, `role${n}`));
              setRole(`role${n}`);
              setRenaming(`role${n}`);
              setNewName(`role${n}`);
            }}
          >
            {t("policyEditor.roles.add")}
          </Button>
        )}
      </div>

      {/* Rules of the role */}
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto border-l border-border pl-4">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          {t("policyEditor.rules.title")}
        </span>
        {selected && rules.length === 0 && (
          <p className="text-2xs text-muted-foreground">{t("policyEditor.rules.none")}</p>
        )}
        {rules.map((r, i) => (
          <div key={i} className="group flex items-center">
            <TreeRow
              className={cn("flex-1 gap-2 px-2", i === ruleIndex && "bg-accent")}
              onClick={() => setRuleIndex(i)}
            >
              <span className="min-w-0 flex-1 truncate text-left font-mono text-2xs">
                {endpointLabel(r.endpoint, t("policyEditor.rule.endpointAny"))}
              </span>
            </TreeRow>
            {!readOnly && (
              <IconButton
                size="xs"
                icon={Trash2}
                label={t("policyEditor.rules.remove")}
                onClick={() => {
                  onChange(setRules(doc, selected!, rules.filter((_, j) => j !== i)));
                  setRuleIndex(Math.max(0, i - 1));
                }}
              />
            )}
          </div>
        ))}
        {selected && !readOnly && (
          <Button
            size="xs"
            variant="ghost"
            icon={Plus}
            className="justify-start"
            onClick={() => {
              onChange(setRules(doc, selected, [...rules, newRule()]));
              setRuleIndex(rules.length);
            }}
          >
            {t("policyEditor.rules.add")}
          </Button>
        )}
      </div>

      {/* The rule */}
      <div className="min-h-0 overflow-y-auto border-l border-border pl-4 pr-1">
        {selected && rule ? (
          <RuleEditor
            key={`${selected}:${ruleIndex}`}
            rule={rule}
            profiles={profiles}
            exampleUser={exampleUser}
            readOnly={readOnly}
            onChange={(next) =>
              onChange(
                setRules(
                  doc,
                  selected,
                  rules.map((r, j) => (j === ruleIndex ? next : r)),
                ),
              )
            }
          />
        ) : (
          <p className="text-2xs text-muted-foreground">
            {selected ? t("policyEditor.rules.pick") : t("policyEditor.roles.none")}
          </p>
        )}
      </div>
    </div>
  );
}
