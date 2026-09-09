/**
 * @vitest-environment jsdom
 *
 * The SQL block's contract with the shared Monaco providers.
 *
 * Monaco itself cannot mount in jsdom (it needs a real layout and a worker), so
 * both it and `lib/monaco/monacoSql` are stubbed and what is asserted is the
 * *registration*: one lens per statement, a label that says "open in editor"
 * rather than "run", a `runStatement` that hands the statement to a query tab,
 * and no lens at all while the fence is still open.
 *
 * That is the part worth pinning. The lens is the one place decision D4 is
 * visible to a user — the assistant proposes, the editor runs — and a
 * `runStatement` that quietly executed instead would be a security decision
 * changed by a one-line edit.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { SqlBlock } from "./SqlBlock";

interface Registered {
  getCompletions: () => unknown[];
  getLenses: () => Array<{ startLine: number; text: string }>;
  runStatement: (text: string) => void;
  lensLabel?: () => { title: string; tooltip: string };
}

const registered: Registered[] = [];
const openQueryTab = vi.fn<(id: string, opts?: { sql?: string }) => string>();

vi.mock("@/lib/monaco/monacoSql", () => ({
  ensureSqlProviders: () => {},
  fireSqlLensChange: () => {},
  registerSqlEditor: (_uri: string, entry: Registered) => {
    registered.push(entry);
    return () => {};
  },
}));

vi.mock("@/lib/tabs/openQueryTab", () => ({
  openQueryTab: (id: string, opts?: { sql?: string }) => openQueryTab(id, opts),
}));

// `@monaco-editor/react` mounts a real editor; the stub calls `onMount` with
// just enough of one for the registration path.
vi.mock("@monaco-editor/react", () => ({
  default: ({
    onMount,
    value,
  }: {
    onMount?: (editor: unknown, monaco: unknown) => void;
    value: string;
  }) => {
    onMount?.(
      { getModel: () => ({ uri: { toString: () => "inmemory://ai/1" } }) },
      {},
    );
    return <pre data-testid="editor">{value}</pre>;
  },
}));

beforeEach(() => {
  registered.length = 0;
  openQueryTab.mockReset().mockReturnValue("tab-1");
});

afterEach(cleanup);

describe("SqlBlock", () => {
  it("registers one lens per statement", () => {
    render(
      <SqlBlock
        code={"SELECT 1;\nSELECT 2;"}
        language="sql"
        connectionId="c1"
        runnable
      />,
    );
    expect(registered).toHaveLength(1);
    const lenses = registered[0].getLenses();
    expect(lenses).toEqual([
      { startLine: 1, text: "SELECT 1;" },
      { startLine: 2, text: "SELECT 2;" },
    ]);
  });

  /** D4 made visible: the lens hands the statement to the editor. */
  it("opens the statement in a query tab instead of running it", () => {
    render(
      <SqlBlock code="SELECT 1;" language="sql" connectionId="c1" runnable />,
    );
    registered[0].runStatement("SELECT 1;");
    expect(openQueryTab).toHaveBeenCalledWith("c1", { sql: "SELECT 1;" });
  });

  it("labels the lens as opening the editor, not as running", () => {
    render(
      <SqlBlock code="SELECT 1;" language="sql" connectionId="c1" runnable />,
    );
    const label = registered[0].lensLabel?.();
    expect(label?.title).toMatch(/open in editor/i);
    expect(label?.title).not.toMatch(/\brun\b/i);
    expect(label?.tooltip).toMatch(/nothing runs until/i);
  });

  /** A fence that has not closed yet is a half-written statement. */
  it("offers no lens while the block is still streaming", () => {
    render(
      <SqlBlock
        code="SELECT id FROM"
        language="sql"
        connectionId="c1"
        runnable={false}
      />,
    );
    expect(registered[0].getLenses()).toEqual([]);
  });

  /** With no connection there is nowhere to open a tab, and silently opening
   *  one against whatever was last selected would be worse than doing nothing. */
  it("does nothing when there is no connection to open a tab against", () => {
    render(
      <SqlBlock code="SELECT 1;" language="sql" connectionId={null} runnable />,
    );
    registered[0].runStatement("SELECT 1;");
    expect(openQueryTab).not.toHaveBeenCalled();
  });

  /** The transcript is read-only, so a suggestion widget could only ever
   *  appear and do nothing. */
  it("offers no completions", () => {
    render(
      <SqlBlock code="SELECT 1;" language="sql" connectionId="c1" runnable />,
    );
    expect(registered[0].getCompletions()).toEqual([]);
  });
});
