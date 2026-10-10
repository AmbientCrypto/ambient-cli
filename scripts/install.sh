#!/usr/bin/env bash
#
# install.sh — install the Ambient CLI from a source checkout.
# For anyone who wants to run from source. To just install the CLI, prefer `npm i -g ambient-code`.
#
# Usage (from anywhere):   curl … | bash   is intentionally NOT supported — clone first, then run this.
#   git clone https://github.com/AmbientCrypto/ambient-cli && cd ambient-cli && ./scripts/install.sh
#
# It builds the workspace and drops an `ambient` (+ `amb`) launcher onto your PATH that points AT this clone,
# so `git pull && ./scripts/install.sh` updates dependencies and rebuilds it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

command -v node >/dev/null || { echo "Node 22+ is required — install it first."; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Ambient requires Node 22+; upgrade Node before installing."); process.exit(1); }'
NODE_BIN="$(command -v node)"
# Homebrew's opt path survives upgrades; versioned Cellar paths do not.
if [[ "$NODE_BIN" == */Cellar/*/bin/node ]]; then
  brew_prefix="$(brew --prefix)"
  if [ -x "$brew_prefix/opt/node/bin/node" ]; then NODE_BIN="$brew_prefix/opt/node/bin/node"; fi
fi
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
PNPM_VERSION="$(node -e 'process.stdout.write(require("./package.json").packageManager.split("@")[1])')"
if command -v pnpm >/dev/null && [ "$(pnpm --version)" = "$PNPM_VERSION" ]; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes "pnpm@$PNPM_VERSION")
fi

echo "▸ installing dependencies + building…"
"${PNPM[@]}" install --frozen-lockfile
"${PNPM[@]}" -r build
"$NODE_BIN" "$REPO/packages/cli/dist/amb.js" --version
"$NODE_BIN" "$REPO/packages/cli/dist/amb.js" doctor --offline

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
launcher_stage="$(mktemp -d "$BIN_DIR/.ambient-install.XXXXXX")"
trap 'rm -rf "$launcher_stage"' EXIT
# Bash's %q protects clone/runtime paths containing spaces, quotes or shell metacharacters.
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$NODE_BIN" "$REPO/packages/cli/dist/amb.js" > "$launcher_stage/ambient"
chmod +x "$launcher_stage/ambient"
mv "$launcher_stage/ambient" "$BIN_DIR/ambient"
ln -sf "$BIN_DIR/ambient" "$BIN_DIR/amb"

echo "✓ installed  →  $BIN_DIR/ambient  (and amb)"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "  ⚠ add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo
echo "  Next:"
echo "      ambient login      # paste your key from https://app.ambient.xyz/keys"
echo "      ambient            # launch the TUI"
