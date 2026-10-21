# Censor service

One image in, the same image with genitalia, breasts and anuses pixelated,
out. Stateless, one route, no storage, no database.

It is a **separate deployable on purpose**. The model and the image stack
(`onnxruntime-node`, `sharp`) are native modules, and putting them in the
application server means that server can no longer be built on a machine that
does not match production. Keeping them here means the only thing the site
knows about any of this is a URL.

It runs on **Google Cloud Run** today. It is built so that moving it to AWS is
a registry push and an environment change — see [Moving to AWS](#moving-to-aws).

## The contract

```
POST /scan
     X-Censor-Token: <shared secret>
     Content-Type: image/jpeg
     <image bytes, max 4MB>

200  image/jpeg                      the covered image
     X-Censor-Boxes: 2               how many regions were covered
     X-Censor-Whole: 0               1 if the whole frame was covered
     X-Censor-Ms: 41.3

401  unauthorized
400  empty body
502  unprocessable image             could not decode it at all
503  CENSOR_TOKEN is not set
```

```
GET /health   ->   { "ok": true, "model": "loaded" }
```

**There is no response that returns the original image.** That is the single
invariant the whole service is arranged around. A model that failed to load, a
detector that threw, an image it is unsure about — all of them produce a
mosaic, not a passthrough. The only thing a caller can get instead of a
covered image is an error, and the caller's own fallback for an error is a
placeholder.

## Configuration

| | | |
| --- | --- | --- |
| `PORT` | `8080` | Cloud Run sets this |
| `CENSOR_MODEL` | `/app/model/320n.onnx` | baked into the image |
| `CENSOR_TOKEN` | — | **required**; the service refuses every request without it |
| `CENSOR_SHAPE` | `ellipse` | or `rect` — see the geometry note in `src/mosaic.js` |

## Before the first production deploy

**Verify the class order.** `src/labels.js` is a transcription of one specific
model's training order, and the model file returns scores as bare positional
numbers. If the order is wrong the service still runs, still returns boxes,
still reports success — and covers faces while leaving genitals on screen.
There is no error path for it.

```sh
npm run verify -- ./sample.jpg FEMALE_BREAST_EXPOSED
```

Use a real frame off the feed this will actually serve. Run it once per model
file and record the result in the deploy log. With no expected labels it just
prints what the model found, which is the right first call.

**Pin the model.** The `Dockerfile` downloads from a URL with no checksum
unless you give it one. Build with `--build-arg MODEL_SHA256=...` so a silent
upstream change cannot alter what is covering what.

## Deploying to Cloud Run

Project `cubemarch-507617`. A CPU-only service — the two `g2`/`a2` GPU
instances in this project are for other work and are the wrong shape for this:
NudeNet at 320px is ~40ms on a CPU, the load is a few images a second, and a
GPU VM that has to stay up costs more per month than this will cost per year.

```sh
PROJECT=cubemarch-507617
REGION=us-central1

gcloud builds submit services/censor \
  --project "$PROJECT" \
  --tag "gcr.io/$PROJECT/lustxr-censor:latest"

gcloud run deploy lustxr-censor \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "gcr.io/$PROJECT/lustxr-censor:latest" \
  --cpu 2 --memory 2Gi \
  --concurrency 8 \
  --min-instances 0 \
  --max-instances 4 \
  --no-allow-unauthenticated \
  --set-env-vars "CENSOR_TOKEN=$(openssl rand -hex 32)"
```

`--min-instances 0` is deliberate: it scales to zero and costs nothing when
nobody is browsing signed-out. The cost is a cold start of a few seconds on
the first thumbnail, which the caller absorbs — `_swapFrame` in
`src/ui/cams.js` holds the previous frame until the new one decodes, so a slow
first image is invisible rather than broken. Raise it to 1 if signed-out
traffic is steady enough that cold starts stop being rare.

`--concurrency 8` because each request holds a decoded bitmap and an inference
buffer; higher packs more per instance and raises the tail latency that the
caller's 4s timeout is measured against.

### Isolation

This is a LustXR dependency running in a project shared with other work. That
is within the standing rule — the same billing account is fine as long as
external reviewers cannot tell — **because nothing about this is externally
observable**: it is called server-to-server from the application host, it is
deployed `--no-allow-unauthenticated`, and it has no public DNS name, no
certificate and no bucket of its own. Do not give it a custom domain, and do
not put it behind a hostname that resolves alongside anything else.

## Moving to AWS

Nothing in the container is Google-specific. It listens on `$PORT`, reads
config from the environment, writes logs to stdout and stores nothing.

1. `docker build -t lustxr-censor services/censor` and push to ECR.
2. Deploy as **App Runner** (closest equivalent — scales to zero, HTTPS
   endpoint, no cluster) or **ECS Fargate** behind an internal ALB.
3. Set `CENSOR_TOKEN` from Secrets Manager.
4. Change `AVR_CENSOR_ENDPOINT` on the application host. Nothing else.

Keep it in the same VPC as the application server and off the public internet
if you can; the shared-secret header is there because Cloud Run has no private
path from an EC2 box, and once both halves are inside AWS that stops being
true.

## Cost

At the measured shape of the cam row — about five visible tiles refreshing
every nine seconds, and a six-second shared cache in front of this — the work
is a few scans per second **in total across all viewers**, because the covered
image for a room is identical for everyone. Cloud Run bills per request and
per CPU-second; this lands in single-digit dollars a month at the traffic this
site has, and scales with the number of *rooms being looked at* rather than
the number of people looking.
