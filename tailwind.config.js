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
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        // Data-semantic accents (text/icon only). Enable `text-pk`, `text-fk`,
        // `text-numeric` and `decoration-fk` — see index.css for rationale.
        pk: "hsl(var(--pk))",
        fk: "hsl(var(--fk))",
        numeric: "hsl(var(--numeric))",
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
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
        "elevation-1": "0 1px 2px hsl(var(--foreground) / 0.06), 0 1px 1px hsl(var(--foreground) / 0.04)",
        "elevation-2": "0 2px 6px hsl(var(--foreground) / 0.08), 0 1px 2px hsl(var(--foreground) / 0.06)",
        "elevation-3": "0 8px 24px hsl(var(--foreground) / 0.12), 0 2px 6px hsl(var(--foreground) / 0.08)",
        "elevation-4": "0 16px 48px hsl(var(--foreground) / 0.18), 0 4px 12px hsl(var(--foreground) / 0.10)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
