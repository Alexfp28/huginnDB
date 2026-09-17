/**
 * @vitest-environment jsdom
 *
 * `CellPreview` used to pretty-print unconditionally — it was the one surface
 * in the app that always formatted, while the two editors never did. It now
 * reads the same `editor.autoFormat*` preferences they do, which is the whole
 * point of the unification: the panel and the editor you escalate it into stop
 * disagreeing about what the cell looks like.
 *
 * That unification is also the one regression risk in the change, and these
 * tests are the guard on it. `autoFormatJson`/`autoFormatXml` ship **on**
 * precisely so this component keeps behaving as it always has; if someone ever
 * "tidies" those defaults to off, the first test here is what fails and says
 * why.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "@/lib/i18n";
import { CellPreview } from "./CellPreview";
import { usePreferences } from "@/stores/preferences/preferences";
import type { EditorPrefs } from "@/types";

const COMPACT_JSON = '{"a":1,"b":[2,3]}';
const COMPACT_XML = "<root><a>1</a></root>";

/** Patch just the auto-format switches, leaving the rest of the prefs alone. */
function setAutoFormat(patch: Partial<EditorPrefs>) {
  const s = usePreferences.getState();
  usePreferences.setState({
    prefs: { ...s.prefs, editor: { ...s.prefs.editor, ...patch } },
  });
}

function renderPreview(value: string) {
  return render(
    <CellPreview
      columnName="payload"
      value={value}
      onClose={() => {}}
      onFullscreen={() => {}}
    />,
  );
}

const DEFAULTS = usePreferences.getState().prefs.editor;

afterEach(() => {
  cleanup();
  usePreferences.setState({
    prefs: { ...usePreferences.getState().prefs, editor: DEFAULTS },
  });
});

describe("CellPreview formatting", () => {
  it("ships formatting JSON, as it always has", () => {
    // No patching: this asserts the shipped defaults, not a contrived state.
    expect(DEFAULTS.autoFormatJson).toBe(true);
    expect(DEFAULTS.autoFormatXml).toBe(true);
    renderPreview(COMPACT_JSON);
    expect(screen.getByText(/"a": 1/)).toBeTruthy();
  });

  it("renders JSON verbatim once the preference is off", () => {
    setAutoFormat({ autoFormatJson: false });
    const { container } = renderPreview(COMPACT_JSON);
    expect(container.textContent).toContain(COMPACT_JSON);
  });

  it("honours the XML switch independently of the JSON one", () => {
    // The requirement in one assertion: turning JSON on must not drag XML
    // along with it.
    setAutoFormat({ autoFormatJson: true, autoFormatXml: false });
    const { container } = renderPreview(COMPACT_XML);
    expect(container.textContent).toContain(COMPACT_XML);
  });

  it("does not format SQL by default", () => {
    expect(DEFAULTS.autoFormatSql).toBe(false);
    const sql = "select id from users";
    const { container } = renderPreview(sql);
    expect(container.textContent).toContain(sql);
  });

  /**
   * Also the one check that `sql-formatter` actually runs in a DOM
   * environment. It is the single dependency this feature added, it ships a
   * `nearley` grammar rather than a regex pass, and the app's real home is a
   * WebView — a package that quietly reached for a Node built-in would build
   * fine under Vite and only fail at runtime, in front of a user.
   */
  it("formats SQL in a DOM environment once switched on", () => {
    setAutoFormat({ autoFormatSql: true });
    const { container } = renderPreview("select id from users");
    expect(container.textContent).toContain("SELECT");
  });

  describe("with a value the formatter cannot round-trip", () => {
    beforeEach(() => setAutoFormat({ autoFormatJson: true }));

    it("shows the raw text rather than a number it changed", () => {
      // 10000000000000000001 does not survive an f64. The preview never
      // writes, but showing a value the database does not hold is its own
      // kind of lie.
      const raw = '{"id":10000000000000000001}';
      const { container } = renderPreview(raw);
      expect(container.textContent).toContain("10000000000000000001");
    });
  });
});
