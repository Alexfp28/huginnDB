/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
    },
    extend: {
      colors: {
        // Every token is a full `light-dark(...)` colour now (see
        // index.css/themes.ts), not a raw "H S% L%" triple — so `hsl(var(--x))`
        // would double-wrap a colour into an invalid value. `<alpha-value>` is
        // Tailwind's own placeholder for a colour modifier (`bg-brand/25`):
        // Tailwind substitutes it directly (bypassing its `hsl(var(--x))`
        // regex parser, which doesn't recognise `var(--x)` or `light-dark()`),
        // so every token gets this treatment uniformly — including ones with
        // no modifier today — rather than leaving a gap that fails silently
        // (opaque instead of translucent, no build error) the day someone
        // writes `pk/50`.
        border: "color-mix(in srgb, var(--border) calc(<alpha-value> * 100%), transparent)",
        input: "color-mix(in srgb, var(--input) calc(<alpha-value> * 100%), transparent)",
        ring: "color-mix(in srgb, var(--ring) calc(<alpha-value> * 100%), transparent)",
        background: "color-mix(in srgb, var(--background) calc(<alpha-value> * 100%), transparent)",
        foreground: "color-mix(in srgb, var(--foreground) calc(<alpha-value> * 100%), transparent)",
        primary: {
          DEFAULT: "color-mix(in srgb, var(--primary) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--primary-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        secondary: {
          DEFAULT: "color-mix(in srgb, var(--secondary) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--secondary-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        destructive: {
          DEFAULT: "color-mix(in srgb, var(--destructive) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--destructive-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        muted: {
          DEFAULT: "color-mix(in srgb, var(--muted) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--muted-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        accent: {
          DEFAULT: "color-mix(in srgb, var(--accent) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--accent-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        brand: {
          DEFAULT: "color-mix(in srgb, var(--brand) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--brand-foreground) calc(<alpha-value> * 100%), transparent)",
          // The brand surface under the pointer. Enables `hover:bg-brand-hover`
          // instead of `hover:bg-brand/90` — a transparency fades the accent
          // into the surface on dark themes, which is backwards for a hover.
          hover: "color-mix(in srgb, var(--brand-hover) calc(<alpha-value> * 100%), transparent)",
        },
        success: {
          DEFAULT: "color-mix(in srgb, var(--success) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--success-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        warning: {
          DEFAULT: "color-mix(in srgb, var(--warning) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--warning-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        // Data-semantic accents (text/icon only). Enable `text-pk`, `text-fk`,
        // `text-numeric` and `decoration-fk` — see index.css for rationale.
        pk: "color-mix(in srgb, var(--pk) calc(<alpha-value> * 100%), transparent)",
        fk: "color-mix(in srgb, var(--fk) calc(<alpha-value> * 100%), transparent)",
        numeric: "color-mix(in srgb, var(--numeric) calc(<alpha-value> * 100%), transparent)",
        popover: {
          DEFAULT: "color-mix(in srgb, var(--popover) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--popover-foreground) calc(<alpha-value> * 100%), transparent)",
        },
        card: {
          DEFAULT: "color-mix(in srgb, var(--card) calc(<alpha-value> * 100%), transparent)",
          foreground: "color-mix(in srgb, var(--card-foreground) calc(<alpha-value> * 100%), transparent)",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        // `Inter` is listed first so that self-hosting it later (a single
        // @fontsource import) is picked up automatically; until then the stack
        // falls back to the platform UI sans (Segoe UI on Windows, the app's
        // primary target). This replaces Tailwind's default sans so the whole
        // app stops rendering in the bare system default.
        sans: [
          "Inter",
          "Segoe UI Variable",
          "Segoe UI",
          "-apple-system",
          "BlinkMacSystemFont",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
      },
      fontSize: {
        // Tokenised micro-type scale for this dense desktop tool. The codebase
        // was littered with arbitrary `text-[9px]/[10px]/[11px]` values with no
        // rhythm; `2xs` (11px) and `3xs` (10px) replace them and enforce a
        // legibility floor of 10px (9px chips/tags were below comfortable size).
        "3xs": ["0.625rem", { lineHeight: "0.875rem" }],
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        // Elevation scale keyed off `--foreground` (not a fixed black) so lifts
        // read correctly in light themes (soft dark shadow) and as a faint
        // separating halo in dark themes — mirrors the `.outer-dock` island
        // treatment in index.css. Everything was previously flat (a single
        // radius, ad-hoc `shadow-lg/xl`); this gives popovers/dialogs/cards a
        // consistent depth ramp.
        "elevation-1": "0 1px 2px color-mix(in srgb, var(--foreground) 6%, transparent), 0 1px 1px color-mix(in srgb, var(--foreground) 4%, transparent)",
        "elevation-2": "0 2px 6px color-mix(in srgb, var(--foreground) 8%, transparent), 0 1px 2px color-mix(in srgb, var(--foreground) 6%, transparent)",
        "elevation-3": "0 8px 24px color-mix(in srgb, var(--foreground) 12%, transparent), 0 2px 6px color-mix(in srgb, var(--foreground) 8%, transparent)",
        "elevation-4": "0 16px 48px color-mix(in srgb, var(--foreground) 18%, transparent), 0 4px 12px color-mix(in srgb, var(--foreground) 10%, transparent)",
        // Brand affordance glow — the hover/active state of anything that
        // spends the accent blue (primary buttons, the active connection card).
        // Deliberately short-range: the brief rules out neon halos.
        brand: "0 2px 12px color-mix(in srgb, var(--brand) 35%, transparent)",
        "brand-ring": "0 0 0 1px color-mix(in srgb, var(--brand) 35%, transparent), 0 2px 12px color-mix(in srgb, var(--brand) 28%, transparent)",
      },
      transitionDuration: {
        // The brand motion band is 150–220ms; Tailwind ships 150/200/300, so
        // the two ends that were missing are added rather than letting call
        // sites round to 300 (which reads sluggish on a desktop tool).
        180: "180ms",
        220: "220ms",
      },
      keyframes: {
        // "Pequeños destellos azules al completar acciones" — one short brand
        // pulse on the element that just succeeded. Not a loop: it fires once
        // and leaves nothing behind.
        "brand-flash": {
          "0%": { boxShadow: "0 0 0 0 color-mix(in srgb, var(--brand) 55%, transparent)" },
          "70%": { boxShadow: "0 0 0 6px color-mix(in srgb, var(--brand) 0%, transparent)" },
          "100%": { boxShadow: "0 0 0 0 color-mix(in srgb, var(--brand) 0%, transparent)" },
        },
        // The shared open/appear motion: fade + 98→100% scale, per the brief.
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.98)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "brand-flash": "brand-flash 520ms ease-out 1",
        "pop-in": "pop-in 180ms ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
