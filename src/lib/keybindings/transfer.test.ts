import { describe, expect, it } from "vitest";
import {
  ShortcutImportError,
  parseKeybindingsFile,
  serializeKeybindings,
} from "./transfer";

describe("serializeKeybindings", () => {
  it("writes the overrides map, not the resolved bindings", () => {
    // Exporting every action's effective combo would freeze this version's
    // defaults into the file and opt the importing machine out of new ones.
    const json = JSON.parse(serializeKeybindings({ runQuery: ["F9"] }));
    expect(json.keybindings).toEqual({ runQuery: ["F9"] });
    expect(Object.keys(json.keybindings)).toHaveLength(1);
  });

  it("stamps a kind and a version so the importer can refuse a foreign file", () => {
    const json = JSON.parse(serializeKeybindings({}));
    expect(json.kind).toBe("huginndb-shortcuts");
    expect(typeof json.version).toBe("number");
  });
});

describe("parseKeybindingsFile", () => {
  function file(keybindings: unknown): string {
    return JSON.stringify({ kind: "huginndb-shortcuts", version: 1, keybindings });
  }

  it("round-trips its own output", () => {
    const source = { runQuery: ["F9", "Mod+Enter"], openSettings: [] };
    const result = parseKeybindingsFile(serializeKeybindings(source));
    expect(result.keybindings).toEqual(source);
    expect(result.unknownActions).toEqual([]);
  });

  it("normalizes on the way in, so a pre-Mod file still works", () => {
    const result = parseKeybindingsFile(file({ runQuery: ["Ctrl+Enter"] }));
    expect(result.keybindings.runQuery).toEqual(["Mod+Enter"]);
  });

  it("accepts the pre-1.19 bare-string shape", () => {
    const result = parseKeybindingsFile(file({ runQuery: "Ctrl+Enter" }));
    expect(result.keybindings.runQuery).toEqual(["Mod+Enter"]);
  });

  it("keeps an empty list, which means 'unbound on purpose'", () => {
    const result = parseKeybindingsFile(file({ runQuery: [] }));
    expect(result.keybindings.runQuery).toEqual([]);
  });

  it("names actions this build has never heard of instead of dropping them silently", () => {
    const result = parseKeybindingsFile(
      file({ runQuery: ["F9"], summonKraken: ["Mod+Shift+K"] }),
    );
    expect(result.unknownActions).toEqual(["summonKraken"]);
    expect(result.keybindings).toEqual({ runQuery: ["F9"] });
  });

  it("drops a binding with no key token — it could never match anything", () => {
    const result = parseKeybindingsFile(file({ runQuery: ["Mod+", "F9"] }));
    expect(result.keybindings.runQuery).toEqual(["F9"]);
  });

  it("ignores non-string entries rather than storing them", () => {
    const result = parseKeybindingsFile(file({ runQuery: ["F9", 42, null] }));
    expect(result.keybindings.runQuery).toEqual(["F9"]);
  });

  it("rejects a file that isn't JSON", () => {
    expect(() => parseKeybindingsFile("{nope")).toThrow(ShortcutImportError);
  });

  it("rejects a JSON file that isn't a shortcuts export", () => {
    // A theme export, for instance — same folder, same extension.
    expect(() =>
      parseKeybindingsFile(JSON.stringify({ kind: "huginndb-theme", theme: {} })),
    ).toThrow(ShortcutImportError);
  });

  it("carries a message key the UI can translate, not a raw sentence", () => {
    try {
      parseKeybindingsFile("{nope");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("notJson");
    }
  });
});
