/**
 * @vitest-environment jsdom
 *
 * Needs a DOM: the focus guard and `scopesAt` both walk real elements, which
 * is the whole point — a fake `closest` would test the mock, not the rule.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ActionSpec } from "./actions";
import { resolveBindings, type Keybindings } from "./resolve";
import {
  CHORD_TIMEOUT_MS,
  createKeyDispatcher,
  isTypeableChord,
  scopesAt,
  type ActionHandlers,
} from "./dispatch";
import type { KeyLike } from "./chord";

const FIXTURE = [
  { id: "runQuery", category: "query", scope: "editor", defaults: ["Mod+Enter"], labelKey: "a" },
  { id: "expandSelectedCell", category: "grid", scope: "grid", defaults: ["Space"], labelKey: "b" },
  {
    id: "refreshData",
    category: "grid",
    scope: "global",
    defaults: ["F5"],
    fixed: ["Mod+R"],
    labelKey: "c",
  },
  { id: "openSettings", category: "general", scope: "global", defaults: ["Mod+,"], labelKey: "d" },
] as unknown as ActionSpec[];

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return {
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

function harness(overrides: Keybindings = {}, handlers: ActionHandlers = {}) {
  const fired: string[] = [];
  const wired: ActionHandlers = { ...handlers };
  for (const spec of FIXTURE) {
    if (wired[spec.id] === undefined) wired[spec.id] = () => fired.push(spec.id);
  }
  const pending: string[][] = [];
  const dispatcher = createKeyDispatcher({
    getResolved: () => resolveBindings(overrides, FIXTURE),
    getHandlers: () => wired,
    onPendingChange: (chords) => pending.push(chords),
  });
  return { dispatcher, fired, pending };
}

describe("isTypeableChord", () => {
  it("treats an unmodified printable key as typing", () => {
    expect(isTypeableChord("A")).toBe(true);
    expect(isTypeableChord("1")).toBe(true);
    expect(isTypeableChord(",")).toBe(true);
    expect(isTypeableChord("Space")).toBe(true);
    expect(isTypeableChord("Shift+A")).toBe(true);
  });

  it("does not, once a command modifier is involved", () => {
    expect(isTypeableChord("Mod+A")).toBe(false);
    expect(isTypeableChord("Alt+A")).toBe(false);
    expect(isTypeableChord("Meta+A")).toBe(false);
  });

  it("does not, for keys that produce no character", () => {
    expect(isTypeableChord("F5")).toBe(false);
    expect(isTypeableChord("Escape")).toBe(false);
    expect(isTypeableChord("ArrowDown")).toBe(false);
  });
});

describe("scopesAt", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("always includes global", () => {
    expect([...scopesAt(null)]).toEqual(["global"]);
  });

  it("picks up the nearest declared surface", () => {
    document.body.innerHTML = `<div data-kb-scope="grid"><span id="cell"></span></div>`;
    const scopes = scopesAt(document.getElementById("cell"));
    expect([...scopes].sort()).toEqual(["global", "grid"]);
  });

  it("stops at the nearest one, so an overlay over the grid wins", () => {
    document.body.innerHTML = `<div data-kb-scope="grid"><div data-kb-scope="overlay"><span id="q"></span></div></div>`;
    const scopes = scopesAt(document.getElementById("q"));
    expect(scopes.has("overlay")).toBe(true);
    expect(scopes.has("grid")).toBe(false);
  });
});

describe("createKeyDispatcher", () => {
  it("runs a global action from anywhere", () => {
    const { dispatcher, fired } = harness();
    const consumed = dispatcher.handleKey(key({ key: "F5" }), ["global"]);
    expect(consumed).toBe(true);
    expect(fired).toEqual(["refreshData"]);
  });

  it("runs a fixed binding, which used to be an `if` in App.tsx", () => {
    const { dispatcher, fired } = harness();
    dispatcher.handleKey(key({ key: "r", code: "KeyR", ctrlKey: true }), ["global"]);
    expect(fired).toEqual(["refreshData"]);
  });

  it("keeps Mod+Shift+R distinct from the Mod+R alias", () => {
    const { dispatcher, fired } = harness({ openSettings: ["Mod+Shift+R"] });
    dispatcher.handleKey(
      key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }),
      ["global"],
    );
    expect(fired).toEqual(["openSettings"]);
  });

  it("ignores a scoped action when the focus is elsewhere", () => {
    const { dispatcher, fired } = harness();
    expect(dispatcher.handleKey(key({ key: " " }), ["global", "editor"])).toBe(false);
    expect(fired).toEqual([]);
  });

  it("runs a scoped action when the focus is in its surface", () => {
    const { dispatcher, fired } = harness();
    expect(dispatcher.handleKey(key({ key: " " }), ["global", "grid"])).toBe(true);
    expect(fired).toEqual(["expandSelectedCell"]);
  });

  it("reports 'not consumed' when nothing is bound, so the key falls through", () => {
    const { dispatcher } = harness();
    expect(dispatcher.handleKey(key({ key: "q", code: "KeyQ" }), ["global"])).toBe(false);
  });

  it("reports 'not consumed' when a match has no handler, so its surface can act", () => {
    // This is how the grid keeps handling `Space` itself while the window
    // listener also sees the keystroke: the binding resolves, finds no global
    // handler, and the event falls through to the grid's own React handler.
    const unhandled = createKeyDispatcher({
      getResolved: () => resolveBindings({}, FIXTURE),
      getHandlers: () => ({}),
    });
    expect(unhandled.handleKey(key({ key: " " }), ["global", "grid"])).toBe(false);
  });

  it("ignores autorepeat, so holding a key can't fire an action repeatedly", () => {
    const { dispatcher, fired } = harness();
    dispatcher.handleKey(key({ key: "F5", repeat: true }), ["global"]);
    expect(fired).toEqual([]);
  });

  it("ignores a keystroke that is part of IME composition", () => {
    const { dispatcher, fired } = harness();
    dispatcher.handleKey(key({ key: "F5", isComposing: true }), ["global"]);
    expect(fired).toEqual([]);
  });

  it("ignores a bare modifier", () => {
    const { dispatcher, fired } = harness();
    expect(dispatcher.handleKey(key({ key: "Control", ctrlKey: true }), ["global"])).toBe(
      false,
    );
    expect(fired).toEqual([]);
  });

  describe("focus guard", () => {
    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("suppresses a typeable binding inside a text field", () => {
      // Binding an action to a bare letter must not make that letter
      // untypeable — the bug the old listener had no guard against.
      document.body.innerHTML = `<input id="f" />`;
      const target = document.getElementById("f")!;
      const { dispatcher, fired } = harness({ openSettings: ["A"] });
      const consumed = dispatcher.handleKey(
        key({ key: "a", code: "KeyA", target }),
        ["global"],
      );
      expect(consumed).toBe(false);
      expect(fired).toEqual([]);
    });

    it("still fires that binding outside a text field", () => {
      document.body.innerHTML = `<div id="d"></div>`;
      const target = document.getElementById("d")!;
      const { dispatcher, fired } = harness({ openSettings: ["A"] });
      dispatcher.handleKey(key({ key: "a", code: "KeyA", target }), ["global"]);
      expect(fired).toEqual(["openSettings"]);
    });

    it("lets a modified binding through inside a text field", () => {
      document.body.innerHTML = `<input id="f" />`;
      const target = document.getElementById("f")!;
      const { dispatcher, fired } = harness();
      dispatcher.handleKey(
        key({ key: ",", ctrlKey: true, target }),
        ["global"],
      );
      expect(fired).toEqual(["openSettings"]);
    });

    it("lets F5 through inside a text field — it types nothing", () => {
      document.body.innerHTML = `<input id="f" />`;
      const target = document.getElementById("f")!;
      const { dispatcher, fired } = harness();
      dispatcher.handleKey(key({ key: "F5", target }), ["global"]);
      expect(fired).toEqual(["refreshData"]);
    });
  });

  describe("chord sequences", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("waits for the second chord instead of firing the first", () => {
      const { dispatcher, fired, pending } = harness({ openSettings: ["Mod+K Mod+S"] });
      expect(dispatcher.handleKey(key({ key: "k", code: "KeyK", ctrlKey: true }), ["global"]))
        .toBe(true);
      expect(fired).toEqual([]);
      expect(pending.at(-1)).toEqual(["Mod+K"]);

      expect(dispatcher.handleKey(key({ key: "s", code: "KeyS", ctrlKey: true }), ["global"]))
        .toBe(true);
      expect(fired).toEqual(["openSettings"]);
      expect(pending.at(-1)).toEqual([]);
    });

    it("expires the prefix after the timeout", () => {
      const { dispatcher, fired, pending } = harness({ openSettings: ["Mod+K Mod+S"] });
      dispatcher.handleKey(key({ key: "k", code: "KeyK", ctrlKey: true }), ["global"]);
      vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 1);
      expect(pending.at(-1)).toEqual([]);
      // The second chord alone now does nothing.
      dispatcher.handleKey(key({ key: "s", code: "KeyS", ctrlKey: true }), ["global"]);
      expect(fired).toEqual([]);
    });

    it("cancels on a wrong second chord instead of firing something else", () => {
      const { dispatcher, fired } = harness({
        openSettings: ["Mod+K Mod+S"],
        refreshData: ["Mod+J"],
      });
      dispatcher.handleKey(key({ key: "k", code: "KeyK", ctrlKey: true }), ["global"]);
      // `Mod+J` is bound, but mid-sequence it must cancel, not fire.
      expect(dispatcher.handleKey(key({ key: "j", code: "KeyJ", ctrlKey: true }), ["global"]))
        .toBe(true);
      expect(fired).toEqual([]);
    });

    it("still fires a one-chord binding that merely shares a prefix", () => {
      const { dispatcher, fired } = harness({
        openSettings: ["Mod+K Mod+S"],
        refreshData: ["Mod+K"],
      });
      dispatcher.handleKey(key({ key: "k", code: "KeyK", ctrlKey: true }), ["global"]);
      expect(fired).toEqual(["refreshData"]);
    });

    it("drops a half-typed prefix on reset, so a blur can't leave one armed", () => {
      const { dispatcher, fired } = harness({ openSettings: ["Mod+K Mod+S"] });
      dispatcher.handleKey(key({ key: "k", code: "KeyK", ctrlKey: true }), ["global"]);
      dispatcher.reset();
      dispatcher.handleKey(key({ key: "s", code: "KeyS", ctrlKey: true }), ["global"]);
      expect(fired).toEqual([]);
    });
  });
});
