#!/usr/bin/env bash
# Put the comic generator on the GPU box as a service, the way the GIF
# generator lives there. Safe to run again: it is also how an update ships.
#
#   bash comic/deploy.sh
#
# What it does, on cubemarch-hyworld:
#   - copies the comic code (scripts, prompts, lettering, renderer, writer) to
#     /opt/comic/app; drafts already there are kept
#   - installs Node from the official release tarball into /opt, once, rather
#     than running a remote setup script as root
#   - installs Playwright's Chromium for lettering, and URW and DejaVu fonts so
#     pages lettered on the box match pages lettered on a Mac
#   - runs comic/service.js as the `comic` systemd unit on port 8011
#   - opens 8011 to David's addresses only, like allow-animatediff-ui does 8010
#
# The service runs the writer (Qwen2.5-14B-Instruct) and the renderer
# (Animagine XL 4.0 + the lustyx LoRA) from the GIF service's virtualenv and
# Hugging Face cache, and never touches either.
set -euo pipefail

VM=cubemarch-hyworld
ZONE=us-central1-b
NODE=v22.11.0
PORT=8011
# This Mac's address on 2026-11-14, and the one allow-animatediff-ui admits.
SOURCES=76.109.0.174/32,72.251.220.33/32

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/comic/server"
cp "$here"/{strips.js,panels.js,make.js,new.js,service.js} "$tmp/comic/"
cp "$here"/server/{render.py,write.py} "$tmp/comic/server/"
cat > "$tmp/package.json" <<'JSON'
{ "name": "lustyx-comic", "private": true, "type": "module", "dependencies": { "playwright": "1.62.1" } }
JSON
tar czf "$tmp/app.tgz" -C "$tmp" comic package.json

if [ "$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(status)')" != RUNNING ]; then
  echo "==> starting $VM"
  gcloud compute instances start "$VM" --zone "$ZONE" --quiet
fi

echo "==> copying the app"
gcloud compute scp --zone "$ZONE" --quiet "$tmp/app.tgz" "$VM:/tmp/comic-app.tgz"

echo "==> installing on the box"
gcloud compute ssh "$VM" --zone "$ZONE" --quiet --command "bash -s" <<REMOTE
set -euo pipefail
sudo mkdir -p /opt/comic/app
sudo tar xzf /tmp/comic-app.tgz -C /opt/comic/app

if [ ! -x /opt/node/bin/node ]; then
  curl -fsSL https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz | sudo tar -xJ -C /opt
  sudo ln -sfn /opt/node-$NODE-linux-x64 /opt/node
fi
export PATH=/opt/node/bin:\$PATH
export PLAYWRIGHT_BROWSERS_PATH=/opt/comic/ms-playwright

cd /opt/comic/app
sudo env PATH=\$PATH npm install --omit=dev --no-audit --no-fund --loglevel=error
sudo env PATH=\$PATH PLAYWRIGHT_BROWSERS_PATH=\$PLAYWRIGHT_BROWSERS_PATH npx playwright install --with-deps chromium >/dev/null
sudo apt-get install -y -q fonts-urw-base35 fonts-dejavu-core >/dev/null

sudo tee /etc/systemd/system/comic.service >/dev/null <<UNIT
[Unit]
Description=Lusty X comic generator (port $PORT)
After=network-online.target

[Service]
WorkingDirectory=/opt/comic/app
Environment=COMIC_ON_BOX=1
Environment=COMIC_PORT=$PORT
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/comic/ms-playwright
ExecStart=/opt/node/bin/node comic/service.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable comic >/dev/null 2>&1
sudo systemctl restart comic
sleep 2
systemctl is-active comic
REMOTE

if ! gcloud compute firewall-rules describe allow-comic-ui >/dev/null 2>&1; then
  echo "==> opening port $PORT to $SOURCES"
  gcloud compute firewall-rules create allow-comic-ui --network default --allow "tcp:$PORT" \
    --source-ranges "$SOURCES" --target-tags hyworld-worker --quiet >/dev/null
fi

ip=$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
echo "==> http://$ip:$PORT/"
