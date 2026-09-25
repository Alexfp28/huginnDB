/**
 * The policy editor's field controls: a list of name patterns, a server, and
 * the two permission blocks. Each edits one piece of a rule's JSON and hands
 * the new value back; none of them validates, since the backend parses every
 * draft with the parser that applies it (`policy_validate`).
 */

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { PERMISSIONS, type EndpointJson } from "@/lib/policy/draft";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

/** A label above its control, with an optional hint under it. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-3xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Name patterns, one per line (`*` is the wildcard). With `allLabel`, the
 * list can also be absent — "every database", "every relation" — which is not
 * the same as an empty list ("none"), so the two are a toggle rather than an
 * empty box that means one or the other.
 */
export function PatternListField({
  id,
  label,
  hint,
  value,
  allLabel,
  onlyLabel,
  suggestions = [],
  readOnly,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string[] | undefined;
  /** When given, `undefined` means "all" and the field offers the toggle. */
  allLabel?: string;
  onlyLabel?: string;
  suggestions?: string[];
  readOnly: boolean;
  onChange: (next: string[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const all = allLabel !== undefined && value === undefined;
  // The text is local so a half-typed line is not trimmed away under the
  // cursor; it follows the value whenever the value changes from outside.
  const [text, setText] = useState((value ?? []).join("\n"));
  useEffect(() => {
    setText((prev) =>
      lines(prev).join("\n") === (value ?? []).join("\n")
        ? prev
        : (value ?? []).join("\n"),
    );
  }, [value]);
  const current = new Set((value ?? []).map((v) => v.toLowerCase()));
  const offered = suggestions.filter((s) => !current.has(s.toLowerCase())).slice(0, 24);

  return (
    <Field label={label} hint={hint}>
      {allLabel !== undefined && (
        <Segmented<"all" | "only">
          size="sm"
          aria-label={label}
          value={all ? "all" : "only"}
          onValueChange={(v) => {
            if (readOnly) return;
            onChange(v === "all" ? undefined : (value ?? []));
          }}
          options={[
            { value: "all", label: allLabel },
            { value: "only", label: onlyLabel ?? t("policyEditor.rule.onlyThese") },
          ]}
        />
      )}
      {!all && (
        <>
          <Textarea
            id={id}
            rows={Math.min(6, Math.max(2, (value ?? []).length + 1))}
            className="font-mono text-xs"
            spellCheck={false}
            readOnly={readOnly}
            placeholder={t("policyEditor.rule.patternPlaceholder")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onChange(lines(e.target.value));
            }}
          />
          {!readOnly && offered.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-3xs text-muted-foreground">
                {t("policyEditor.rule.suggestions")}
              </span>
              {offered.map((s) => (
                <Button
                  key={s}
                  size="xs"
                  variant="outline"
                  icon={Plus}
                  className="h-6 px-1.5 font-mono text-3xs"
                  onClick={() => onChange([...(value ?? []), s])}
                >
                  {s}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </Field>
  );
}

const DRIVERS = ["postgres", "mysql", "sqlserver", "mongodb"] as const;

type EndpointKind = "any" | "server" | "file";

function kindOf(e: EndpointJson): EndpointKind {
  if (e === "*") return "any";
  return e.path !== undefined ? "file" : "server";
}

/** Which server a rule is about: every one, a host (optionally a driver and a
 *  port), or a SQLite file — filled from a saved connection or typed. */
export function EndpointField({
  value,
  profiles,
  readOnly,
  onChange,
}: {
  value: EndpointJson;
  profiles: ConnectionProfile[];
  readOnly: boolean;
  onChange: (next: EndpointJson) => void;
}) {
  const { t } = useTranslation();
  const kind = kindOf(value);
  const obj = value === "*" ? {} : value;
  const servers = profiles.filter((p) => !p.ephemeral && p.driver !== "sqlite");
  const files = profiles.filter((p) => !p.ephemeral && p.driver === "sqlite");

  return (
    <Field label={t("policyEditor.rule.endpoint")} hint={t("policyEditor.rule.endpointHint")}>
      <Segmented<EndpointKind>
        size="sm"
        aria-label={t("policyEditor.rule.endpoint")}
        value={kind}
        onValueChange={(k) => {
          if (readOnly || k === kind) return;
          onChange(k === "any" ? "*" : k === "file" ? { path: "" } : { host: "" });
        }}
        options={[
          { value: "any", label: t("policyEditor.rule.endpointAny") },
          { value: "server", label: t("policyEditor.rule.endpointServer") },
          { value: "file", label: t("policyEditor.rule.endpointFile") },
        ]}
      />
      {kind === "server" && (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <Input
            size="sm"
            aria-label={t("policyEditor.rule.host")}
            placeholder="erp.empresa.local"
            className="font-mono"
            readOnly={readOnly}
            value={obj.host ?? ""}
            onChange={(e) => onChange({ ...obj, host: e.target.value })}
          />
          <NativeSelect
            size="sm"
            aria-label={t("policyEditor.rule.driver")}
            disabled={readOnly}
            value={obj.driver ?? ""}
            onChange={(e) => {
              const { driver: _d, ...rest } = obj;
              onChange(e.target.value ? { ...rest, driver: e.target.value } : rest);
            }}
          >
            <option value="">{t("policyEditor.rule.anyDriver")}</option>
            {DRIVERS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </NativeSelect>
          <Input
            size="sm"
            type="number"
            className="w-24"
            aria-label={t("policyEditor.rule.port")}
            placeholder={t("policyEditor.rule.anyPort")}
            readOnly={readOnly}
            value={obj.port ?? ""}
            onChange={(e) => {
              const { port: _p, ...rest } = obj;
              const n = parseInt(e.target.value, 10);
              onChange(Number.isFinite(n) ? { ...rest, port: n } : rest);
            }}
          />
        </div>
      )}
      {kind === "file" && (
        <Input
          size="sm"
          className="font-mono"
          aria-label={t("policyEditor.rule.path")}
          placeholder={"\\\\srv\\datos\\ventas.db"}
          readOnly={readOnly}
          value={obj.path ?? ""}
          onChange={(e) => onChange({ path: e.target.value })}
        />
      )}
      {kind !== "any" && !readOnly && (kind === "server" ? servers : files).length > 0 && (
        <NativeSelect
          size="xs"
          aria-label={t("policyEditor.rule.fromConnection")}
          value=""
          onChange={(e) => {
            const p = profiles.find((x) => x.id === e.target.value);
            if (!p) return;
            onChange(
              p.driver === "sqlite"
                ? { path: p.database }
                : {
                    driver: p.driver,
                    host: p.host,
                    ...(p.port ? { port: p.port } : {}),
                  },
            );
          }}
        >
          <option value="">{t("policyEditor.rule.fromConnection")}</option>
          {(kind === "server" ? servers : files).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

/**
 * What the person (`human`) and their AI (`ai`) may do. The AI never gets
 * more than the person (D1), so an AI permission the person lacks is shown
 * disabled rather than offered and silently ignored by the policy.
 */
export function PermissionGrid({
  human,
  ai,
  readOnly,
  onChange,
}: {
  human: string[];
  ai: string[];
  readOnly: boolean;
  onChange: (next: { human: string[]; ai: string[] }) => void;
}) {
  const { t } = useTranslation();
  const toggle = (list: string[], p: string, on: boolean) =>
    on ? PERMISSIONS.filter((x) => x === p || list.includes(x)) : list.filter((x) => x !== p);

  return (
    <Field label={t("policyEditor.rule.permissions")} hint={t("policyEditor.rule.permissionsHint")}>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-3xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">
                {t("policyEditor.rule.permission")}
              </th>
              <th className="px-2 py-1 font-medium">{t("settings.policy.human")}</th>
              <th className="px-2 py-1 font-medium">{t("settings.policy.ai")}</th>
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => {
              const h = human.includes(p);
              const a = ai.includes(p);
              return (
                <tr key={p} className="border-t border-border">
                  <td className="px-2 py-1">
                    <span className="font-mono">{p}</span>
                    <span className="ml-2 text-3xs text-muted-foreground">
                      {t(`policyEditor.perm.${p}`)}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-center">
                    <Checkbox
                      aria-label={`${t("settings.policy.human")}: ${p}`}
                      checked={h}
                      disabled={readOnly}
                      onChange={(e) => {
                        const nextHuman = toggle(human, p, e.target.checked);
                        // Taking a permission from the person takes it from
                        // their AI too: `ai ∩ human` is what applies.
                        const nextAi = e.target.checked ? ai : ai.filter((x) => x !== p);
                        onChange({ human: nextHuman, ai: nextAi });
                      }}
                    />
                  </td>
                  <td className={cn("px-2 py-1 text-center", !h && "opacity-40")}>
                    <Checkbox
                      aria-label={`${t("settings.policy.ai")}: ${p}`}
                      checked={a && h}
                      disabled={readOnly || !h}
                      onChange={(e) =>
                        onChange({ human, ai: toggle(ai, p, e.target.checked) })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Field>
  );
}
