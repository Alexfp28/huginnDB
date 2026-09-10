/**
 * The field control of a filter condition row, for drivers whose fields are
 * not a closed list: an editable input with a searchable suggestion panel.
 *
 * Used for MongoDB, where {@link FilterConditionRow} would otherwise offer a
 * `Select` over the collection's top-level fields alone — see `fieldPaths.ts`
 * for why that was the whole gap. Two things follow from being a combobox
 * rather than a select:
 *
 *  - **The text is the value.** Typing edits `column` directly, so a path the
 *    loaded page never showed (`meta.audit.by`, present in older documents) is
 *    still filterable. The suggestions are help, not a whitelist — Mongo
 *    resolves the dotted path server-side and an unknown one simply matches
 *    nothing, which is a filter result rather than an error.
 *  - **Opening shows everything.** The list filters by what the user has typed
 *    *since opening*, not by the value it already holds, or arriving at a row
 *    that already names `stats.count` would offer only that one field and the
 *    picker would look broken.
 *
 * **The panel floats as `position: fixed` with no offsets**, which is the one
 * shape that satisfies all three constraints here. The other three candidates
 * each fail one, and two of them shipped before this did:
 *
 *  - *Absolutely positioned inside the row* is **clipped**: the dialog's
 *    condition list is `overflow-y-auto`, a scroll container clips its
 *    positioned descendants, and the panel was cut off at that box's edge —
 *    looking as though it rendered underneath the "Add condition" button. No
 *    `z-index` fixes it; the panel was not behind anything, it was outside.
 *  - *In the document flow* (a disclosure, like the `in`/`not_in` value editor)
 *    is never clipped, but it **resizes the dialog** as it opens and closes,
 *    which is a lot of movement for a suggestion list.
 *  - *Portalled to `document.body`* escapes the clip and is then
 *    **unclickable**: the surrounding Radix `Dialog` is modal, so it sets
 *    `pointer-events: none` outside its own content and a panel that is not a
 *    descendant of that content receives no pointer events at all. Composing a
 *    floating layer with a modal dialog is what Radix's Popover exists for, and
 *    that is a dependency this does not need.
 *
 * `fixed` escapes the scroller's clip because clipping only follows the
 * containing-block chain, and a fixed element's containing block is its nearest
 * *transformed* ancestor: `DialogContent` (`-translate-x-1/2 -translate-y-1/2`),
 * which sits **above** the scroller and does not clip. It also stays a DOM
 * descendant of the dialog's content, so pointer events, the click-outside
 * listener and the dialog's focus management all keep working.
 *
 * **The offsets are measured, not left to the static position.** Leaving
 * `top`/`left` as `auto` puts a fixed box at its static position — where it
 * would have sat in the flow — which looks right until the condition list is
 * scrolled: that static position is computed in the *unscrolled* flow and then
 * read as an offset from the containing block, so the panel opened as many
 * pixels below the input as the list was scrolled. So [`fixedOrigin`] finds the
 * containing block the way CSS does, and the panel is placed at the input's
 * rect relative to it. Same reason the width is measured: `width: 100%` on a
 * fixed box resolves against the dialog, not against the input.
 *
 * Being out of the flow, the panel does not follow the list when it scrolls or
 * the window when it resizes — so either of those closes it, rather than
 * leaving it hanging next to nothing.
 *
 * Escape and Enter are stopped while the panel is open. Both belong to the
 * dialog otherwise — Escape closes it, and losing that distinction means
 * dismissing a suggestion list throws away every condition the user has
 * built.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { matchFieldPaths, type FilterField } from "@/lib/grid/fieldPaths";

/** Gap between the input and the panel, in px (`mt-1`'s worth). */
const PANEL_GAP = 4;

/**
 * The point a `position: fixed` descendant of `el` is measured from: the
 * **padding box of the nearest transformed ancestor**, which is what CSS makes
 * the containing block for fixed positioning, or the viewport origin when there
 * is none. Here that ancestor is Radix's `DialogContent`, centred with a
 * `translate`, and getting this wrong shifts the panel by the dialog's offset
 * from the viewport — i.e. by most of the screen.
 *
 * The property list is the spec's, minus the ones this app cannot produce:
 * `transform`, `perspective`, `filter` and a `will-change` naming any of them
 * all create a containing block for fixed descendants.
 */
function fixedOrigin(el: HTMLElement): { top: number; left: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (
      cs.transform !== "none" ||
      cs.perspective !== "none" ||
      cs.filter !== "none" ||
      /transform|perspective|filter/.test(cs.willChange)
    ) {
      const r = node.getBoundingClientRect();
      // Border box → padding box: the containing block excludes the border,
      // and the dialog has one.
      return {
        top: r.top + (parseFloat(cs.borderTopWidth) || 0),
        left: r.left + (parseFloat(cs.borderLeftWidth) || 0),
      };
    }
  }
  return { top: 0, left: 0 };
}

export function FilterFieldPicker({
  fields,
  value,
  onChange,
  className,
}: {
  fields: FilterField[];
  value: string;
  onChange: (path: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);
  /** Whether the user has typed since the panel opened — see the header. */
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  /** Where the panel sits, sampled when it opens — see the header. */
  const [box, setBox] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => (typed ? matchFieldPaths(fields, value) : fields),
    [fields, value, typed],
  );

  // Click outside closes. Scoped to the root subtree, so a click on the
  // panel's own padding or scrollbar is not "outside".
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // A scroll or a resize closes it: the panel is placed where the input was
  // when it opened, and the condition list it sits in scrolls. Capture phase
  // for the scroll, because it happens on that inner container and a scroll
  // event does not bubble. The panel's own scrolling is excluded — that is the
  // list being read, not the ground moving under it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    function onScroll(e: Event) {
      if (panelRef.current?.contains(e.target as Node)) return;
      close();
    }
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setTyped(false);
    setActive(0);
    setBox(measure());
    setOpen(true);
  };

  /** The panel's geometry, read off the input. */
  const measure = () => {
    const input = inputRef.current;
    if (!input) return null;
    const r = input.getBoundingClientRect();
    const origin = fixedOrigin(input);
    return {
      top: r.bottom - origin.top + PANEL_GAP,
      left: r.left - origin.left,
      width: r.width,
    };
  };

  const pick = (field: FilterField) => {
    onChange(field.path);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    // `flex-[1.6]` against the value control's `flex-1`: a dotted path runs
    // three or four segments, and splitting the row evenly cut the tail off the
    // very field the picker exists to reach.
    <div ref={rootRef} className={cn("min-w-0 flex-[1.6]", className)}>
      <div className="relative">
        <Input
          ref={inputRef}
          size="sm"
          spellCheck={false}
          autoComplete="off"
          className="pr-6 font-mono"
          placeholder={t("tableData.filter.fieldPlaceholder")}
          aria-label={t("tableData.filter.fieldLabel")}
          role="combobox"
          aria-expanded={open}
          value={value}
          // Opened by a click, a keystroke or ArrowDown — deliberately not by
          // focus alone: `AdvancedFilterDialog` focuses the first control of
          // the row a toolbar chip named, and an "edit this chip" click that
          // greeted the user with a suggestion list over the row they came to
          // edit would be answering a question nobody asked.
          onClick={show}
          onChange={(e) => {
            setTyped(true);
            setActive(0);
            setOpen(true);
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!open) {
                show();
                return;
              }
              if (visible.length === 0) return;
              const step = e.key === "ArrowDown" ? 1 : -1;
              // Wraps at both ends, so ArrowUp from the first row reaches the
              // last one — the list is short and there is no submit to hit.
              setActive((i) => (i + step + visible.length) % visible.length);
            } else if (e.key === "Enter" && open) {
              const field = visible[active];
              // Stopped either way: with a highlighted suggestion this is a
              // pick, and with an empty list it is "I meant what I typed" —
              // in both cases the keystroke has been consumed here.
              e.preventDefault();
              e.stopPropagation();
              if (field) pick(field);
              else setOpen(false);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
      </div>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          // `min-w` so a narrow field cell still gets a readable list. The
          // offsets and the width are measured rather than declared — see the
          // header for both reasons.
          style={
            box
              ? { top: box.top, left: box.left, width: box.width }
              : undefined
          }
          className="fixed z-50 max-h-44 min-w-[16rem] overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-elevation-3"
        >
          {visible.length === 0 ? (
            <div className="px-2 py-1 text-xs italic text-muted-foreground">
              {t("tableData.filter.fieldNoMatch")}
            </div>
          ) : (
            visible.map((field, i) => (
              <div
                key={field.path}
                ref={i === active ? activeRef : undefined}
                role="option"
                aria-selected={field.path === value}
                // `role="option"` rows rather than buttons: this is the ARIA
                // shape a combobox listbox asks for, and `onMouseDown`'s
                // `preventDefault` keeps the input focused so the panel does
                // not close on the way to the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(field)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex cursor-default items-center gap-2 px-2 py-1 text-xs",
                  i === active && "bg-accent text-accent-foreground",
                )}
              >
                {/* Wrapped rather than truncated with a `title=`: a deep path
                    is exactly the case where the tail carries the meaning, and
                    the OS tooltip is not a place to put it (see
                    `uiAdoption.test.ts`). */}
                <span
                  className={cn(
                    "min-w-0 break-all font-mono",
                    field.nested && "text-muted-foreground",
                  )}
                >
                  {field.nested ? (
                    <>
                      {field.path.slice(0, field.path.lastIndexOf(".") + 1)}
                      <span className="text-foreground">
                        {field.path.slice(field.path.lastIndexOf(".") + 1)}
                      </span>
                    </>
                  ) : (
                    field.path
                  )}
                </span>
                {field.type && (
                  <span className="ml-auto shrink-0 text-3xs uppercase tracking-wide text-muted-foreground">
                    {field.type}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
