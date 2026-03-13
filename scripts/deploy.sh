#!/usr/bin/env bash
#
# Deploy script for Gringo bot on Vultr VPS (Ubuntu 22.04/24.04)
#
# Usage:
#   First time:  ssh root@YOUR_VPS_IP 'bash -s' < scripts/deploy.sh
#   Updates:     ssh root@YOUR_VPS_IP 'bash -s' < scripts/deploy.sh
#
# Prerequisites on your local machine:
#   - Your VPS IP address
#   - SSH access to root (or a sudo user)
#
set -euo pipefail

APP_DIR="/opt/gringo"
REPO_URL="https://github.com/jsong302/Project-Gringo.git"
BRANCH="main"
NODE_VERSION="20"

echo "=== Gringo Deploy ==="

# ── 1. System packages ─────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "→ Installing Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
else
  echo "→ Node.js $(node -v) already installed"
fi

if ! command -v pm2 &>/dev/null; then
  echo "→ Installing pm2..."
  npm install -g pm2
  pm2 startup systemd -u root --hp /root
else
  echo "→ pm2 already installed"
fi

# ── 2. Clone or pull ───────────────────────────────────────

if [ ! -d "$APP_DIR/.git" ]; then
  echo "→ Cloning repo..."
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
  git checkout "$BRANCH"
else
  echo "→ Pulling latest..."
  cd "$APP_DIR"
  git fetch origin
  git reset --hard "origin/$BRANCH"
fi

# ── 3. Create directories ─────────────────────────────────

mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/logs"

# ── 4. Check .env ─────────────────────────────────────────

if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "⚠️  No .env file found!"
  echo "   Copy the example and fill in your secrets:"
  echo ""
  echo "   cp $APP_DIR/.env.example $APP_DIR/.env"
  echo "   nano $APP_DIR/.env"
  echo ""
  echo "   Then re-run this script."
  exit 1
fi

# ── 5. Install deps & build ───────────────────────────────

echo "→ Installing dependencies..."
cd "$APP_DIR"
npm ci --production=false

echo "→ Building TypeScript..."
npm run build

# ── 6. Start/restart with pm2 ─────────────────────────────

if pm2 describe gringo &>/dev/null; then
  echo "→ Restarting gringo..."
  pm2 restart ecosystem.config.cjs
else
  echo "→ Starting gringo..."
  pm2 start ecosystem.config.cjs
fi

pm2 save

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Useful commands:"
echo "  pm2 status          — see running processes"
echo "  pm2 logs gringo     — tail live logs"
echo "  pm2 restart gringo  — restart the bot"
echo "  pm2 stop gringo     — stop the bot"
echo ""
