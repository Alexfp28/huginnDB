/**
 * The per-connection MCP write-policy picker, and the level list both it and the
 * bulk buttons above the tree read from.
 *
 * Extracted so the order of the levels exists once. `WRITE_LEVELS` is ordered
 * least-permissive first, which the bulk row relies on to lay its buttons out —
 * and so that "the last one is the dangerous one" is a property of the data
 * rather than something each call site restates.
 */

import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/ui/native-select";
import type { McpWritePolicy } from "@/types";

/** Least permissive first. `full` last is load-bearing — see the module doc. */
export const WRITE_LEVELS: McpWritePolicy[] = ["read-only", "data", "full"];

export function McpWritePolicySelect({
  value,
  onChange,
}: {
  /** `undefined` on a profile saved before the field existed: read-only. */
  value: McpWritePolicy | undefined;
  onChange: (level: McpWritePolicy) => void;
}) {
  const { t } = useTranslation();
  return (
    <NativeSelect
      value={value ?? "read-only"}
      onChange={(e) => onChange(e.target.value as McpWritePolicy)}
      aria-label={t("settings.mcp.writePolicyLabel")}
      title={t("settings.mcp.writePolicyLabel")}
      size="xs"
      className="shrink-0"
    >
      {WRITE_LEVELS.map((lvl) => (
        <option key={lvl} value={lvl}>
          {t(`settings.mcp.level.${lvl}`)}
        </option>
      ))}
    </NativeSelect>
  );
}
