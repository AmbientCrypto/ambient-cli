#!/usr/bin/env bash
#
# publish-npm.sh — publish the Ambient CLI to npm so anyone can `npm i -g ambient-code`.
#
# Prerequisites (one-time): `npm login` as the account that owns the package name.
# The published package is the self-contained bundle (dist/amb.js) + react/ink/undici — nothing else.
#
#   NPM_NAME=ambient-code ./scripts/publish-npm.sh          # publish
#   ./scripts/publish-npm.sh --dry-run                      # stage + `npm publish --dry-run` (no upload)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
DRY="${1:-}"

echo "▸ building the bundle…"
pnpm -r build >/dev/null

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/dist"
cp packages/cli/dist/amb.js "$stage/dist/amb.js"
for f in README.md LICENSE NOTICE; do [ -f "$f" ] && cp "$f" "$stage/$f"; done
node scripts/npm-package-json.mjs > "$stage/package.json"

NAME="$(node -e 'process.stdout.write(require(process.argv[1]).name)' "$stage/package.json")"
VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$stage/package.json")"
echo "▸ publishing ${NAME}@${VERSION}…"

if [ "$DRY" = "--dry-run" ]; then
  ( cd "$stage" && npm publish --access public --dry-run )
  echo "✓ dry run only — nothing was uploaded."
else
  ( cd "$stage" && npm publish --access public )
  echo "✓ published  →  npm i -g ${NAME}"
fi
