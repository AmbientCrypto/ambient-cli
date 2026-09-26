#!/usr/bin/env bash
#
# pack.sh — build a self-contained tarball of the Ambient CLI.
#
# The tsup bundle (packages/cli/dist/amb.js) already inlines every @amb/* workspace package + zod, so the
# packaged module declares only its real runtime externals (react + ink + undici — all pure JS, no native
# build). Install the resulting tarball anywhere with:
#     npm i -g ./ambient-code-<version>.tgz     # no repo access, no pnpm, no compiler
#
# To publish to npm instead of packing a tarball, use scripts/publish-npm.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "▸ building the bundle…"
pnpm -r build >/dev/null

VERSION="$(node --input-type=commonjs -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("packages/cli/package.json","utf8")).version)')"
NAME="${NPM_NAME:-ambient-code}"

# Stage a clean package in a scratch dir that is ALWAYS removed (even on failure).
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/dist"
cp packages/cli/dist/amb.js "$stage/dist/amb.js"
for f in README.md LICENSE NOTICE; do [ -f "$f" ] && cp "$f" "$stage/$f"; done
node scripts/npm-package-json.mjs > "$stage/package.json"

mkdir -p "$REPO/dist-pack"
( cd "$stage" && npm pack --silent --pack-destination "$REPO/dist-pack" >/dev/null )

TGZ="$REPO/dist-pack/${NAME}-${VERSION}.tgz"
# A version-free copy too: attached to every GitHub release so
# https://github.com/AmbientCrypto/ambient-cli/releases/latest/download/ambient-code.tgz always installs the latest.
cp "$TGZ" "$REPO/dist-pack/${NAME}.tgz"
echo "✓ packed  →  $TGZ  (+ ${NAME}.tgz)"
echo
echo "  Install it:"
echo "      npm i -g \"$TGZ\""
echo "      ambient login      # paste your key from https://app.ambient.xyz/keys"
echo "      ambient            # launch the TUI"
