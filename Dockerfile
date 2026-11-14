# ProjectAVR - app tier and live transcode tier in one image.
#
# This exists so that the thing running on AWS is the thing that was tested on a
# Mac. The transcode tier is the reason it matters: FFmpeg's behaviour varies
# enough between builds that "it worked locally" is not evidence about a
# container, and the point of moving encoding off the phone is to run it
# somewhere with predictable capacity.
#
#   docker build -t projectavr .
#   docker run --rm -p 8080:8080 -p 8081:8081 \
#     -e AVR_LIVE_KEY=$(openssl rand -hex 8) \
#     -e AVR_JWT_SECRET=$(openssl rand -hex 32) \
#     -v projectavr-data:/data \
#     --tmpfs /tmp/avr-live-hls \
#     projectavr
#
# Ports: 8080 is HTTP (viewers, HLS, the relay's WebSocket upgrade), 8081 is TCP
# ingest from the phone. UDP 8082 discovery is deliberately not exposed - it is
# a LAN convenience, and on AWS the phone is given an address rather than
# shouting for one. The beacon still binds inside the container and simply never
# hears a probe.

# ---------------------------------------------------------------- build --
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# -------------------------------------------------------------- runtime --
FROM node:22-bookworm-slim

# ffmpeg is the transcode tier's entire runtime dependency. Debian's build has
# libx264 and libx265 and no hardware encoder, which is correct here -
# AVR_TRANSCODE_HWACCEL names a VideoToolbox encoder that only exists on macOS
# and must stay off in a container.
#
# tini reaps the FFmpeg children. Node is PID 1 otherwise, and a restarting
# transcode would leave zombies that accumulate over the life of the task.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY public ./public

# `brand.js` is the single constant the product name is drawn from, and
# `server/index.js` imports it at module load - without it the container exits
# before it listens. `art/` holds the mark that gets burned into every
# rendition; a missing file there packages the title unmarked instead of
# failing, so leaving it out is a defect that ships silently.
COPY brand.js ./
COPY art ./art

# The comic's scripts and art. `server/comic.js` imports `comic/strips.js` at
# module load, so this is as fatal to leave out as `brand.js`.
COPY comic ./comic

# Persistent state: the SQLite catalog and the media library. Both default to
# ./data inside the image, which would vanish with the container, so they are
# moved to a single mount point.
ENV AVR_DB=/data/projectavr.db
ENV AVR_MEDIA_DIR=/data/media

# Generated performer biographies. Same reasoning, with a bill attached: left
# in the image this is re-bought from OpenAI on every deploy, because a rebuild
# is exactly when the cache would be discarded.
ENV AVR_STAR_BIO_CACHE=/data/star-bios.json

# HLS segments. Ephemeral by design - a running transcode rewrites this
# continuously and nothing in it is worth keeping for more than a few seconds,
# so mount a tmpfs over it rather than letting it churn the container's writable
# layer. On Fargate this wants to be the task's ephemeral storage.
ENV AVR_TRANSCODE_DIR=/tmp/avr-live-hls

ENV PORT=8080
ENV AVR_LIVE_PORT=8081

# `public/media` is the directory `buildLibrary()` scans, and is separate from
# the storage root above. It ships empty; bind-mount a library over it, or leave
# it and serve everything through the storage tier.
RUN mkdir -p /data/media /tmp/avr-live-hls /app/public/media \
    && chown -R node:node /data /tmp/avr-live-hls /app/public/media

USER node
EXPOSE 8080 8081
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]

# `start-period` is generous because the first health check builds the library.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
