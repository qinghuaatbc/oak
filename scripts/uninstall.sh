#!/usr/bin/env bash
# Removes Oak's service on macOS (the launchd agent com.oak.orchestrator) or
# Linux (the systemd service oak.service), as the installers set it up. The
# install folder ~/oak-app/oak stays - code, login (orchestrator/admin.json)
# and devices (orchestrator/config.json) - so installing again carries on
# where it left off; --purge deletes it too.
#
# Usage:
#   ./scripts/uninstall.sh [--purge]
# Or, without the repo at hand:
#   curl -fsSL https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/uninstall.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/uninstall.sh | bash -s -- --purge
#
# (The download version, oak-rs, is separate: `oak-server uninstall`.)
set -euo pipefail

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1
INSTALL_DIR="$HOME/oak-app/oak"

case "$(uname -s)" in
  Darwin)
    LABEL="com.oak.orchestrator"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    ;;
  Linux)
    if [ -f /etc/systemd/system/oak.service ]; then
      echo "==> Removing the systemd service (sudo asks for your password)..."
      sudo systemctl disable --now oak.service || true
      sudo rm -f /etc/systemd/system/oak.service
      sudo systemctl daemon-reload
    fi
    ;;
  *)
    echo "This is for macOS and Linux - on Windows use scripts/uninstall-windows.ps1." >&2
    exit 1
    ;;
esac
echo "==> Oak's service is removed."

if [ "$PURGE" = 1 ]; then
  rm -rf "$INSTALL_DIR"
  rmdir "$HOME/oak-app" 2>/dev/null || true
  echo "==> Removed $INSTALL_DIR (code, login, devices)."
elif [ -d "$INSTALL_DIR" ]; then
  echo "==> Kept $INSTALL_DIR - your login and devices are still there for a later install."
  echo "    To delete it too: run this again with --purge."
fi
echo "    (Node.js itself stays installed.)"
