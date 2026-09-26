#!/usr/bin/env bash
#
# install.sh — install the Ambient CLI from a source checkout.
# For anyone who wants to run from source. To just install the CLI, prefer `npm i -g ambient-code`.
#
# Usage (from anywhere):   curl … | bash   is intentionally NOT supported — clone first, then run this.
#   git clone https://github.com/AmbientCrypto/ambient-cli && cd ambient-cli && ./scripts/install.sh
#
# It builds the workspace and drops an `ambient` (+ `amb`) launcher onto your PATH that points AT this clone,
# so `git pull && pnpm -r build` keeps it up to date.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

command -v node >/dev/null || { echo "node ≥20.18 is required — install it first."; exit 1; }

echo "▸ installing dependencies + building…"
corepack enable >/dev/null 2>&1 || true
pnpm install
pnpm -r build

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/ambient" <<SH
#!/usr/bin/env bash
exec node "$REPO/packages/cli/dist/amb.js" "\$@"
SH
chmod +x "$BIN_DIR/ambient"
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
