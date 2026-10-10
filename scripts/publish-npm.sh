#!/usr/bin/env bash
#
# publish-npm.sh — publish the Ambient CLI to npm so anyone can `npm i -g ambient-code`.
#
# Prerequisites (one-time): `npm login` as the account that owns the package name.
# Publishes the verified bundle and its locked runtime dependencies.
#
#   NPM_NAME=ambient-code ./scripts/publish-npm.sh          # publish
#   ./scripts/publish-npm.sh --dry-run                      # verify + `npm publish --dry-run` (no upload)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
DRY="${1:-}"

NAME="${NPM_NAME:-ambient-code}"
VERSION="$(node -e 'process.stdout.write(require("./packages/cli/package.json").version)')"
TGZ="$REPO/dist-pack/${NAME}-${VERSION}.tgz"
[ -f "$TGZ" ] || { echo "Pack and verify the release first: bash scripts/pack.sh && node scripts/verify-install.mjs"; exit 1; }
node --input-type=module - "$TGZ" <<'JS'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const path = process.argv[2];
const verified = JSON.parse(readFileSync(path.replace(/\.tgz$/, '.verified.json'), 'utf8'));
if (verified.sha256 !== createHash('sha256').update(readFileSync(path)).digest('hex')) throw new Error('Tarball changed after verification; rerun scripts/verify-install.mjs');
JS
echo "▸ publishing ${NAME}@${VERSION}…"

if [ "$DRY" = "--dry-run" ]; then
  npm publish "$TGZ" --access public --dry-run
  echo "✓ dry run only — nothing was uploaded."
else
  npm publish "$TGZ" --access public
  echo "✓ published  →  npm i -g ${NAME}"
fi
