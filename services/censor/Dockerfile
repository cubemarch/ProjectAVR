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

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# The model is baked in rather than fetched at boot. Cloud Run scales to zero,
# so a cold start that has to pull 10MB from the internet before it can answer
# is a cold start that sometimes does not - and the fallback for "no model" is
# to mosaic the entire frame, which would make a slow start look like a
# site-wide outage of the artwork.
#
# VERIFY THIS URL AND CHECKSUM AGAINST THE PROJECT'S OWN RELEASES BEFORE THE
# FIRST PRODUCTION BUILD. The class order in src/labels.js is a transcription
# of one specific model's training order; a different file silently breaks it
# in the one direction that matters. See `npm run verify`.
ARG MODEL_URL=https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/320n.onnx
ARG MODEL_SHA256=

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && mkdir -p /app/model \
    && curl -fsSL "$MODEL_URL" -o /app/model/320n.onnx \
    && if [ -n "$MODEL_SHA256" ]; then \
    echo "$MODEL_SHA256  /app/model/320n.onnx" | sha256sum -c -; \
    else echo "WARNING: built without MODEL_SHA256"; fi \
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
