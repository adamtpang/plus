#!/bin/sh
# Installer for plus, an unofficial CLI for Surplus Intelligence.
#
#   curl -fsSL https://raw.githubusercontent.com/adamtpang/plus/main/cli/install.sh | sh
#
# It downloads one JavaScript file and a small launcher into ~/.local/bin.
# Needs Node 18 or newer. The idea of a one-line installer is borrowed from
# OpenRouter's ori; this script is written from scratch.
#
# Install somewhere else:
#   PLUS_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/adamtpang/plus/main/cli/install.sh | sh

set -eu

NAME="plus"
BASE="${PLUS_BASE_URL:-https://raw.githubusercontent.com/adamtpang/plus/main/cli}"
DIR="${PLUS_INSTALL_DIR:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "$NAME needs Node 18 or newer, and node was not found. Get it at https://nodejs.org" >&2
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "$NAME needs Node 18 or newer; this machine has Node $MAJOR." >&2
  exit 1
fi

mkdir -p "$DIR"
curl -fsSL "$BASE/plus.mjs" -o "$DIR/$NAME.mjs"
curl -fsSL "$BASE/wallet.mjs" -o "$DIR/wallet.mjs"

# The launcher: a two-line script so the name works as a command.
printf '#!/bin/sh\nexec node "%s/%s.mjs" "$@"\n' "$DIR" "$NAME" > "$DIR/$NAME"
chmod +x "$DIR/$NAME"

echo "Installed $NAME to $DIR"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$DIR:\$PATH\"" ;;
esac
echo "Next:  $NAME login"
