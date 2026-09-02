/**
 * Drift guards for the component library.
 *
 * Not a linter — the project deliberately has none beyond `tsc` and
 * `cargo clippy` (CLAUDE.md, "Explicitly out of scope"). These are ordinary
 * Vitest assertions over the source tree, following the precedent of
 * `lib/tailwindColorTokens.test.ts`, which already compiles Tailwind in-process
 * to check a token contract.
 *
 * **Every rule here has an empty allowlist, and that is the design rule rather
 * than a coincidence: a rule is only written if its allowlist *can* be empty
 * after the migration it guards. One that needs exceptions is a matter of taste
 * and does not belong in a test.** That criterion is what kept several tempting
 * rules out — see the note at the bottom.
 *
 * Two things these do NOT check, because they are checked better elsewhere:
 * that a consumer's `className` beats a variant default (asserted on rendered
 * output in `button.test.tsx` and `badge.test.tsx` — `cva` alone does not
 * merge, so a test against its output would prove nothing), and that each
 * primitive forwards a ref (`tsc` catches a missing ref at the call site).
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_THEMES } from "@/lib/themes";

const ROOT = "src/components";
const UI = join(ROOT, "ui");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(path);
  }
  return out;
}

/**
 * Source with comments and template literals stripped, so a rule cannot fire on
 * prose. Several docstrings quote the very patterns these rules forbid — the
 * one in `ConnectionRailRow` explains why its row is a `<div role="button">` by
 * naming the checkbox input it has to nest, and would otherwise fail rule G
 * forever.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const ALL = walk(ROOT);
const IN_UI = ALL.filter((p) => p.startsWith(UI));
const OUTSIDE_UI = ALL.filter((p) => !p.startsWith(UI));

/** `path:line` for every line of every file matching `re`. */
function hits(files: string[], re: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    code(file)
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) found.push(`${file}:${i + 1}`);
      });
  }
  return found;
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const themeTokens = Object.keys(BUILT_IN_THEMES[0].dark).map(
  (k) => `--${kebab(k)}`,
);

describe("A — the three theme layers name the same tokens", () => {
  // The one rule here guarding a *correctness* property rather than
  // consistency: a token declared in two layers and forgotten in the third
  // silently falls back, and nothing else would notice.
  const tailwind = new Set(
    [
      ...readFileSync("tailwind.config.js", "utf8").matchAll(
        /colorToken\("(--[\w-]+)"\)/g,
      ),
    ].map((m) => m[1]),
  );
  const css = new Set(
    [...readFileSync("src/index.css", "utf8").matchAll(/^ {4}(--[\w-]+):/gm)]
      .map((m) => m[1])
      // `--radius` is not a colour; `--dv-*` is the Dockview theme block.
      .filter((v) => v !== "--radius" && !v.startsWith("--dv-")),
  );
  const theme = new Set(themeTokens);

  it("tailwind.config.js and the theme store agree", () => {
    expect([...theme].filter((t) => !tailwind.has(t))).toEqual([]);
    expect([...tailwind].filter((t) => !theme.has(t))).toEqual([]);
  });

  it("index.css declares a stylesheet default for every token", () => {
    // Those defaults are what a custom theme persisted before a token existed
    // falls back to, so a missing one renders that theme unstyled.
    expect([...theme].filter((t) => !css.has(t))).toEqual([]);
  });
});

describe("B — ui/ does not reach into the app", () => {
  // What keeps the layer renderable in a test with no mocks, and neuters
  // gotcha #1 by construction: a bad Zustand selector inside a primitive would
  // arrive in a hundred call sites at once.
  it("imports no store, no IPC and no i18n", () => {
    expect(
      hits(
        IN_UI,
        /from "@\/stores\/|from "@\/lib\/tauri"|from "react-i18next"|from "@\/types"/,
      ),
    ).toEqual([]);
  });
});

describe("C — shadows come from the elevation scale", () => {
  // Tailwind's shadows are a fixed black; `shadow-elevation-*` mixes
  // `--foreground`, so a raw shadow under a dark panel is a black smear rather
  // than the lift it was meant to be.
  it("no raw shadow-sm/md/lg/xl/2xl anywhere in components", () => {
    expect(hits(ALL, /\bshadow-(sm|md|lg|xl|2xl)\b/)).toEqual([]);
  });
});

describe("E — every literal CSS variable names a real token", () => {
  const known = new Set([...themeTokens, "--radius"]);
  it("a mistyped var() would render nothing rather than fail the build", () => {
    const bad: string[] = [];
    for (const file of ALL) {
      for (const m of code(file).matchAll(/var\((--[\w-]+)\)/g)) {
        // Radix sets its own custom properties on the floating wrapper.
        if (m[1].startsWith("--radix-")) continue;
        if (!known.has(m[1])) bad.push(`${file}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("F — className resolves conflicts", () => {
  // An interpolated template literal just concatenates, so a class from one of
  // its branches and one from the literal part both land in the attribute and
  // the browser picks by specificity — not by what the author meant. `cn` is
  // tailwind-merge and settles it. A template with no `${}` is only a string
  // and has nothing to resolve, so the rule is about interpolation alone.
  it("no interpolated template literal in a className", () => {
    const bad: string[] = [];
    for (const file of ALL) {
      // Read the raw source: `code()` blanks template literals, which is
      // exactly what this rule looks for. And scan whole-file rather than
      // line-by-line, because the interpolation is often on the line *after*
      // the opening backtick once Prettier has wrapped a long class string.
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/className=\{`[^`]*?\$\{/gs)) {
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${file}:${line}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("H — an icon button does not carry the OS tooltip", () => {
  /**
   * The hole the first `IconButton` sweep left, found by a user rather than by
   * a rule: that sweep looked for raw `<button>` elements, and most of the
   * app's icon buttons were already `Button` components with a native `title`.
   * Twenty-nine of them, showing the OS tooltip — no theme, no shared delay —
   * right next to migrated ones showing the app's.
   *
   * `IconButton`'s type omits `title`, which stops it there; nothing stopped it
   * on a plain `Button`. This does.
   *
   * A `<Button size="icon">` whose body is not a lone icon (one carries a count
   * badge) keeps its `Button` and wraps in `SimpleTooltip` — so the rule is
   * about `title`, not about which component is used.
   */
  const openTag = (src: string, from: number) => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) return i;
    }
    return -1;
  };

  it("no Button with size=icon* also sets a native title", () => {
    const bad: string[] = [];
    for (const file of ALL) {
      const src = code(file);
      for (const m of src.matchAll(/<Button\b/g)) {
        const end = openTag(src, m.index + m[0].length);
        if (end === -1) continue;
        const attrs = src.slice(m.index + m[0].length, end);
        if (attrs.includes('size="icon') && /\btitle=/.test(attrs)) {
          bad.push(`${file}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("G — the patterns that now have a primitive", () => {
  it("no raw select outside ui/native-select", () => {
    expect(hits(OUTSIDE_UI, /<select[\s/>]/)).toEqual([]);
  });

  it("no raw checkbox input outside ui/checkbox", () => {
    expect(hits(OUTSIDE_UI, /type="checkbox"/)).toEqual([]);
  });

  it("no hand-rolled Loader2 spinner outside ui/", () => {
    // As an element only. `NotificationCard` legitimately uses `Loader2` as the
    // *icon* of a progress notification, passing the component through a map,
    // which is not a spinner assembled by hand.
    expect(hits(OUTSIDE_UI, /<Loader2[\s/>]/)).toEqual([]);
  });
});

/**
 * Rules considered and rejected, so the next session does not re-litigate them:
 *
 * - **Ban native `title=`.** `tooltip.tsx` documents the case where it is
 *   *correct* (inside open menu content, where Radix's tooltip fights the
 *   menu's portal handling), and several `title` occurrences are component
 *   props rather than DOM attributes. The enforcement for icon buttons is
 *   `IconButton`'s type, which omits `title` — a compile error, not a regex.
 * - **"Use cva for every variant-by-size matrix."** No proxy exists that is not
 *   a style rule in disguise: `select.tsx`'s `position === "popper" &&` is a
 *   correct conditional nobody would want inside cva.
 * - **Ban `animate-spin` outside ui/.** Three legitimate uses remain: two icons
 *   that carry meaning by spinning (a spinning `RefreshCw` says "refreshing",
 *   which a neutral spinner would lose) and one notification icon spinning
 *   under a condition. That needs an allowlist, so by the rule at the top it
 *   should not exist. The `<Loader2` rule above covers what matters.
 * - **Snapshot each primitive's resolved classes.** Every deliberate style
 *   change would produce a diff accepted without being read: a ritual, not a
 *   guard.
 * - **Ban `rounded` (a fixed 4px, outside the `--radius` scale).** Objectively
 *   right — 87 corners do not participate in the scale — but the migration
 *   moves pixels app-wide while `--radius` is not theme-editable, so the
 *   incoherence is purely aesthetic today. If `--radius` ever becomes a
 *   preference, this becomes a real rule.
 */
