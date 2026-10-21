# A single stateless container: image in, censored image out.
#
# Nothing in here is specific to Google Cloud. It is built for Cloud Run
# because that is where it runs today, but Cloud Run's only requirements are
# "listen on $PORT" and "be a container", both of which App Runner and ECS
# Fargate also want. The move to AWS is a registry push and a URL change, not
# a rewrite - which is the reason the model and the image stack live in here
# rather than on the application server.

FROM node:22-slim

# `sharp` ships prebuilt binaries for this platform; `onnxruntime-node` does
# too. Neither needs a toolchain, so there is no build stage and nothing to
# discard - a multi-stage build here would add a layer and save nothing.
WORKDIR /app

# The lockfile is copied and `ci` is used rather than `install`, so the image
# is built from the exact tree that was tested. This container is handed
# arbitrary bytes from a partner CDN and decodes them with native code; a
# transitive dependency drifting between a test run and a production build is
# not a reproducibility nicety here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The model is baked in rather than fetched at boot. Cloud Run scales to zero,
# so a cold start that has to pull 10MB from the internet before it can answer
# is a cold start that sometimes does not - and the fallback for "no model" is
# to mosaic the entire frame, which would make a slow start look like a
# site-wide outage of the artwork.
#
# Both verified 2026-10-20 against the release list from the GitHub API:
# 320n.onnx, 12,150,158 bytes, tag v3.4-weights. The running model was checked
# the same day - it emits [1, 22, 2100], which is 4 box channels plus the
# eighteen classes in src/labels.js, and that list was diffed position by
# position against nudenet/nudenet.py upstream. See docs/CENSOR.md.
#
# The checksum is not decoration. The class order in src/labels.js is a
# transcription of one specific model's training order, and the file carries
# no metadata to check it against - the export stripped it. A different file
# with the same name still loads, still returns boxes, and covers the wrong
# thing. If this hash stops matching, do not bypass it: re-run `npm run
# verify` against the new weights before changing the number.
#
# ## Why the API asset URL and not the readable one
#
# The obvious address is
# `github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/320n.onnx`,
# and it is what this used until 2026-10-20. It stopped working: GitHub now
# answers it with `302 -> /login`, and the login page is served as `200
# text/html`, so `curl -fsSL` reports success and writes 49KB of HTML into
# a file named `320n.onnx`. The release is public and unchanged - the same
# bytes, 12,150,158 of them, come back from the API endpoint below.
#
# That is the checksum earning its place, and it is worth saying plainly
# because the temptation on a red build is to assume the model moved. It did
# not. Without `sha256sum -c` this would have produced a container that
# started, served, failed to parse its model, and mosaiced every frame -
# which the service treats as a successful cover and reports as healthy.
#
# The numeric asset id is pinned rather than looked up, so this build does
# not depend on a second API call going well either. To move to new weights:
# GET /repos/notAI-tech/NudeNet/releases/tags/<tag>, take `assets[].id`, and
# re-run `npm run verify` against the file before changing the hash.
ARG MODEL_URL=https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/176831997
ARG MODEL_SHA256=c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && mkdir -p /app/model \
    && curl -fsSL --retry 3 --retry-delay 2 \
    -H "Accept: application/octet-stream" \
    "$MODEL_URL" -o /app/model/320n.onnx \
    && if [ -z "$MODEL_SHA256" ]; then \
    echo "refusing to build without MODEL_SHA256 - verify the weights first" >&2; exit 1; fi \
    && echo "$MODEL_SHA256  /app/model/320n.onnx" | sha256sum -c - \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY scripts ./scripts

# Cloud Run sets PORT; this is the local default and matches its convention.
ENV PORT=8080
ENV CENSOR_MODEL=/app/model/320n.onnx
ENV NODE_ENV=production

USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
