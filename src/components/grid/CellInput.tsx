/**
 * Shared single-line cell input used both by the inline INSERT draft row
 * and by inline cell editing (double-click on an existing cell).
 *
 * It renders a monospace text field plus two optional affordances:
 * - a "∅" button that forces the cell to NULL (shown when `nullable`);
 * - a "expand" button that escalates to the full Monaco editor (shown when
 *   `onExpand` is provided).
 *
 * Commit / cancel wiring is opt-in: when `onCommit` / `onCancel` are given the
 * field commits on Enter and on blur, and cancels on Esc. The draft row leaves
 * them undefined because it owns keyboard / blur handling at the row level.
 *
 * Both auxiliary buttons call `preventDefault` on mousedown so clicking them
 * never blurs the input first — which would otherwise trigger a premature
 * commit in inline-edit mode.
 *
 * **The affordances live inside the field's box, not beside it.** They used to
 * be flex siblings of a bordered `<input>`, each painting its own opaque
 * `bg-background` so that `sticky` had something to sit on. Against a tinted
 * row — hover, selection, the draft row's own wash — that is a hard-edged pale
 * rectangle butted up against a rounded, focus-haloed field, which is the seam
 * this component was reported for. Now the wrapper carries the border and the
 * focus treatment (`fieldFocus("focus-within")`, the variant `styles.ts`
 * documents for exactly this shape), the input is transparent inside it, and
 * the buttons share the field's own surface so there is nothing to seam
 * against.
 *
 * The two of them also travel together in one `sticky` group now. Only the
 * expand button was sticky before, so on a very wide column the "∅" button
 * scrolled away while its neighbour stayed — one affordance pinned, one not,
 * for no stated reason. One sticky container is also one compositing layer
 * rather than two.
 */

import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { Braces, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldFocus } from "@/components/ui/styles";

interface CellInputProps {
  /** Current value; `null` renders a "NULL" placeholder. */
  value: string | null;
  /** When true, render the "∅" set-NULL button. */
  nullable?: boolean;
  /** Highlight the "∅" button as the active NULL state. */
  nullActive?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string | null) => void;
  /** Commit on Enter / blur (inline single-cell mode only). */
  onCommit?: () => void;
  /** Cancel on Esc (inline single-cell mode only). */
  onCancel?: () => void;
  /** Render an expand button that escalates to the modal editor. */
  onExpand?: () => void;
  /** Tooltip for the expand button. */
  expandTitle?: string;
  /**
   * The column has a JSON Schema attached, so the expand button says so.
   *
   * This is the discoverability path for anyone who never opens the heavy
   * editor: a one-line `<input>` cannot offer completion or validation, so the
   * only hint that the schema exists is that escalating is worth it. Double-click
   * behaviour is unchanged (gotcha #12) — this swaps an icon, nothing more.
   */
  schemaBound?: boolean;
}

export const CellInput = forwardRef<HTMLInputElement, CellInputProps>(
  function CellInput(
    {
      value,
      nullable,
      nullActive,
      disabled,
      autoFocus,
      onChange,
      onCommit,
      onCancel,
      onExpand,
      expandTitle,
      schemaBound,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const wired = Boolean(onCommit || onCancel);
    return (
      <div
        className={cn(
          "flex h-6 items-center rounded-sm border border-input bg-background pl-1.5 transition-colors",
          fieldFocus("focus-within"),
          disabled && "opacity-60",
        )}
      >
        <input
          ref={ref}
          autoFocus={autoFocus}
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          placeholder={value === null ? "NULL" : ""}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={
            wired
              ? (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onCommit?.();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancel?.();
                  }
                }
              : undefined
          }
          onBlur={onCommit ? () => onCommit() : undefined}
        />
        {(onExpand || nullable) && (
          // `sticky`, not just flow position, so a wide column doesn't push
          // these off the right edge of the scroll container — the field
          // stretches to the cell's full (possibly very wide) width, and
          // without this they were only reachable by scrolling that specific
          // cell all the way over. The group is opaque for the same reason it
          // always was (sticky content scrolls over what's beneath it), but it
          // now paints the *field's* surface from inside the field's border
          // rather than its own rectangle over the row.
          <span className="sticky right-0 z-[1] flex shrink-0 items-center gap-0.5 bg-background pl-0.5 pr-1">
            {onExpand && (
              <button
                type="button"
                tabIndex={-1}
                title={expandTitle}
                disabled={disabled}
                className={cn(
                  "rounded-sm px-1 py-0.5 transition-colors hover:bg-accent",
                  schemaBound
                    ? "text-brand hover:text-brand/80"
                    : "text-muted-foreground/80 hover:text-foreground",
                )}
                // Keep focus on the input so blur-commit doesn't fire before we
                // hand the current value off to the modal editor.
                onMouseDown={(e) => e.preventDefault()}
                onClick={onExpand}
              >
                {schemaBound ? (
                  <Braces className="h-3 w-3" />
                ) : (
                  <Maximize2 className="h-3 w-3" />
                )}
              </button>
            )}
            {nullable && (
              <button
                type="button"
                tabIndex={-1}
                title={t("cellEditor.setNull")}
                disabled={disabled}
                className={cn(
                  "rounded-sm px-1 text-3xs transition-colors",
                  nullActive
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground/50 hover:bg-accent hover:text-foreground",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(null)}
              >
                ∅
              </button>
            )}
          </span>
        )}
      </div>
    );
  },
);
