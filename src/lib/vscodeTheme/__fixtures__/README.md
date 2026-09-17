# Third-party theme fixtures

Colour-theme files taken verbatim from real VS Code extensions published on
[open-vsx.org](https://open-vsx.org), used as test fixtures for the importer in
`src/lib/vscodeTheme/`. **All five are MIT-licensed**, and each remains the
copyright of its respective authors; they are redistributed here under that
licence, unmodified.

| File | Extension | Version | Licence | Why this one |
| --- | --- | --- | --- | --- |
| `dracula.json` | `dracula-theme.theme-dracula` | 2.25.1 | MIT | Translucent `#RRGGBBAA` workbench colours, including `list.hoverBackground` |
| `tokyo-night.json` | `enkia.tokyo-night` | 1.1.2 | MIT | Line comments — does not parse as strict JSON |
| `nord.json` | `arcticicestudio.nord-visual-studio-code` | 0.19.0 | MIT | Block comments — does not parse as strict JSON |
| `github-light-default.json` | `GitHub.github-vscode-theme` | 6.3.5 | MIT | A light variant, 43 translucent colours, and **no `type` field** |
| `one-dark-pro.json` | `zhuangtongfa.material-theme` | 3.20.2 | MIT | 275 token rules; omits `button.foreground` and `button.hoverBackground` |

## Why real files rather than hand-written ones

Every failure mode the importer has to survive was found by reading actual
themes, not by imagining them. A synthetic fixture would parse as strict JSON,
would state every key the mapping asks for, and would carry no alpha — so it
would exercise none of the four behaviours above, and the importer would have
shipped broken against precisely the themes people import.

The flip side is that these are snapshots: they are not updated when upstream
publishes a new version, because their value is what they contained on the day
they were captured. If a fixture is ever refreshed, re-check that it still
covers the column that put it here — `vscodeTheme.test.ts` asserts the JSONC
ones genuinely fail `JSON.parse`, so that one at least fails loudly.
