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
#   - copies AVR_OPENAI_KEY (and AVR_OPENAI_MODEL, if set) from the repo's .env
#     into /etc/comic.env, root-only, for the OpenAI writer and enhancer. The
#     key travels on the SSH session's stdin, never on a command line.
#
# Scripts and enhanced drawing prompts come from OpenAI (comic/openai.js); the
# local writer (Qwen2.5-14B-Instruct) is still there as --writer local. The
# renderer (Animagine XL 4.0 + the lustyx LoRA) and the local writer run from
# the GIF service's virtualenv and Hugging Face cache, and never touch either.
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
cp "$here"/{strips.js,panels.js,make.js,new.js,openai.js,service.js} "$tmp/comic/"

# A missing name is an empty value, not a failure: AVR_OPENAI_MODEL is
# optional, and under pipefail a grep that finds nothing ends the script.
envval() { { grep -E "^$1=" "$here/../.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']\$//g"; }
OPENAI_KEY=$(envval AVR_OPENAI_KEY)
OPENAI_MODEL=$(envval AVR_OPENAI_MODEL)
[ -n "$OPENAI_KEY" ] || echo "warning: no AVR_OPENAI_KEY in .env; the OpenAI writer and enhancer will fail on the box"
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

if [ -n "$OPENAI_KEY" ]; then
  sudo install -m 600 -o root -g root /dev/null /etc/comic.env
  sudo tee /etc/comic.env >/dev/null <<ENV
AVR_OPENAI_KEY=$OPENAI_KEY
${OPENAI_MODEL:+AVR_OPENAI_MODEL=$OPENAI_MODEL}
ENV
fi

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
EnvironmentFile=-/etc/comic.env
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
