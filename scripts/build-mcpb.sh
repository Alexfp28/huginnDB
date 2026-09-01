#!/usr/bin/env bash
# Package the `huginndb-mcp` sidecar as an MCP Bundle (`.mcpb`) — a zip that
# Claude Desktop and other MCPB-aware clients install in one click, instead of
# the user pasting an absolute path into a JSON config file.
#
# Run from the repo root, after the sidecar for this platform has been built:
#
#   scripts/build-mcpb.sh <path-to-huginndb-mcp[.exe]> <platform>
#
# where <platform> is the MCPB platform name (`win32`, `linux`, `darwin`) and
# is used only to name the output file — one bundle per platform, because the
# payload is a precompiled binary. The result lands in `mcpb/build/`.
#
# The bundle carries the *real* sidecar, not a launcher: it still reads the
# desktop app's `profiles.json` and the OS keychain, so HuginnDB must be
# installed, but nothing has to resolve where its copy of the binary ended up.
# Which connections are reachable is picked in the app (Settings -> MCP) and
# re-read per call, which is why this bundle needs no `user_config` at all.
set -euo pipefail

BINARY="${1:?usage: build-mcpb.sh <binary> <platform>}"
PLATFORM="${2:?usage: build-mcpb.sh <binary> <platform>}"

[ -f "$BINARY" ] || { echo "no sidecar at $BINARY" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/mcpb/build/stage"
OUT_DIR="$ROOT/mcpb/build"

# The version is read from package.json rather than kept in the manifest, so
# this is not a fifth place to remember on a release bump (RELEASING.md lists
# the four that are hand-edited). The committed manifest's own `version` is a
# placeholder that this always overwrites.
VERSION="$(node -p "require('$ROOT/package.json').version")"

rm -rf "$STAGE"
mkdir -p "$STAGE/server"

# `.exe` matters: MCPB appends it on Windows itself, but the file inside the
# bundle has to be named for the platform it will run on.
case "$PLATFORM" in
  win32) cp "$BINARY" "$STAGE/server/huginndb-mcp.exe" ;;
  *)     cp "$BINARY" "$STAGE/server/huginndb-mcp" ;;
esac

cp "$ROOT/src-tauri/icons/128x128.png" "$STAGE/icon.png"
cp "$ROOT/mcpb/README.md" "$STAGE/README.md"

node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$ROOT/mcpb/manifest.json', 'utf8'));
  m.version = '$VERSION';
  m.compatibility = { ...m.compatibility, platforms: ['$PLATFORM'] };
  fs.writeFileSync('$STAGE/manifest.json', JSON.stringify(m, null, 2) + '\n');
"

mkdir -p "$OUT_DIR"
BUNDLE="$OUT_DIR/huginndb-mcp-$VERSION-$PLATFORM.mcpb"
rm -f "$BUNDLE"

# Zipped with Python rather than `zip` (absent on the Windows runner) or `7z`
# (absent on some Linux images), and with explicit permissions: a zip entry
# carries its own mode, and the default loses the executable bit — which
# Windows does not care about and Linux/macOS very much do. Same trap as the
# release workflow's sidecar `cp`, one layer out.
python3 - "$STAGE" "$BUNDLE" <<'PY'
import os, stat, sys, zipfile

stage, bundle = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(stage):
        for name in sorted(files):
            full = os.path.join(root, name)
            arc = os.path.relpath(full, stage).replace(os.sep, "/")
            info = zipfile.ZipInfo(arc)
            info.compress_type = zipfile.ZIP_DEFLATED
            executable = arc.startswith("server/")
            mode = 0o755 if executable else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            with open(full, "rb") as fh:
                z.writestr(info, fh.read())
print(f"wrote {bundle}")
PY

rm -rf "$STAGE"
