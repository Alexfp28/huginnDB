import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/locales/en.json";
import es from "@/lib/i18n/locales/es.json";
import { ACTIONS, ACTION_BY_ID, CATEGORY_ORDER } from "./actions";
import { parseSequence } from "./chord";
import { resolveBindings } from "./resolve";

/** Walk a dotted i18n key, the way i18next does. */
function lookup(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, bundle);
}

describe("the action catalogue", () => {
  it("has no duplicate ids", () => {
    expect(ACTION_BY_ID.size).toBe(ACTIONS.length);
  });

  it("ships with no conflicting defaults", () => {
    // The whole point of the scope rule is that it lets some actions share a
    // key; this asserts the ones that do are the ones we meant to.
    const { conflicts } = resolveBindings({});
    expect(conflicts).toEqual([]);
  });

  it("stores every default in canonical form, so it matches what a key press produces", () => {
    for (const action of ACTIONS) {
      for (const binding of [...action.defaults, ...(action.fixed ?? [])]) {
        expect(parseSequence(binding).join(" "), `${action.id}: ${binding}`).toBe(binding);
      }
    }
  });

  it("uses Mod rather than the legacy Ctrl spelling in its own defaults", () => {
    for (const action of ACTIONS) {
      for (const binding of [...action.defaults, ...(action.fixed ?? [])]) {
        expect(binding, `${action.id}`).not.toMatch(/(^|\+)Ctrl\+/);
      }
    }
  });

  it("puts every action in a category the settings list knows how to render", () => {
    for (const action of ACTIONS) {
      expect(CATEGORY_ORDER, action.id).toContain(action.category);
    }
  });

  it.each(["en", "es"] as const)(
    "has a %s name for every category and scope the settings list renders",
    (lang) => {
      const bundle = lang === "en" ? en : es;
      for (const cat of [...CATEGORY_ORDER, "all"]) {
        expect(
          typeof lookup(bundle, `settings.shortcuts.categories.${cat}`),
          `${lang}: ${cat}`,
        ).toBe("string");
      }
      for (const scope of new Set(ACTIONS.map((a) => a.scope))) {
        expect(
          typeof lookup(bundle, `settings.shortcuts.scopes.${scope}`),
          `${lang}: ${scope}`,
        ).toBe("string");
      }
    },
  );

  it.each(["en", "es"] as const)("has a %s label for every action", (lang) => {
    const bundle = lang === "en" ? en : es;
    for (const action of ACTIONS) {
      expect(typeof lookup(bundle, action.labelKey), `${action.id} → ${action.labelKey}`).toBe(
        "string",
      );
      if (action.descKey) {
        expect(typeof lookup(bundle, action.descKey), `${action.id} → ${action.descKey}`).toBe(
          "string",
        );
      }
    }
  });
});
