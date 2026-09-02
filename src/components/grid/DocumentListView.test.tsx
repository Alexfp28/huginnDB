/**
 * @vitest-environment jsdom
 *
 * Regression test for `DocumentCard`'s `memo()` actually bailing out.
 * `DataGrid` passes `onExpandField` as an inline arrow (a fresh function
 * identity on every one of its own renders) and `onFieldSave`/
 * `onFieldDelete`/`onDeleteRow` as plain function declarations from
 * `TableDataTab` — all four used to be read as ordinary props by
 * `DocumentCard`, which defeated its `memo()` on every render regardless of
 * whether that row's own data had changed. `DocumentListView` now mirrors
 * them through a ref (`callbacksRef`) and passes `DocumentCard` only
 * booleans, `rowValues`/`columns`/`types`, and the ref itself — all stable
 * across a re-render that doesn't touch this row.
 *
 * `t("dataGrid.fieldsCount", …)` is the probe: it's called directly in
 * `DocumentCard`'s own render body (never inside `flattenDocument`, which is
 * shielded by its own `useMemo` regardless of the outer `memo()` — spying on
 * that would pass even with the bug present — and never inside `FieldRow`,
 * which no longer takes `t` at all). So a second call to it after a
 * `DocumentListView` re-render is proof `DocumentCard`'s function body ran
 * again, i.e. that the memo did NOT bail out.
 */
import { useRef } from "react";
import { render } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "@/lib/i18n";
import { DocumentListView } from "./DocumentListView";
import type { CellValue, ColumnMeta } from "@/types";

// Module-level so both renders in a test see the exact same array
// references — a fresh `[]` per render would (correctly) invalidate the
// memo for an unrelated reason and defeat the point of the test.
const columns: ColumnMeta[] = [{ name: "name", data_type: "text" }];
const rows: CellValue[][] = [["alice"]];

/** A page-sized batch, for the windowing test below. */
const manyRows: CellValue[][] = Array.from({ length: 500 }, (_, i) => [
  `row-${i}`,
]);

function Harness({
  onExpandField,
  rows: rowsProp = rows,
}: {
  onExpandField: () => void;
  rows?: CellValue[][];
}) {
  // The list windows its cards against this element. jsdom reports a zero-size
  // rect for it, which is enough: the virtualizer still renders the first index
  // plus its overscan, and one card is all this test needs.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={scrollRef} style={{ overflow: "auto", height: 400 }}>
      <DocumentListView
        scrollRef={scrollRef}
        columns={columns}
        rows={rowsProp}
        nullDisplay="NULL"
        zebraStripes={false}
        expandNested={false}
        showTypes={false}
        lineNumbers={false}
        onExpandField={onExpandField}
        copyToClipboard={() => {}}
        emptyLabel="empty"
      />
    </div>
  );
}

// `vi.spyOn(i18n, "t")` doesn't typecheck cleanly against i18next's heavily
// overloaded `t` signature, so this wraps it by hand — the same effect
// without fighting the type constraint.
type AnyFn = (...args: unknown[]) => unknown;
let calls: unknown[][] = [];
let originalT: typeof i18n.t;

/**
 * jsdom has no layout, so the list's virtualizer measures its scroll container
 * as 0-high and windows nothing — the probe below would read zero and this test
 * would "pass" its memo assertion while proving nothing.
 *
 * It has to be `offsetHeight`/`offsetWidth` specifically: `virtual-core`'s
 * `getRect` reads those two properties and not `getBoundingClientRect`, so
 * stubbing the rect (the obvious move) changes nothing at all. The shims live
 * here rather than as an `initialRect` escape hatch in the component, which
 * would be production code existing for jsdom's benefit.
 */
function stubSize(prop: "offsetHeight" | "offsetWidth", value: number) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get: () => value,
  });
}

/**
 * The other half of the same gap: the virtualizer watches its scroll element
 * with a `ResizeObserver`, which jsdom does not implement, so without this it
 * never learns the element has a size and windows nothing however big the rect
 * says it is. A no-op observer is enough — the rect stub above supplies the
 * measurement this would otherwise deliver.
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    NoopResizeObserver;
  stubSize("offsetHeight", 400);
  stubSize("offsetWidth", 600);
  calls = [];
  originalT = i18n.t.bind(i18n);
  i18n.t = ((...args: unknown[]) => {
    calls.push(args);
    return (originalT as unknown as AnyFn)(...args);
  }) as unknown as typeof i18n.t;
});

afterEach(() => {
  i18n.t = originalT;
});

function fieldsCountCalls() {
  return calls.filter(([key]) => key === "dataGrid.fieldsCount").length;
}

describe("DocumentCard memoization", () => {
  it("does not re-render a row when the parent passes a brand-new onExpandField", () => {
    const { rerender } = render(<Harness onExpandField={() => {}} />);
    const afterMount = fieldsCountCalls();
    expect(afterMount).toBeGreaterThan(0);

    // A fresh arrow every time, exactly like DataGrid's inline onExpandField.
    rerender(<Harness onExpandField={() => {}} />);
    expect(fieldsCountCalls()).toBe(afterMount);
  });
});

describe("the list windows its cards", () => {
  it("renders a handful of a 500-document page, not all of it", () => {
    // The reason this view is virtualised at all: a page here is a page of
    // *documents*, each expanded to one line per field, so at the largest page
    // size the unwindowed version built thousands of nodes in one synchronous
    // commit. That is the pause when switching from table to list.
    const { container } = render(
      <Harness onExpandField={() => {}} rows={manyRows} />,
    );
    const cards = container.querySelectorAll("[data-index]");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(manyRows.length);
  });

  it("windows against the container it is rendered inside", () => {
    // Regression: the scroll element is a `<div>` this component sits *in*, and
    // React attaches host refs bottom-up alongside layout effects — so the
    // virtualizer's own setup ran before the parent ref existed and windowed
    // against `null`, leaving an empty container of the right height. Nothing
    // re-rendered afterwards to make it look again.
    const { container } = render(
      <Harness onExpandField={() => {}} rows={manyRows} />,
    );
    expect(container.querySelectorAll("[data-index]").length).toBeGreaterThan(
      0,
    );
  });
});
