# Screenshots

Drop the following files in this directory and the main `README.md` picks
them up automatically — no other change needed.

| Filename            | What to capture                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `overview.png`       | Main window: schema tree + data grid + an open SQL tab, dark theme, a real (non-trivial) table.      |
| `cell-editor.png`    | A cell expanded into the fullscreen Monaco editor — a JSON or XML column shows off syntax highlighting best. |
| `sql-workspace.png`  | The SQL editor mid-query, with the autocomplete dropdown or a "▶ Run" CodeLens visible.               |
| `mcp-settings.png`   | Settings → MCP, with at least one connection exposed and a generated client config snippet showing.  |

Guidance:

- **Resolution**: capture at native/Retina resolution and let GitHub's `width="860"` / `width="100%"` in the `<img>` tags scale it down — don't pre-downscale.
- **Format**: PNG. Avoid JPEG artifacts on text-heavy UI.
- **Theme**: the default dark theme (HuginnDB Dark) reads best against GitHub's light and dark README backgrounds alike.
- **Content**: use the [Chinook sample database](../../README.md#connecting-to-a-sample-database) or similarly realistic data — empty tables or "foo"/"bar" placeholder rows undersell the product.
- Crop out any OS chrome (title bar, taskbar) that isn't relevant; keep the app window itself as large in frame as possible.
