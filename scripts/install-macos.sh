#!/usr/bin/env bash
# Installs Oak on macOS: Node.js (via Homebrew, if missing), the repo, npm
# deps, a default config, and a launchd LaunchAgent that starts Oak on
# login and restarts it if it crashes - macOS's equivalent of
# install.sh's systemd service, since macOS has no systemd at all. A
# LaunchAgent (not a LaunchDaemon) deliberately, so this never needs
# sudo - it starts when THIS user logs in, not before login/at boot,
# which is the right tradeoff for a personal Mac rather than a headless
# server (matching install.sh's own "don't run this as root" stance).
#
# Usage:
#   ./scripts/install-macos.sh [port]
# Or, if you don't have the repo yet:
#   curl -fsSL https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/install-macos.sh | bash -s -- [port]
set -euo pipefail

PORT="${1:-8702}"
REPO_URL="https://github.com/qinghuaatbc/oak.git"
INSTALL_DIR="$HOME/oak-app/oak"
PLIST_LABEL="com.oak.orchestrator"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS specifically - use scripts/install.sh on Linux instead." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "==> Node.js not found."
  if command -v brew >/dev/null 2>&1; then
    echo "==> Installing Node.js via Homebrew..."
    brew install node
  else
    # Deliberately NOT installing Homebrew for the user - that's its own
    # separate trust decision (it runs a remote script with broad system
    # access) this installer shouldn't make on someone's behalf.
    echo "Homebrew isn't installed, and this script won't install it for you." >&2
    echo "Install Node.js yourself first - either from https://nodejs.org, or install Homebrew (https://brew.sh) then run 'brew install node' - then re-run this script." >&2
    exit 1
  fi
else
  echo "==> Node.js already installed ($(node -v)), skipping."
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Oak already cloned at $INSTALL_DIR, pulling latest..."
  git -C "$INSTALL_DIR" pull
else
  echo "==> Cloning Oak into $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "==> Installing npm dependencies..."
npm install

if [ ! -f orchestrator/config.json ]; then
  echo "==> Creating default config.json (empty - add driver instances from the admin UI)..."
  cp orchestrator/config.example.json orchestrator/config.json
else
  echo "==> orchestrator/config.json already exists, leaving it alone."
fi

echo "==> Writing launchd agent (port $PORT)..."
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(command -v node)</string>
        <string>$INSTALL_DIR/orchestrator/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$PORT</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/oak.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/oak.log</string>
</dict>
</plist>
EOF

# bootout/bootstrap, not the legacy load/unload - modern launchctl (macOS
# 26.5, confirmed against this real machine's own `launchctl help`)
# explicitly recommends these instead. bootout errors if the label isn't
# currently loaded at all (e.g. a genuinely first-time install) - that
# failure is expected and safe to ignore, same idempotent-rerun spirit as
# install.sh's own "safe to re-run" design.
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo "==> Done."
sleep 1
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<this-machine-ip>")"
echo
echo "Admin panel: http://${IP}:$PORT/admin.html"
echo "Live view:   http://${IP}:$PORT/live.html"
echo "Logs:        tail -f $INSTALL_DIR/oak.log"
echo "Stop:        launchctl bootout gui/\$(id -u) $PLIST_PATH"
echo "Start again: launchctl bootstrap gui/\$(id -u) $PLIST_PATH"
