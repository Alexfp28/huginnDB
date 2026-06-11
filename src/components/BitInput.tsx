/**
 * Dedicated 0/1 control for BIT columns, used by the INSERT draft row and by
 * inline cell editing in the data grid.
 *
 * BIT is conceptually a number (0/1 for `BIT(1)`), but the grid *displays* it
 * as true/false when `bitDisplay` is `true_false` (gotcha #15), which made a
 * plain text input confusing on insert ("does it want a boolean or a digit?").
 * This control sidesteps that: it always emits the numeric string `"0"`/`"1"`
 * (what the backend's `CAST(? AS UNSIGNED)` expects) while labelling the
 * options per the user's `bitDisplay` preference.
 *
 * The component is intentionally a single `onSelect` callback rather than the
 * `onChange`/`onCommit`/`onCancel` trio of [[CellInput]]: a `<select>` commits
 * the instant the user picks, so the inline-edit call site saves straight from
 * `onSelect` (avoiding the stale-state race a deferred commit would hit).
 */

import { useEffect } from "react";

const NULL_OPT = "__null__";

interface BitInputProps {
  /** Current value: `"0"`/`"1"` (or legacy `"true"`/`"false"`), or `null`. */
  value: string | null;
  /** Grid preference deciding the option labels. */
  bitDisplay: "true_false" | "zero_one";
  nullable?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Fired with the chosen value (`"0"`/`"1"`/`null`). */
  onSelect: (value: string | null) => void;
  /** Esc handler (inline-edit mode). */
  onCancel?: () => void;
  /** Seed a non-null BIT to `"0"` on mount — used by the draft row so a new
   *  row's required BIT column has a sensible value without forcing a click. */
  seedDefault?: boolean;
}

/** Normalise any accepted representation to `"0"` / `"1"` / `""` (null). */
function normalize(value: string | null): "0" | "1" | "" {
  if (value === null || value === undefined) return "";
  if (value === "1" || value.toLowerCase() === "true") return "1";
  if (value === "0" || value.toLowerCase() === "false") return "0";
  return value === "" ? "" : "1";
}

export function BitInput({
  value,
  bitDisplay,
  nullable,
  disabled,
  autoFocus,
  onSelect,
  onCancel,
  seedDefault,
}: BitInputProps) {
  const cur = normalize(value);

  // Draft row: a fresh, required BIT column should default to 0 rather than
  // sit at NULL (which the INSERT would reject). Runs once on mount.
  useEffect(() => {
    if (seedDefault && value == null) onSelect("0");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = (v: "0" | "1") =>
    bitDisplay === "true_false" ? (v === "1" ? "true" : "false") : v;

  return (
    <select
      autoFocus={autoFocus}
      disabled={disabled}
      value={cur === "" ? NULL_OPT : cur}
      onChange={(e) =>
        onSelect(e.target.value === NULL_OPT ? null : e.target.value)
      }
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel?.();
        }
      }}
      className="h-6 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {nullable && <option value={NULL_OPT}>NULL</option>}
      <option value="0">{label("0")}</option>
      <option value="1">{label("1")}</option>
    </select>
  );
}
