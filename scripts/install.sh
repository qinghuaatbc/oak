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
