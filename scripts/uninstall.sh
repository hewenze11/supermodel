#!/usr/bin/env bash
# SuperModel uninstall script — removes SuperModel only, leaves Node.js/git/build tools untouched
# Usage: curl -fsSL https://raw.githubusercontent.com/hewenze11/supermodel/main/scripts/uninstall.sh | bash
# Or: bash uninstall.sh

set -euo pipefail

print_step() { echo -e "\n\033[1;34m==> $1\033[0m"; }
print_ok()   { echo -e "\033[1;32m✓ $1\033[0m"; }
warn()       { echo -e "\033[1;33m⚠  $1\033[0m"; }

INSTALL_DIR="$HOME/.supermodel"
BIN_DIR="$HOME/.local/bin"
BINARY="$BIN_DIR/supermodel"

echo ""
echo "  SuperModel Uninstaller"
echo "  This will remove SuperModel and all its data."
echo "  Node.js, git, and other system packages will NOT be touched."
echo ""

# Confirm
read -r -p "  Continue? [y/N] " confirm
case "$confirm" in
  [yY][eE][sS]|[yY]) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

print_step "Stopping running server (if any)"
if [ -f "$INSTALL_DIR/state.json" ]; then
  PID=$(node -e "try{const s=require('$INSTALL_DIR/state.json');if(s.pid)process.stdout.write(String(s.pid))}catch(e){}" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null && print_ok "Stopped server (PID $PID)" || true
    sleep 1
  fi
fi
# Also kill by pattern just in case
pkill -f "dist/index.js" 2>/dev/null && print_ok "Killed remaining node processes" || true

print_step "Removing SuperModel data directory (~/.supermodel)"
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  print_ok "Removed $INSTALL_DIR"
else
  warn "$INSTALL_DIR not found, skipping"
fi

print_step "Removing supermodel CLI binary"
if [ -f "$BINARY" ]; then
  rm -f "$BINARY"
  print_ok "Removed $BINARY"
else
  warn "$BINARY not found, skipping"
fi

print_step "Cleaning PATH entry from shell profiles"
for profile in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.profile"; do
  if [ -f "$profile" ] && grep -q ".local/bin" "$profile"; then
    # Only remove the line we added (supermodel-specific PATH addition)
    sed -i '/# Added by SuperModel installer/d' "$profile" 2>/dev/null || true
    sed -i '/export PATH.*\.local\/bin.*# supermodel/d' "$profile" 2>/dev/null || true
    print_ok "Cleaned $profile"
  fi
done

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║  SuperModel removed successfully.                ║"
echo "  ║                                                  ║"
echo "  ║  NOT removed (untouched):                        ║"
echo "  ║    Node.js, npm, git, build-essential            ║"
echo "  ║    ~/.local/bin (directory itself)               ║"
echo "  ║    Any other software you installed              ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
