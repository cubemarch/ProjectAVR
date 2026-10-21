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
GET /health   ->   { "ok": true, "model": "loaded", "bars": "34cd3b0fb3c5" }
```

`bars` is a fingerprint of the thresholds this container is running — the one
field that distinguishes one build from another, and the thing `verify-deploy`
checks before it checks anything else. Hashed rather than printed because
`/health` is the unauthenticated route; see `policyFingerprint` in
`src/detect.js`.

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

Project **`lustxr-censor`** (number 522448295028), in the `cubemarch.com`
organisation, region `us-central1`. A CPU-only service: NudeNet at 320px is
~40ms on a CPU, the load is a few images a second, and a GPU VM that has to
stay up costs more per month than this will cost per year.

**It has a project to itself, and that is load-bearing** — see
[Why a dedicated project](#why-a-dedicated-project). It lived in
`cubemarch-507617` for about five hours on 2026-10-20 and was moved; nothing
of it remains there.

### One-time setup

Two traps in here, both of which look like success.

Cloud Build in a project created after mid-2024 no longer gets the legacy
`PROJECT_NUMBER@cloudbuild.gserviceaccount.com` service account. Builds fall
back to the Compute Engine default account, which starts without the role it
needs — and `gcloud builds submit` **exits 0 on `PERMISSION_DENIED`**, so a
build that never ran looks like a build that succeeded. Check the log, not the
exit code.

And `gcloud artifacts repositories create` will offer to enable the API for
you, then fail the create against the API it just enabled, because the
permission has not propagated. That is a race, not a misconfiguration. Run it
again.

```sh
PROJECT=lustxr-censor
REGION=us-central1
ORG=1006423959781
BILLING=01213B-360DBB-7E34EE

gcloud projects create "$PROJECT" --name "LustXR censor" --organization "$ORG"
gcloud billing projects link "$PROJECT" --billing-account "$BILLING"

gcloud services enable \
  cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com \
  --project "$PROJECT"

NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$NUMBER-compute@developer.gserviceaccount.com" \
  --role roles/cloudbuild.builds.builder

gcloud artifacts repositories create censor \
  --project "$PROJECT" --location "$REGION" --repository-format docker

# Domain Restricted Sharing is inherited from the org and forbids `allUsers`
# in any IAM policy. Scoped to this project only - see below for why that is
# safe here and would not be safe anywhere else.
cat > /tmp/drs.yaml <<'YAML'
constraint: constraints/iam.allowedPolicyMemberDomains
listPolicy:
  allValues: ALLOW
YAML
gcloud resource-manager org-policies set-policy /tmp/drs.yaml --project "$PROJECT"
```

### First deploy only

Two of these flags belong to the first deploy and **must not** be repeated.

`--set-env-vars "CENSOR_TOKEN=..."` replaces the token the service checks. Run
it against a live service and every call from the app starts failing its auth,
because the app is still sending the old one. The token lives in `.env` and
`/srv/lustxr/app.env`; it is set here once and read from there afterwards.

`--allow-unauthenticated` writes an IAM policy that persists across revisions,
so a later deploy without it stays public. It is here once for the same reason.

```sh
PROJECT=lustxr-censor
REGION=us-central1
IMAGE="$REGION-docker.pkg.dev/$PROJECT/censor/censor:latest"

gcloud run deploy lustxr-censor \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --cpu 2 --memory 2Gi \
  --concurrency 8 \
  --min-instances 0 \
  --max-instances 4 \
  --allow-unauthenticated \
  --set-env-vars "CENSOR_TOKEN=$(openssl rand -hex 32)"
```

To open an *existing* service rather than one being created, the flag has an
equivalent that makes no new revision:

```sh
gcloud run services add-iam-policy-binding lustxr-censor \
  --project lustxr-censor --region us-central1 \
  --member allUsers --role roles/run.invoker
```

### Build and deploy

**Nothing below depends on where you are standing, and that is deliberate.**
`gcloud builds submit` resolves its source argument against the working
directory, so a documented `services/censor` fails with `could not find
source` for anyone who is already in `services/censor` — which is where you
are if you have just edited the thing you are deploying. That error is
survivable on its own. What is not survivable is that the deploy on the next
line was not conditional on it: the build fails, the deploy succeeds against
whatever `:latest` already pointed at, and the service quietly moves to an
older image while reporting success. That happened twice on 2026-10-21. So
the source path is derived from `git rev-parse` rather than written down, and
the two commands are joined with `&&`.

**There is one image.** `censor/censor`, in the `censor` repository, and
nothing else. For a while there was a second name, `censor/lustxr-censor`,
holding its own independent `:latest` — the repository name and the image name
both being free-form made two plausible paths, and the deploy above pushed to
one while this file documented the other. A stale tag that answers to a
sensible-looking path is worse than no tag at all. If a second name ever
appears again, delete it rather than documenting it.

```sh
PROJECT=lustxr-censor
REGION=us-central1
IMAGE="$REGION-docker.pkg.dev/$PROJECT/censor/censor:latest"
SRC="$(git rev-parse --show-toplevel)/services/censor"

gcloud builds submit "$SRC" \
  --project "$PROJECT" --region "$REGION" --tag "$IMAGE" \
&& gcloud run deploy lustxr-censor \
  --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --cpu 2 --memory 2Gi \
  --concurrency 8 \
  --min-instances 0 \
  --max-instances 4 \
&& AVR_CENSOR_TOKEN=$(grep -m1 '^AVR_CENSOR_TOKEN=' "$(git rev-parse --show-toplevel)/.env" | cut -d= -f2-) \
   node "$SRC/scripts/verify-deploy.js" https://lustxr-censor-fupy4bogsq-uc.a.run.app
```

The verify step is chained on purpose. Checking that the deploy reported
success tells you a container started, not that it covers anything.

### Verifying a deployment

The only check worth running is whether pixels moved.

Byte counts, content types, latency and compression ratios all pass for a
re-encoded original, and that is not a theoretical gap: the mosaic was broken
for its entire first day in production and every one of those signals read as
healthy, because the file got *smaller*, which looked like evidence the mosaic
was working. See the docstring on `blocky` in `src/mosaic.js`.

So there is a script, and it decodes:

```sh
R="$(git rev-parse --show-toplevel)"
AVR_CENSOR_TOKEN=$(grep -m1 '^AVR_CENSOR_TOKEN=' "$R/.env" | cut -d= -f2-) \
  node "$R/services/censor/scripts/verify-deploy.js" \
  https://lustxr-censor-fupy4bogsq-uc.a.run.app
```

Its first check is `/health`'s `bars` against this working tree's fingerprint,
and it stops there if they differ. Everything after it passes against the
build that was already running, so without that the script cannot tell a
deploy that landed from one that did not — which is the failure this project
has actually had, twice.

Then it sends a 4000x3 sliver of fine stripes — nothing anybody has to look at, and
unintelligible to a 320x320 detector, so the service takes its whole-frame
fallback. That is the branch it enters whenever it cannot tell, the one its
own docstring calls safe, and therefore the one whose silent failure costs the
most. The script decodes both sides and counts, and exits non-zero if the
service claimed a whole-frame mosaic and the pixels did not move.

**It runs the same probe through this repository's own `pixelate` first** and
aborts if that does not move the pixels either. That control is not ceremony.
The first version of this script sent a *solid-colour* sliver, and a solid
colour put through a correct mosaic comes back the same solid colour — so it
reported 0.0% against known-good code, and production was declared broken on
the strength of it. A measurement that cannot tell a working service from a
broken one is worse than no measurement, because somebody acts on it.

Two things it deliberately does **not** check:

`X-Censor-Confidence` is not a version marker. It is absent whenever `detect`
does not finish — which is exactly what happens on the sliver — in every build
there has ever been. Reading its absence as "this is an old image" is a
mistake that has already been made once.

File size is not evidence. A re-encoded original is smaller too.

### Why IAM is open

`--allow-unauthenticated` needs justifying, because the instinct is the other
flag. It controls Google's IAM check, and passing that check means presenting
a Google-signed identity token. The caller is `server/media/censor.js` running
on an **AWS EC2 box**, which has no Google service-account identity and no
metadata server that would mint one. So the service authenticates the only
caller it has with `X-Censor-Token`, a 256-bit shared secret compared on every
request, and Google's IAM layer is left open because it is a lock we cannot
hold the key to.

Two things make that an acceptable trade rather than an open service. The
endpoint has no DNS name and is not linked from anywhere, so reaching it means
already knowing the generated `*.run.app` hostname. And what it does is
pixelate pictures — there is no data in it, nothing it can read, and nothing
it stores. The exposure of a guessed hostname plus a guessed 256-bit token is
somebody else's images getting mosaiced at our expense, which `--max-instances`
caps.

#### Why a dedicated project

This is the part that cost a project. `allUsers` cannot be named in an IAM
policy anywhere under `cubemarch.com`, because the org inherits
**Domain Restricted Sharing** (`constraints/iam.allowedPolicyMemberDomains`,
allowing only customer `C02nq0yz3`). The binding fails with
`FAILED_PRECONDITION: One or more users named in the policy do not belong to a
permitted customer` — which reads like a typo in the member name and is not.

That constraint can only be overridden at project granularity, never per
resource. Overriding it on `cubemarch-507617`, where this first lived, would
have lifted the guardrail off `cubemarch-animatediff-outputs` and
`cubemarch-scene-assets` as well — the guardrail that makes an accidentally
public bucket *impossible* rather than merely unlikely. Trading that for a
pixelation service is a bad trade, so the service moved instead.

So the override lives on a project containing one stateless thing that takes
an image and returns a blurrier image: no data, no storage, no other resource.
**That is the entire justification, and it expires the moment anything else is
deployed here.** If something else ever needs to live in `lustxr-censor`, move
the constraint back and solve the access problem a different way.

#### Two alternatives, and why neither is better today

A **dedicated service account with a key**, service left IAM-locked. An
earlier draft of this file called that "a worse credential than the one it
would be replacing", and on inspection that was wrong: a key granting only
`roles/run.invoker` on this one service grants exactly what `X-Censor-Token`
already grants — the ability to make us pixelate a picture. Identical blast
radius. The real argument against it is cost, not risk. It needs ID-token
minting and caching in `censor.js`, and a second long-lived secret to rotate,
where the dedicated project needs neither and no code change at all.

**Workload Identity Federation**, which would let the EC2 box trade its AWS
identity for a Google token with no static key anywhere. This is the textbook
answer and it is genuinely better in the abstract. It is not taken because the
production instance `i-0ab7a2e605ea61af9` has **no IAM instance profile
attached** (checked 2026-10-20), so there is no AWS role to federate *from*.
Turning it on means a new IAM role, an instance profile, a GCP workload
identity pool and AWS provider, and the same token-minting code the key option
needs. And it would *add* a lock rather than replace one — `X-Censor-Token`
stays either way, because it is what survives the move to App Runner. The
whole prize is that a stranger who guesses the hostname gets a refused
connection instead of a 401.

### Rotating the token

`--set-env-vars` on the service first, then `AVR_CENSOR_TOKEN` in
`/srv/lustxr/app.env`, in that order: the service accepts the new one before
the caller starts sending it, so there is no window where artwork falls back
to the placeholder.

`--min-instances 0` is deliberate: it scales to zero and costs nothing when
nobody is browsing signed-out. Measured on the first revision, 2026-10-20:
container start to listening **1.73s**, model load **~0.6s** on the first
request after that, so the worst cold path is about **2.4s**. That matters
because `server/media/censor.js` gives up at `TIMEOUT_MS = 4_000` — the margin
is real but it is not large, and anything that slows the model load (bigger
weights, a second model) eats it. If that timeout starts firing on first
hits, raise `--min-instances` to 1 before raising the timeout; a placeholder
that resolves itself in six seconds is worse than an instance that costs a
dollar a month.

A warm cold start is also softer than it sounds. `_swapFrame` in
`src/ui/cams.js` holds the previous frame until the new one decodes, and
`/api/media` caches the placeholder for only five seconds, so the failure
mode is one page-load of placeholders that fixes itself on the next refresh
rather than a stuck row.

`--concurrency 8` because each request holds a decoded bitmap and an inference
buffer; higher packs more per instance and raises the tail latency that the
caller's 4s timeout is measured against.

### Isolation

This is a LustXR dependency and it now has its own project, which satisfies
the standing rule the easy way rather than the arguable way: the same billing
account is fine as long as external reviewers cannot tell, and here there is
nothing to tell. It shares no project, host, certificate, bucket or DNS zone
with Cubemarch, QuestJam or VRecord.

Nothing about it is externally observable in any case. It is called
server-to-server from the application host, answers only to a shared secret,
and has no public DNS name and no certificate of its own. Its generated
`*.run.app` hostname appears in no page, no bundle and no DNS zone. Do not
give it a custom domain, and do not put it behind a hostname that resolves
alongside anything else.

### What was verified, 2026-10-20

Against the deployed revision, not a local build:

| | |
| --- | --- |
| `GET /health` | `{"ok":true,"model":"loaded"}` |
| `POST /scan`, no token | `401` |
| `POST /scan`, wrong token | `401` |
| Detection | 10 live catalogue images → 9 returned boxes (covers 0,2,1,0,0,6; stills 3,3,3,3). The zeros are clothed covers |
| Latency | 109–217ms per image including the fetch from `pic.aebn.net` |
| Cold start | 1.73s to listening, ~0.6s model load |
| Full chain | `/api/aebn/newest` signed-out → 24 items, every image on our origin → `/api/media` → covered JPEGs, 23–57KB |
| Refusals | forged signature, truncated signature, absent signature, swapped `u`, `169.254.169.254`, off-allowlist host — all six returned the placeholder |

The detection row is the one worth re-running after any model change. The
very first scan after the first deploy returned zero boxes, which proves only
that the service decoded and re-encoded an image — a container with a corrupt
model does exactly that and reports itself healthy. One image is not a test.

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
