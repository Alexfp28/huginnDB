/**
 * Characterisation tests for the VS Code theme importer, run against five
 * REAL themes pulled from open-vsx rather than hand-written fixtures.
 *
 * That choice is the point of the file. Every failure mode this importer has
 * to survive was found by reading actual theme files, not by imagining them:
 * Tokyo Night and Nord do not parse as JSON at all, Dracula and GitHub carry
 * dozens of eight-digit colours, One Dark Pro omits `button.foreground`, and
 * all five omit `menu.*`. A synthetic fixture would have had none of those
 * properties, and the importer would have shipped broken against the exact
 * themes people actually import.
 */

import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, hexToHslTriple, type ThemeColors } from "@/lib/themes";
import {
  contrastRatio,
  ensureContrast,
  flattenAlpha,
  mix,
  parseHex,
  shift,
  toHex,
} from "./color";
import {
  canonicalPath,
  isLightVariant,
  loadThemeFile,
  parseThemeJson,
  payloadFromBareThemeFile,
  readManifestThemes,
  resolveRelative,
} from "./parse";
import { mapVariant, paletteWarnings } from "./map";
import { splitScopes, toMonacoTheme } from "./monaco";
import {
  autoPairVariants,
  buildThemeImport,
  findInstalledFamily,
  describeVariants,
  monacoThemeId,
} from "./index";
import type { VsixPayload } from "./types";

import dracula from "./__fixtures__/dracula.json?raw";
import tokyoNight from "./__fixtures__/tokyo-night.json?raw";
import nord from "./__fixtures__/nord.json?raw";
import githubLight from "./__fixtures__/github-light-default.json?raw";
import oneDarkPro from "./__fixtures__/one-dark-pro.json?raw";

const FIXTURES: [name: string, raw: string, isLight: boolean][] = [
  ["Dracula", dracula, false],
  ["Tokyo Night", tokyoNight, false],
  ["Nord", nord, false],
  ["GitHub Light Default", githubLight, true],
  ["One Dark Pro", oneDarkPro, false],
];

/** Every token `applyTheme` walks, taken from a built-in so the list cannot
 *  drift away from `ThemeColors` without this failing. */
const ALL_TOKENS = Object.keys(BUILT_IN_THEMES[0].dark) as (keyof ThemeColors)[];

function payloadOf(raw: string, path = "theme.json"): VsixPayload {
  return payloadFromBareThemeFile(raw, path);
}

describe("color", () => {
  it("parses every hex form a VS Code theme may use", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex("#44475A")).toEqual({ r: 0x44, g: 0x47, b: 0x5a, a: 1 });
    expect(parseHex("#44475A75")?.a).toBeCloseTo(0x75 / 255, 5);
    expect(parseHex("#f00a")?.a).toBeCloseTo(0xaa / 255, 5);
  });

  it("treats non-hex values as absent rather than guessing", () => {
    expect(parseHex("red")).toBeNull();
    expect(parseHex("rgba(0,0,0,.5)")).toBeNull();
    expect(parseHex("")).toBeNull();
    expect(parseHex(undefined)).toBeNull();
  });

  it("flattens a translucent colour over its backdrop", () => {
    // 50% white over black is mid grey; the operator is plain source-over.
    expect(flattenAlpha("#ffffff80", "#000000")).toBe("#808080");
    expect(flattenAlpha("#00000000", "#123456")).toBe("#123456");
    // Already opaque: the backdrop is irrelevant.
    expect(flattenAlpha("#abcdef", "#000000")).toBe("#abcdef");
  });

  it("cannot flatten a translucent colour without a parseable backdrop", () => {
    expect(flattenAlpha("#ffffff80", "not-a-colour")).toBeNull();
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("ensureContrast leaves a passing pair untouched", () => {
    expect(ensureContrast("#ffffff", "#000000", 4.5)).toBe("#ffffff");
  });

  it("ensureContrast rescues a failing pair toward the far pole", () => {
    // Near-identical greys: the foreground must move away from the light
    // background, i.e. darken.
    const fixed = ensureContrast("#8a8a8a", "#808080", 4.5);
    expect(contrastRatio(fixed, "#808080")).toBeGreaterThan(contrastRatio("#8a8a8a", "#808080"));
    expect(parseHex(fixed)!.r).toBeLessThan(0x8a);
  });

  it("ensureContrast picks the pole by measurement, not by a luminance cut", () => {
    // #808080 has WCAG luminance 0.216, so a naive `> 0.5 ? black : white`
    // sends it toward WHITE for a ratio of 3.9 - while black gives 5.3.
    // This is the regression that check exists to prevent.
    expect(contrastRatio("#000000", "#808080")).toBeGreaterThan(
      contrastRatio("#ffffff", "#808080"),
    );
    expect(contrastRatio(ensureContrast("#7a7a7a", "#808080", 4.5), "#808080")).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("ensureContrast stops at the pole when the target is unreachable", () => {
    // AAA (7:1) against a mid grey is impossible from either direction, so
    // the contract is "best effort", not "meets the ratio" - anything
    // stricter would make the importer refuse themes it can still improve.
    expect(ensureContrast("#7a7a7a", "#808080", 7)).toBe("#000000");
    expect(contrastRatio("#000000", "#808080")).toBeLessThan(7);
  });

  it("shift moves toward white for positive and black for negative", () => {
    expect(parseHex(shift("#808080", 0.5)!)!.r).toBeGreaterThan(0x80);
    expect(parseHex(shift("#808080", -0.5)!)!.r).toBeLessThan(0x80);
  });

  it("mix and toHex round-trip within rounding", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(toHex({ r: 300, g: -5, b: 12.6 })).toBe("#ff000d");
  });
});

describe("JSONC parsing", () => {
  it.each(FIXTURES)("parses %s, which real-world JSON.parse cannot", (_name, raw) => {
    expect(() => parseThemeJson(raw)).not.toThrow();
  });

  it("confirms the fixtures genuinely need JSONC", () => {
    // If these ever start parsing as strict JSON the fixtures have been
    // replaced with something that no longer covers the case.
    expect(() => JSON.parse(tokyoNight)).toThrow();
    expect(() => JSON.parse(nord)).toThrow();
  });

  it("rejects text that is not a theme at all", () => {
    expect(() => payloadOf("{ not json at all ")).toThrow();
    expect(() => payloadOf('{"hello":"world"}')).toThrow();
  });
});

describe("paths and manifests", () => {
  it("canonicalises the forms a manifest and an include use", () => {
    expect(canonicalPath("./themes/x.json")).toBe("themes/x.json");
    expect(canonicalPath("themes\\x.json")).toBe("themes/x.json");
    expect(canonicalPath("/themes/x.json")).toBe("themes/x.json");
  });

  it("resolves an include relative to the including file", () => {
    expect(resolveRelative("themes/dark.json", "./base.json")).toBe("themes/base.json");
    expect(resolveRelative("themes/a/dark.json", "../base.json")).toBe("themes/base.json");
    expect(resolveRelative("dark.json", "themes/base.json")).toBe("themes/base.json");
  });

  it("reads contributed themes and defaults an unknown uiTheme to dark", () => {
    const themes = readManifestThemes({
      contributes: {
        themes: [
          { label: "A", uiTheme: "vs", path: "./a.json" },
          { label: "B", uiTheme: "nonsense", path: "./b.json" },
          { label: "No path", uiTheme: "vs-dark" },
        ],
      },
    });
    expect(themes).toHaveLength(2);
    expect(themes[1].uiTheme).toBe("vs-dark");
    expect(isLightVariant(themes[0].uiTheme)).toBe(true);
  });

  it("merges an include, with the including file winning per key", () => {
    const files = {
      "base.json": JSON.stringify({
        colors: { "editor.background": "#111111", "editor.foreground": "#eeeeee" },
        tokenColors: [{ scope: "comment", settings: { foreground: "#555555" } }],
      }),
      "child.json": JSON.stringify({
        include: "./base.json",
        colors: { "editor.background": "#222222" },
        tokenColors: [{ scope: "keyword", settings: { foreground: "#ff0000" } }],
      }),
    };
    const merged = loadThemeFile("child.json", files);
    expect(merged.colors!["editor.background"]).toBe("#222222");
    expect(merged.colors!["editor.foreground"]).toBe("#eeeeee");
    // Base rules first: a later rule wins for the same scope in TextMate.
    expect(merged.tokenColors!.map((t) => t.scope)).toEqual(["comment", "keyword"]);
  });

  it("keeps what it has when an include is missing or cyclic", () => {
    const missing = loadThemeFile("child.json", {
      "child.json": JSON.stringify({ include: "./nope.json", colors: { "editor.background": "#1a1a1a" } }),
    });
    expect(missing.colors!["editor.background"]).toBe("#1a1a1a");

    const cyclic = loadThemeFile("a.json", {
      "a.json": JSON.stringify({ include: "./b.json", colors: { "editor.background": "#0a0a0a" } }),
      "b.json": JSON.stringify({ include: "./a.json", colors: { "editor.foreground": "#fafafa" } }),
    });
    expect(cyclic.colors!["editor.background"]).toBe("#0a0a0a");
  });
});

describe("chrome palette derivation", () => {
  it.each(FIXTURES)("%s yields every token as an opaque hex", (_name, raw, isLight) => {
    const file = loadThemeFile("theme.json", { "theme.json": raw });
    const colors = mapVariant(file, isLight);

    for (const token of ALL_TOKENS) {
      const value = colors[token];
      expect(value, `${token} missing`).toBeTruthy();
      // The whole point of flattening at import: `applyTheme` runs every
      // token through this, and it rejects anything but #RGB/#RRGGBB. A
      // token that fails here would silently vanish from the painted theme.
      expect(hexToHslTriple(value), `${token} = ${value} is not applyTheme-safe`).not.toBeNull();
      expect(parseHex(value)!.a, `${token} kept its alpha`).toBe(1);
    }
  });

  it.each(FIXTURES)("%s stays readable on every surface pair", (_name, raw, isLight) => {
    const file = loadThemeFile("theme.json", { "theme.json": raw });
    expect(paletteWarnings(mapVariant(file, isLight))).toEqual([]);
  });

  it.each(FIXTURES)("%s keeps every surface distinct from the page", (_name, raw, isLight) => {
    // Four of these five hand back at least one surface identical to
    // `editor.background` — Nord's sidebar IS its editor background, GitHub
    // Light's menu and input backgrounds are both plain white. Correct in VS
    // Code, which separates those planes with a border; here it would mean a
    // panel that is not there and an input field with no field.
    const c = mapVariant(loadThemeFile("theme.json", { "theme.json": raw }), isLight);
    for (const token of ["card", "popover", "secondary", "muted", "accent"] as const) {
      expect(c[token].toLowerCase(), `${token} collapsed onto background`).not.toBe(
        c.background.toLowerCase(),
      );
    }
  });

  it("leaves a subtle separation the theme did state alone", () => {
    // Tokyo Night's panel (#16161e on #1a1b26) is a deliberate, quiet step.
    // The collapse guard must not "improve" it — only an actual collapse is
    // corrected.
    const c = mapVariant(loadThemeFile("t.json", { "t.json": tokyoNight }), false);
    expect(c.card).toBe("#16161e");
  });

  it("flattens a translucent selection rather than dropping it", () => {
    // Dracula's `list.activeSelectionBackground` is opaque but its
    // `list.hoverBackground` is #44475A75 - the derived accent must be a
    // real colour either way, and never the raw 8-digit value.
    const file = loadThemeFile("theme.json", { "theme.json": dracula });
    const { accent } = mapVariant(file, false);
    expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("derives a brand hover when the theme states no button hover", () => {
    // One Dark Pro omits `button.hoverBackground`; the hover must still
    // differ from the brand, and lighten on a dark variant.
    const file = loadThemeFile("theme.json", { "theme.json": oneDarkPro });
    const { brand, brandHover } = mapVariant(file, false);
    expect(brandHover).not.toBe(brand);
    expect(parseHex(brandHover)!.r + parseHex(brandHover)!.g + parseHex(brandHover)!.b).toBeGreaterThan(
      parseHex(brand)!.r + parseHex(brand)!.g + parseHex(brand)!.b,
    );
  });

  it("keeps a light variant light and a dark variant dark", () => {
    const light = mapVariant(loadThemeFile("t.json", { "t.json": githubLight }), true);
    const dark = mapVariant(loadThemeFile("t.json", { "t.json": dracula }), false);
    expect(contrastRatio(light.background, "#ffffff")).toBeLessThan(2);
    expect(contrastRatio(dark.background, "#000000")).toBeLessThan(2);
  });

  it("falls back inside the theme when a key is absent", () => {
    // No workbench key at all: every token still resolves, derived from the
    // two colours that do exist.
    const colors = mapVariant(
      { colors: { "editor.background": "#101820", "editor.foreground": "#f0f4f8" } },
      false,
    );
    for (const token of ALL_TOKENS) expect(hexToHslTriple(colors[token])).not.toBeNull();
    expect(colors.card).not.toBe(colors.background);
  });
});

describe("monaco translation", () => {
  it("splits scopes written as string, list, and comma-separated", () => {
    expect(splitScopes("comment")).toEqual(["comment"]);
    expect(splitScopes(["a", "b"])).toEqual(["a", "b"]);
    expect(splitScopes("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(splitScopes(undefined)).toEqual([]);
  });

  it.each(FIXTURES)("%s produces Monaco-legal token rules", (_name, raw, isLight) => {
    const file = loadThemeFile("theme.json", { "theme.json": raw });
    const data = toMonacoTheme(file, isLight ? "vs" : "vs-dark");

    expect(data.rules.length).toBeGreaterThan(10);
    for (const rule of data.rules) {
      // Monaco throws on a `#` prefix or an alpha channel in a token rule.
      if (rule.foreground) expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/i);
      if (rule.background) expect(rule.background).toMatch(/^[0-9a-f]{6}$/i);
      if (rule.fontStyle !== undefined) {
        expect(rule.fontStyle).toMatch(/^(|italic|bold|underline)( (italic|bold|underline))*$/);
      }
    }
  });

  it.each(FIXTURES)("%s forwards only colour keys Monaco knows", (_name, raw) => {
    const file = loadThemeFile("theme.json", { "theme.json": raw });
    const { colors } = toMonacoTheme(file, "vs-dark");
    expect(Object.keys(colors!).length).toBeGreaterThan(5);
    for (const key of Object.keys(colors!)) {
      expect(key).not.toMatch(/^(activityBar|statusBar|titleBar|sideBar|tab|menubar)\./);
    }
  });

  it("keeps alpha on editor colours, where it is meaningful", () => {
    const file = loadThemeFile("theme.json", { "theme.json": dracula });
    const { colors } = toMonacoTheme(file, "vs-dark");
    const translucent = Object.values(colors!).filter((v) => /^#[0-9a-f]{8}$/i.test(v));
    expect(translucent.length).toBeGreaterThan(0);
  });
});

describe("end-to-end import", () => {
  it("builds a family plus both Monaco themes from one payload", () => {
    const payload = payloadOf(dracula, "themes/dracula.json");
    const variants = describeVariants(payload);
    expect(variants).toHaveLength(1);
    expect(variants[0].side).toBe("dark");

    const result = buildThemeImport(payload, { darkPath: variants[0].path });
    expect(result.family.builtin).toBe(false);
    expect(result.family.id).toBeTruthy();
    expect(result.monacoThemes.map((m) => m.id)).toEqual([
      monacoThemeId(result.family.id, "light"),
      monacoThemeId(result.family.id, "dark"),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("pairs a light and a dark variant into one family", () => {
    const payload: VsixPayload = {
      displayName: "Mixed",
      identifier: "test.mixed",
      version: "1.0.0",
      themes: [
        { label: "Light", uiTheme: "vs", path: "light.json" },
        { label: "Dark", uiTheme: "vs-dark", path: "dark.json" },
      ],
      files: { "light.json": githubLight, "dark.json": dracula },
    };
    const { family } = buildThemeImport(payload, {
      lightPath: "light.json",
      darkPath: "dark.json",
      name: "Mixed",
    });
    expect(family.name).toBe("Mixed");
    // Each half came from its own source, not from duplicating one.
    expect(family.light.background).not.toBe(family.dark.background);
    expect(contrastRatio(family.light.background, "#ffffff")).toBeLessThan(2);
  });

  it("duplicates the one chosen side when an extension ships only dark", () => {
    const payload = payloadOf(dracula, "dracula.json");
    const { family } = buildThemeImport(payload, { darkPath: "dracula.json" });
    expect(family.light).toEqual(family.dark);
  });

  it("refuses an empty selection", () => {
    expect(() => buildThemeImport(payloadOf(dracula), {})).toThrow();
  });

  it("takes the light/dark side of a bare file from its own `type`", () => {
    expect(describeVariants(payloadOf(githubLight))[0].side).toBe("light");
    expect(describeVariants(payloadOf(dracula))[0].side).toBe("dark");
  });
});

describe("automatic variant pairing", () => {
  const contribution = (label: string, uiTheme: string, path: string) =>
    ({ label, uiTheme, path }) as never;

  it("takes the first contribution on each side", () => {
    // Manifest order is the author's own: GitHub leads with its Default
    // variants and follows with high-contrast and colourblind ones.
    const pair = autoPairVariants([
      contribution("GitHub Light Default", "vs", "light-default.json"),
      contribution("GitHub Light High Contrast", "hc-light", "light-hc.json"),
      contribution("GitHub Dark Default", "vs-dark", "dark-default.json"),
      contribution("GitHub Dark High Contrast", "hc-black", "dark-hc.json"),
    ]);
    expect(pair).toEqual({
      lightPath: "light-default.json",
      darkPath: "dark-default.json",
    });
  });

  it("leaves a side undefined when the extension contributes none", () => {
    // Dracula ships two dark variants and no light one; the undefined side is
    // what makes `buildThemeImport` duplicate rather than invent a palette.
    const pair = autoPairVariants([
      contribution("Dracula Theme", "vs-dark", "dracula.json"),
      contribution("Dracula Theme Soft", "vs-dark", "dracula-soft.json"),
    ]);
    expect(pair).toEqual({ lightPath: undefined, darkPath: "dracula.json" });
  });

  it("produces a usable import with no questions asked", () => {
    const payload = payloadOf(dracula, "dracula.json");
    const result = buildThemeImport(payload, autoPairVariants(payload.themes));
    expect(result.family.name).toBeTruthy();
    expect(result.monacoThemes).toHaveLength(2);
  });

  it("returns an empty selection for an extension with no variants", () => {
    // `buildThemeImport` then refuses, rather than this inventing a path.
    expect(autoPairVariants([])).toEqual({ lightPath: undefined, darkPath: undefined });
  });
});

describe("matching an installed theme to a registry row", () => {
  const dracula = { namespace: "dracula-theme", name: "theme-dracula" };

  it("matches on the registry identity, not the display name", () => {
    // The regression this replaced: an install whose recorded name came from
    // the package manifest never matched the row, which shows the registry's
    // own `displayName`. Here they deliberately disagree.
    const installed = {
      "fam-1": { label: "Dracula", source: { ...dracula, registryUrl: "", version: "1" } },
    };
    expect(findInstalledFamily(installed, dracula)).toBe("fam-1");
  });

  it("still matches after the theme is renamed", () => {
    const installed = {
      "fam-1": { label: "My own purple thing", source: { ...dracula } },
    };
    expect(findInstalledFamily(installed, dracula)).toBe("fam-1");
  });

  it("does not match a different extension from the same publisher", () => {
    const installed = { "fam-1": { label: "Dracula", source: { ...dracula } } };
    expect(
      findInstalledFamily(installed, { namespace: "dracula-theme", name: "something-else" }),
    ).toBeNull();
  });

  it("ignores themes imported from a local file, which have no source", () => {
    const installed = { "fam-1": { label: "Dracula", source: null } };
    expect(findInstalledFamily(installed, dracula)).toBeNull();
  });
});

describe("reconciling a locally imported theme with its registry listing", () => {
  const extension = { namespace: "dracula-theme", name: "theme-dracula" };

  it("matches a local .vsix import on its manifest identifier", () => {
    // No registry origin at all — it was dragged in from disk — but the
    // manifest names the same extension, so the panel must not offer it as
    // if it were new. Verified against the live registry before being relied
    // on: `publisher.name` equalled `namespace.name` for every colour theme
    // sampled.
    const installed = {
      "fam-1": { label: "Dracula", source: null, identifier: "dracula-theme.theme-dracula" },
    };
    expect(findInstalledFamily(installed, extension)).toBe("fam-1");
  });

  it("ignores capitalisation, which differs between the two sources", () => {
    const installed = {
      "fam-1": { label: "GitHub", source: null, identifier: "github.github-vscode-theme" },
    };
    expect(
      findInstalledFamily(installed, { namespace: "GitHub", name: "github-vscode-theme" }),
    ).toBe("fam-1");
  });

  it("does not match a different extension whose name merely starts the same", () => {
    const installed = {
      "fam-1": { label: "Dracula", source: null, identifier: "dracula-theme.theme-dracula" },
    };
    expect(
      findInstalledFamily(installed, { namespace: "dracula-theme", name: "theme" }),
    ).toBeNull();
  });

  it("carries the identifier out of a build so the install can record it", () => {
    const payload = payloadOf(dracula, "dracula.json");
    expect(buildThemeImport(payload, autoPairVariants(payload.themes)).identifier).toBe("");
  });
});
