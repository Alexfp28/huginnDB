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

function Harness({ onExpandField }: { onExpandField: () => void }) {
  return (
    <DocumentListView
      columns={columns}
      rows={rows}
      nullDisplay="NULL"
      zebraStripes={false}
      expandNested={false}
      showTypes={false}
      lineNumbers={false}
      onExpandField={onExpandField}
      copyToClipboard={() => {}}
      emptyLabel="empty"
    />
  );
}

// `vi.spyOn(i18n, "t")` doesn't typecheck cleanly against i18next's heavily
// overloaded `t` signature, so this wraps it by hand — the same effect
// without fighting the type constraint.
type AnyFn = (...args: unknown[]) => unknown;
let calls: unknown[][] = [];
let originalT: typeof i18n.t;

beforeEach(() => {
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
