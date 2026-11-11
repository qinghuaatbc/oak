#!/usr/bin/env bash
# Installs Oak on a fresh Debian/Ubuntu-family Linux machine: Node.js (if
# missing), the repo, npm deps, a default config, and a systemd service that
# starts on boot and restarts on crash. Safe to re-run - each step is
# skipped if already done, so this also works as an update script (git pull
# + npm install + restart) for an existing install.
#
# Usage:
#   ./scripts/install.sh [port]
# Or, if you don't have the repo yet:
#   curl -fsSL https://raw.githubusercontent.com/qinghuaatbc/oak/main/scripts/install.sh | bash -s -- [port]
set -euo pipefail

PORT="${1:-8702}"
REPO_URL="https://github.com/qinghuaatbc/oak.git"
INSTALL_DIR="$HOME/oak-app/oak"

if [ "$EUID" -eq 0 ]; then
  echo "Don't run this as root - it uses sudo only for the two steps that need it (apt, systemd)." >&2
  exit 1
fi

# This installer targets a systemd-based Linux machine specifically (the
# Node.js setup step uses apt, and the service step writes a systemd unit
# file) - checked explicitly and early, with a clear message, rather than
# letting an unsupported OS run halfway through and fail confusingly on
# `tee: /etc/systemd/system/oak.service: No such file or directory` (the
# exact failure this had before this check existed, on a real run on
# macOS - no apt, no systemd, no /etc/systemd/system directory at all).
if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer is for a systemd-based Linux machine (Debian/Ubuntu-family) - it uses apt for Node.js and writes a systemd unit file for the background service." >&2
  echo "On macOS (or any other OS), install manually instead:" >&2
  echo "  git clone $REPO_URL" >&2
  echo "  cd oak && npm install && cp orchestrator/config.example.json orchestrator/config.json" >&2
  echo "  node orchestrator/server.js" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
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

# The admin login (username + password, the password kept only as a hash -
# see scripts/set-login.js). Asked for once, on a first install; an update
# re-run keeps the one already set. It's read from the terminal (/dev/tty),
# not stdin, so it still works when this script itself arrives on stdin
# (`curl ... | bash`). With no terminal at all (automation), set
# OAK_ADMIN_USER and OAK_ADMIN_PASSWORD instead.
if [ -f orchestrator/admin.json ]; then
  # An update: the logins stay unless asked otherwise (as oak-rs's installer).
  if ( exec < /dev/tty ) 2>/dev/null; then
    names="$(node scripts/set-login.js --list | paste -sd, - | sed 's/,/, /g')"
    printf "==> Logins already set up: %s. Keep them? [Y/n]: " "$names"
    read -r keep < /dev/tty || keep=""
    case "$keep" in
      [nN]*)
        echo "    A username already there gets the new password; a new one is added."
        node scripts/set-login.js < /dev/tty
        ;;
      *) echo "==> Keeping them. To change them later: node scripts/set-login.js" ;;
    esac
  else
    echo "==> Login already set up (orchestrator/admin.json), keeping it. To change it: node scripts/set-login.js"
  fi
elif [ -n "${OAK_ADMIN_PASSWORD:-}" ]; then
  echo "==> Setting the admin login from OAK_ADMIN_USER / OAK_ADMIN_PASSWORD..."
  node scripts/set-login.js --user "${OAK_ADMIN_USER:-admin}" --password "$OAK_ADMIN_PASSWORD"
elif ( exec < /dev/tty ) 2>/dev/null; then
  echo "==> Set up the admin login (you'll sign in to Oak with these):"
  node scripts/set-login.js < /dev/tty
else
  echo "==> No terminal to ask for a login on - run 'node scripts/set-login.js' in $INSTALL_DIR before signing in." >&2
fi

echo "==> Writing systemd service (port $PORT)..."
sudo tee /etc/systemd/system/oak.service > /dev/null << EOF
[Unit]
Description=Oak - independently-designed device-driver orchestrator
After=network.target

[Service]
Environment=PORT=$PORT
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) orchestrator/server.js
Restart=on-failure
RestartSec=3
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now oak.service
sudo systemctl restart oak.service

echo "==> Done. Status:"
systemctl status oak.service --no-pager -l | head -8
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Admin panel: http://${IP:-<this-machine-ip>}:$PORT/admin.html"
echo "Live view:   http://${IP:-<this-machine-ip>}:$PORT/live.html"
echo "Sign in with the username and password set above (change them: node $INSTALL_DIR/scripts/set-login.js)."
