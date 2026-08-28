/**
 * `tailwind.config.js`'s `colorToken()` helper is supposed to be invisible:
 * a color utility with a `/modifier` (`bg-card/40`) must compile to the same
 * CSS it always has, and one without a modifier (`bg-card`) must drop the
 * `color-mix()` layer entirely. That equivalence is exactly what this test
 * verifies — by compiling real Tailwind utility classes through the actual
 * installed `tailwindcss` engine, once against the *current* config and once
 * against a frozen copy of the pre-`colorToken()` color tokens (2ecaaf7's
 * `<alpha-value>` + `color-mix()` template, with Tailwind's default
 * corePlugins — i.e. the legacy `bg-opacity-*`/`border-opacity-*`/...
 * utilities enabled, which is what routes even a bare `bg-card` through the
 * `--tw-bg-opacity` custom-property indirection today). Compiling through
 * the real engine — rather than hand-typing expected strings — is what
 * makes the "con modificador" assertions byte-for-byte and immune to
 * getting Tailwind's own opacity-variable plumbing wrong.
 */
import { afterAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

const REAL_CONFIG_PATH = path.resolve(__dirname, "../../tailwind.config.js");

const BEFORE_COLORS = {
  border: "color-mix(in srgb, var(--border) calc(<alpha-value> * 100%), transparent)",
  card: {
    DEFAULT: "color-mix(in srgb, var(--card) calc(<alpha-value> * 100%), transparent)",
  },
  muted: {
    foreground: "color-mix(in srgb, var(--muted-foreground) calc(<alpha-value> * 100%), transparent)",
  },
  brand: {
    DEFAULT: "color-mix(in srgb, var(--brand) calc(<alpha-value> * 100%), transparent)",
  },
  fk: "color-mix(in srgb, var(--fk) calc(<alpha-value> * 100%), transparent)",
};

const tmpFiles: string[] = [];

interface CompiledRule {
  selector: string;
  decls: string[];
}

async function ruleFor(configOrPath: string | object, className: string): Promise<CompiledRule> {
  let target: string | object = configOrPath;
  if (typeof configOrPath === "string") {
    // Loaded as a PATH (not an inline object) so it goes through Tailwind's
    // own config loader (jiti), the same way `postcss.config.js` loads it at
    // build time — including the `require("tailwindcss-animate")` call in
    // the real file, which a plain `import` from this ESM test file cannot
    // evaluate. `content` is overridden here (can't be passed alongside a
    // path) so the compiled utilities layer contains exactly the one class
    // under test, nothing from the app's real source tree.
    const tmp = path.join(os.tmpdir(), `tw-color-token-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(
      tmp,
      `import base from ${JSON.stringify(configOrPath)};\n` +
        `export default { ...base, content: [{ raw: ${JSON.stringify(`<div class="${className}"></div>`)} }] };\n`,
    );
    tmpFiles.push(tmp);
    target = tmp;
  } else {
    target = { ...configOrPath, content: [{ raw: `<div class="${className}"></div>` }] };
  }
  const result = await postcss([tailwindcss(target as Parameters<typeof tailwindcss>[0])]).process(
    "@tailwind utilities;",
    { from: undefined },
  );
  const root = postcss.parse(result.css);
  const rule = root.first;
  if (!rule || rule.type !== "rule") {
    throw new Error(`expected a single utility rule for .${className}, got:\n${result.css.slice(0, 300)}`);
  }
  const decls: string[] = [];
  rule.walkDecls((d) => {
    decls.push(`${d.prop}: ${d.value}`);
  });
  return { selector: rule.selector, decls };
}

function beforeConfig() {
  return { theme: { extend: { colors: BEFORE_COLORS } } };
}

afterAll(() => {
  for (const f of tmpFiles) fs.rmSync(f, { force: true });
});

describe("tailwind color tokens: color-mix() only when a /modifier is present", () => {
  test.each([
    "bg-card/40",
    "border-border/50",
    "text-muted-foreground/70",
    "ring-brand/40",
    "divide-border/60",
    "bg-brand/[0.07]",
  ])("%s is byte-identical before/after colorToken()", async (className) => {
    const before = await ruleFor(beforeConfig(), className);
    const after = await ruleFor(REAL_CONFIG_PATH, className);
    expect(after.decls).toEqual(before.decls);
  });

  test.each(["bg-card", "border-border", "decoration-fk", "fill-brand"])(
    "%s drops the color-mix() layer entirely (no modifier)",
    async (className) => {
      const after = await ruleFor(REAL_CONFIG_PATH, className);
      expect(after.decls.some((d) => d.includes("color-mix"))).toBe(false);
      expect(after.decls.some((d) => /var\(--[\w-]+\)$/.test(d))).toBe(true);
    },
  );

  test("from-brand: the from-stop drops color-mix, the to-stop keeps it (opacityValue 0 is not undefined)", async () => {
    // This is the guard-must-not-be-falsy trap the commit is about: `from-*`
    // calls the color function with the literal number `0` for its implicit
    // "fade to transparent" `to`-stop. `!0` is `true`, so a falsy check would
    // wrongly treat that as "no modifier" and render the gradient opaque.
    const before = await ruleFor(beforeConfig(), "from-brand");
    const after = await ruleFor(REAL_CONFIG_PATH, "from-brand");
    const find = (decls: string[], prefix: string) => decls.find((d) => d.startsWith(prefix));

    expect(find(after.decls, "--tw-gradient-from:")).toBe("--tw-gradient-from: var(--brand) var(--tw-gradient-from-position)");
    expect(find(after.decls, "--tw-gradient-from:")).not.toEqual(find(before.decls, "--tw-gradient-from:"));
    expect(find(after.decls, "--tw-gradient-to:")).toEqual(find(before.decls, "--tw-gradient-to:"));
  });

  test("bg-card/100 is byte-different (fully-opaque modifier treated as no-modifier) but semantically identical", async () => {
    const before = await ruleFor(beforeConfig(), "bg-card/100");
    const after = await ruleFor(REAL_CONFIG_PATH, "bg-card/100");
    expect(before.decls).toEqual(["background-color: color-mix(in srgb, var(--card) calc(1 * 100%), transparent)"]);
    expect(after.decls).toEqual(["background-color: var(--card)"]);
  });
});
