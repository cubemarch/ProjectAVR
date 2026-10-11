# ProjectAVR Monetisation

Credits, per-minute pricing, creator profiles, and the stream setup checks that
gate what a creator is allowed to offer.

This is a **web product** document. The capture app has no part in any of it:
it holds no balance, shows no price, and has no idea whether the person watching
is paying. That separation is deliberate, it is a standing constraint on both
sides, and it is now also a repository boundary — the app ships on its own and
nothing here may reach into it.

---

## One credit is one US cent

There is exactly one unit in this subsystem and it is an integer.

Every price, balance, ledger delta and lifetime total is a whole number of
credits. Dollars appear in precisely two places: the `amount_cents` column of
`credit_purchases`, because a payment processor insists on a currency, and the
`$10 / $25 / $50 / $100` labels the browser prints. `dollars()` in
[`src/ui/profile.js`](../src/ui/profile.js) is the only division in the product.

This is not fastidiousness. A per-minute charge against a floating-point balance
accumulates error across a two-hour session, and the resulting support ticket —
"my balance is $4.999999" — cannot be reproduced on demand. Naming the unit once
and never converting removes the failure mode rather than making it rare.

Purchases are 1:1 today (`creditsFor()` in
[`server/credits/providers.js`](../server/credits/providers.js)), and
`credit_purchases` stores `amount_cents` and `credits` separately anyway, so a
bonus-credits promotion later is a value change in one function rather than a
schema change.

---

## The ledger

`credit_ledger` is append-only and double-entry. Nothing ever updates a row and
nothing ever deletes one.

A viewer being charged for a minute is **two rows sharing a `ref_id`**, written
in one transaction: a debit against the viewer with `reason = 'watch'`, and a
credit to the creator with `reason = 'earn'`. A transfer therefore nets to zero,
and the only entries that create or destroy credits in the system are purchases
and explicit adjustments.

`credit_accounts.balance` is derivable by summing the ledger. It is cached so
that reading a balance is one indexed lookup rather than a scan that grows for
the life of the account, and it is **written in the same transaction as the
ledger row, never on its own**.

### The invariants

`credits.audit()` in [`server/db/index.js`](../server/db/index.js) returns the
four numbers that have to agree, and the last test in
[`test/credits.test.js`](../test/credits.test.js) asserts them against the state
left behind by everything the other thirty tests did:

```
balanceSum === ledgerSum              the cached balances agree with the rows
ledgerSum  === purchased + adjusted   nothing invented credits along the way
```

If either fails, some code path moved money outside the ledger. Add a case to
that test rather than fixing the number.

### Transactions and idempotency

`credits.post()` and `credits.transfer()` open `BEGIN IMMEDIATE` by hand and
roll back in `catch`, matching `analytics.recordView`. A balance check, the
ledger insert and the account update are one atomic unit; there is no window in
which a balance is true and its row is not.

`credit_ledger.idem_key` is `UNIQUE`, and **the duplicate check happens inside
the transaction**. Two concurrent retries of the same purchase callback cannot
both insert: the second finds the first's row and returns `applied: false` with
the balance that entry produced. A replay is not an error, and it is not a
second grant.

On a transfer, the debit half carries the key and the credit half carries
`NULL` — one key per logical event.

Keys in use:

| Event | Key |
| --- | --- |
| Credit purchase | `purchase:<purchaseId>` |
| A minute of viewing | `minute:<sessionId>:<viewerId>:<scope>:<n>` |

The viewer id is in the minute key because the key has to be unique across
everyone watching the same broadcast at the same time, while still colliding for
the *same* viewer reconnecting inside a minute they have already paid for. That
collision is the feature: a dropped socket costs nothing to re-open.

`<scope>` is `public` or `private`, and it is in the key because the same viewer
can be charged for both inside one broadcast: they watch publicly, ask for a
1:1, and are readmitted to the same session at the private rate. Without the
scope, minute *n* of the private turn would collide with minute *n* of the
public watch and the second one would be free.

A refusal is total. An unaffordable transfer moves nothing at either end and
leaves no row behind; `allowNegative` exists for adjustments and is not reachable
from any route.

---

## Buying credits

`POST /api/credits/purchases`, rate-limited to ten a minute.

The purchase row is written **before** the processor is called, so a request
that dies halfway leaves a `pending` row somebody can reconcile against the
processor's dashboard, rather than money taken against nothing. On success the
credits are posted and the row moves to `paid`; on a throw the row moves to
`failed` with the reason on it. A failed purchase a viewer swears they made is a
support question, and a table with no row in it cannot answer.

A provider that returns a hosted checkout page instead of settling inline gets a
`202` with a `redirectUrl` and a `pending` row. **Credits are granted when the
processor says the money arrived, not when the browser comes back from its
page** — a return URL is something anyone can navigate to.

Amounts: the four tiers `1000 / 2500 / 5000 / 10000` cents are always accepted;
anything else is a custom amount and must fall between `$5` and `$500`. A floor
because a fifty-cent purchase costs more in processor fees than it is worth, and
a ceiling because the largest number a person types by accident is the one with
an extra zero on it.

### The stub provider

There is one implementation of the provider interface and it takes no money.
Every purchase settles immediately and the credits are posted as if paid.

It is loud about it, in three places: a `console.warn` the first time it is
used, a line in the startup banner (`Payments  stub  ⚠ STUB — grants credits
without taking any money`), and `provider.isStub` in the response to
`GET /api/credits`, which the browser prints on the buy button. A person
spending money has a right to know whether any is being taken.

`provider = 'stub'` is recorded permanently on every row it settles, so a demo
balance is identifiable by a query forever rather than by remembering which
environment it came from.

**An unrecognised `AVR_PAYMENTS_PROVIDER` is fatal**, exactly as it is for
identity. A fall back to the stub on a typo would hand out free credits while
reporting itself as working, which is worse than a server that will not start.

Wiring a real processor in is writing a second object with `name`, `isStub`,
`createCharge` and `fetchCharge`, and adding it to `PROVIDERS`. It is not
rewriting the accounting — that part is already real and already tested.

---

## Profiles

Both roles get a profile page at `/profile`; a creator's is the same page with a
second panel.

| | |
| --- | --- |
| `GET /api/profile` | Profile, credit account, and for creators pricing + stream checks |
| `PATCH /api/profile` | Tagline (≤120) and bio (≤2000) |
| `PUT /api/profile/avatar` | Raw image bytes |
| `DELETE /api/profile/avatar` | |
| `PATCH /api/profile/creator` | Pricing, 3D switches, recording policy |
| `GET /api/profile/names` | The channel names this account holds, and its limit |
| `GET /api/creators/live` | Who is on air and who is ready |
| `GET /api/creators/:id` | A creator's public page |
| `GET /api/channels/:slug` | Public. The channel at `/<name>`, and whatever is live on it |

Over-long text is a `400`, not a silent truncation. Saving something other than
what was typed is a worse outcome than refusing.

**Your link** is the one field on this page that is also an address. A channel
name claims `/<name>` at the root of the site, and it is the only permanent way
to point at a creator — a session id is minted per broadcast, and a broadcast
grant is spent on the connection it opened. Changing it keeps the old name
working. The rules, the reserved list and the superuser's multi-name case are
in [LIVE.md](LIVE.md#name-is-the-link-because-nothing-else-can-be).

Pricing lives here, and no face check stands in front of it — nor in front of
Studio at all. The face check exists to prove who is about to go on air, so it
sits on the one route that puts somebody there
(`POST /api/identity/broadcast/destination`); making a creator prove their face
to edit a sentence about themselves is friction with no threat behind it.
**Changing a price cannot move money — only a broadcast can, and that is
gated.** See [`IDENTITY.md`](IDENTITY.md).

`GET /api/creators/:id` is deliberately not `/api/profile/:id`. A viewer's
profile is not a public document, and a route that serves "any account by id" is
one refactor away from being one. Non-creator ids `404`.

### Avatars

Upload is raw bytes with `express.raw` and a `Content-Type` allowlist — no
multipart dependency for a single file. The header is then ignored in favour of
a magic-byte sniff (`sniffImage`), because `Content-Type` is written by the
client and trusting it is how an "image" ends up being an HTML document served
back from our own origin.

Each upload gets a **fresh random key** rather than overwriting, so a cached or
CDN-held copy of the old picture can never be served as the new one. The old key
is deleted only after the new row is committed: losing a picture is recoverable,
a row pointing at a key that is gone is not.

### Why profiles and pricing are side tables

`getDb()` replays `schema.sql` on every open and every statement in it is
`CREATE TABLE IF NOT EXISTS`. **There is no migration system and there are no
`ALTER TABLE`s.** A new table is safe; a new column on an existing table is not,
because existing databases would never get it.

So avatars and pricing live in `user_profiles` and `creator_settings` rather
than on `users`. It is also the better shape: the auth path reads `users` on
every single request and has no use for a bio.

---

## Stream setup checks

Before a creator can go on air they confirm their stream is working, **once per
sign-in**. Sending 3D is a second, separate confirmation.

Two checks rather than one, because a rig that produces a perfectly good flat
picture can still be sending a mis-paired stereo view — one that looks wrong in
a headset and completely fine on the laptop the creator is checking it on. The
person who otherwise finds out is the paying viewer.

| | |
| --- | --- |
| `GET /api/live/checks` | `{standard, spatial, standardAt, spatialAt}` |
| `GET /api/live/checks/preview` | The broadcast to put on the screen, or `{preview: null, reason: 'no_broadcast'}` |
| `POST /api/live/checks/:kind` | `{confirmed: true}`; kind is `standard` or `spatial` |

`maySendSpatial()` requires **both** checks. The spatial check confirms the
stereo pair; the standard check confirms there is a working stream to pair. A
creator with the second and not the first has not demonstrated the thing.

The registry is in memory and node-local, like `sessions.js` and `rooms.js`, and
it is cleared on sign-in, sign-out and sign-out-everywhere. "Once per sign-in"
is a statement about this session, not about this account — a check that
survived a restart would be a check the creator did on equipment they may no
longer be sitting in front of. `AVR_STREAM_CHECK_TTL` (default 12h) is a ceiling
for the laptop left signed in for a week, not the primary expiry.

Note the terminology: the check kinds are `standard` and `spatial`, matching the
vocabulary the iOS brief fixes. The user-facing web copy says 2D and 3D, which is
what viewers call it.

### The preview

A check that says "confirm your stream is working" while showing nothing is an
attestation about the creator's memory of their equipment. So the check decodes
their outgoing stream on the page, in
[`src/live/check-preview.js`](../src/live/check-preview.js), and the confirm
button stays disabled until frames are on the screen.

The creator watches their own broadcast through the ordinary relay path — the
same socket, decoder and `StereoView` a viewer gets — and it costs them nothing,
because `billing.isFree()` already exempts a creator from their own broadcast and
`rooms.mayWatch()` already admits them to it. The preview restates neither rule.

The spatial check adds the layouts that make a mis-paired stereo view visible on
a flat screen: **side by side**, **anaglyph**, **difference**, and each eye
alone. Difference is the useful one — a correct pair leaves edge outlines where
the parallax is and near-black everywhere else; two copies of the same camera
leave black. There is also a **swap eyes** control, which is a diagnostic and
says so: swapping there changes the preview and nothing else, and a pair that
only looks right swapped is a pair to fix in the capture app.

What the server contributes is the part a person cannot verify by looking:

- `session.carryingStereo` counts eyes that have **delivered frames**, not eyes
  the phone announced in its HELLO. A rig whose second camera never started
  sends `stereo: 'sbs'` and one picture, which is precisely the failure the 3D
  check exists to catch.
- `POST /api/live/checks/:kind` refuses `409 no_broadcast` when nothing of the
  creator's is live, and `409 not_stereo` when a spatial check is pressed over a
  single eye. Nothing is recorded in either case.

Neither half is load-bearing alone: the page will not let the creator confirm
what they cannot see, and the server will not record a confirmation of something
that was not happening.

On the **shared stream key** a broadcast has no `creatorId`, so the server cannot
prove whose camera it is. Rather than silently presenting it as theirs, the
preview is offered with `attributed: false` and the page says outright that this
is whatever camera is connected. Under `AVR_IDENTITY_ENFORCE` every session
carries a creator and unattributed broadcasts are not offered at all. Another
creator's broadcast is never offered either way, and neither is anyone's 1:1.

One thing the preview cannot do is prove itself in a browser without a secure
context: `VideoDecoder` does not exist over plain HTTP at a LAN address, so
`webCodecsSupport()` names that as the reason and points at
`http://localhost:<port>/` instead of failing as "unsupported browser".

### The 3D gate

Turning 3D on is the one setting that asserts something about the *equipment*
rather than about the creator's preferences, so it is the one setting the server
refuses to take their word for.

`PATCH /api/profile/creator` with `public3dEnabled` or `private3dEnabled` set
true, from a creator who has not passed both checks, returns:

```json
409 { "error": "3D has to be confirmed before it can be offered",
      "code": "spatial_check_required",
      "streamChecks": { "standard": true, "spatial": false, ... } }
```

Nothing in the patch is written — not the prices that came with it either. The
client is told *which* check to run rather than just being refused, and
[`src/ui/profile.js`](../src/ui/profile.js) uses that: it stashes the rejected
patch in `pendingCreatorPatch`, puts the 3D check in front of the creator, and
re-applies the whole patch once the check passes. That is the "forced to perform
3D setup" behaviour, and it is a consequence of the gate rather than a separate
code path that could drift from it.

Turning 3D **off** needs no check.

---

## The home page row

`GET /api/creators/live` drives the **Live Creators** row, and it returns two
states:

- `live` — a broadcast running right now, with `live.sessionId`
- `ready` — signed in and set up, not yet on air

Keeping them apart matters because clicking one starts costing credits a minute
and clicking the other does not.

Presence is derived from the readiness registry rather than from a second online
registry. A creator who has confirmed their stream this session is exactly the
set of people who could be on air in the next few seconds, which is what "ready"
is supposed to mean — and one registry cannot disagree with itself.

`live.supports3d` is `session.stereo !== 'mono' && pricing.public3dEnabled`:
whether there is a second eye to switch to *and* whether the creator is offering
it. The switch itself is in the player.

**Private broadcasts never appear here.** A session whose grant carries a room
is filtered out by the same `rooms.isPrivate(session)` check that hides it from
`/api/live/sessions`, 404s it by id, and gets it refused admission at the relay.
One rule, four enforcement points, and the home page is not the exception.

The browser polls this every 15 seconds. `Cache-Control: no-store` throughout —
a cached "who is live" is wrong almost immediately and a cached one belonging to
somebody else is worse.

---

## Recording consent

`creator_settings.recording_policy` is `ask` | `always` | `never`, and it
defaults to **`ask`**. In an all-party-consent jurisdiction silence is not
agreement, so the default cannot be the permissive one.

The asymmetry the product calls for — in a 1:1 the viewer records both voices,
the creator records only their own — is enforced by *where each recording is
made* rather than by a flag, and is described in [Stage 5](#stage-5--recording-and-the-marketplace)
below. The policy governs the viewer's side only: the creator needs nobody's
permission to record their own camera, and there is nobody else in that file to
ask.

---

## Configuration

```sh
AVR_PAYMENTS_PROVIDER=stub    # the only one implemented; unknown names are fatal
AVR_STREAM_CHECK_TTL=43200    # seconds; ceiling on a setup confirmation
```

See [`.env.example`](../.env.example).

---

## Where this is up to

**Stage 1 — Foundation. Done.** Schema, repositories, the ledger with its
invariants under test, purchases against the stub provider, profiles and
avatars, creator pricing with the 3D gate, the readiness registry and its
routes, the Live Creators row, the profile page and the buy-credits panel.
31 tests in `test/credits.test.js`.

**Stage 2 — Per-minute billing. Done.** A viewer is charged per **started**
minute by [`server/live/billing.js`](../server/live/billing.js), which the relay
consults during the upgrade. 32 tests in `test/billing.test.js`.

What was decided, and why:

- **Charged in advance, per started minute.** Billing after the fact is billing
  somebody who has already closed the tab. There is no trial minute either;
  "free for a moment then billed" is the pattern chargebacks are made of.
- **The server owns the clock.** A billing tick driven by the viewer's browser
  is a billing tick a viewer can stop sending, so the meter is an interval in
  the relay process and the socket only ever receives statements.
- **One meter per account per broadcast.** A second tab attaches to the meter
  that already exists; the meter stops when the last socket goes. Two tabs are
  one bill.
- **The rate is chosen by the pair and the mode** — public or private, 2D or 3D.
  Switching to 3D re-prices the *next* minute; nothing is re-priced backwards and
  nothing is refunded.
- **Running out disconnects.** `insufficient_credits` from `transfer()` is the
  signal — that check is already atomic, so there is no second balance read to
  go stale. The viewer gets a `low_balance` statement first and a close with
  code `4402` (`CLOSE_OUT_OF_CREDITS`) when the money is gone.
- **Anonymous viewing of a priced broadcast is refused, not given away.** The
  upgrade wants an `access_token` in the query string (a browser cannot set a
  header on `new WebSocket()`); without one the relay answers `401`, and a
  viewer who cannot afford the first minute gets `402`.

What a viewer sees: `GET /api/live/watch/:id` returns a quote before they join —
both rates, which modes are available, their balance — and the cost strip in the
player updates from a `BILLING` frame each minute. `POST /api/live/watch/:id/mode`
switches 2D/3D, and answers `409 mode_unavailable` for a broadcast that is not
offering stereo.

**Stage 3 — The chatroom, the 1:1, and talkback. Done.** Three pieces, in the
order they had to be built.

**The public chatroom.** Joining a public broadcast joins its room; leaving the
socket leaves it. The room lives in
[`server/live/chat.js`](../server/live/chat.js) and is memory-only and
per-broadcast — nothing is written to the database, and when the broadcast ends
the room is gone with it. Messages arrive as `CHAT` frames on the relay socket
and fan out as `CHAT` frames, so chat costs one code path, not a second
transport. Signed-in viewers only: an anonymous socket can watch a free
broadcast but has no name to put on a line, so it receives the room and cannot
post to it. Rate-limited per person, length-capped, and the two refusals a
person can act on come back as a notice on their own socket. 18 tests in
`test/chat.test.js`.

**The 1:1.** A viewer asks with `POST /api/live/watch/:id/private`; the creator
sees the queue on their own broadcast and accepts or declines. Accepting opens a
private room on the Request K machinery — which already hides the session from
the session list, the relay and the quote endpoint — and **evicts everyone else
with close code 4403**. The asker is readmitted with an admission secret and
metered again, at the private rate, under a fresh `private` scope. Either party
ends it; the viewer's way out is a button, because somebody whose only exit from
a room they are paying for is to close the tab is being held in it. Refusals are
named rather than generic: no credits is `402`, asking repeatedly is `429`. 19
tests in `test/private-turn.test.js`.

**Talkback.** The only thing in this project that travels from a viewer towards
a camera, and it is deliberately the narrowest path there is: only the person
the broadcast is private to, checked fresh on every packet; linear PCM so the
capture app needs no decoder; the relay re-encodes the header so nothing a
viewer writes can arrive claiming to be video or configuration; and dropped
rather than queued at three separate points. The wire, the rules and the
drop behaviour are described in [`LIVE.md`](LIVE.md#the-relay-is-no-longer-one-way).
13 tests in `test/talkback.test.js` against a real relay, 12 in
`test/talkback-client.test.js` for the browser's `AudioWorklet` and its
backpressure, and 14 on the iOS side in `ReturnAudioTests.swift`.

The iOS half is built as what it is — **broadcast talkback / intercom**, the
return channel a camera operator has always had to the gallery. It is one-way,
off by default, carries no identity, and the app cannot tell whose voice it is
playing. That is an honest description of the binary and it is not the whole
story: in *this* product the voice is a paying viewer in a 1:1, which a reviewer
may read as the viewer interaction the capture app is supposed not to have. It
is recorded as an open High risk in the capture app's own register rather than
left to be discovered. It is a risk this product creates for that one, which is
the reason to keep writing it down after the split rather than before.

**Stage 4 — The setup checks show the picture. Done.** Described in [The
preview](#the-preview) above. A check used to be an attestation with nothing on
screen behind it; it is now a decode of the creator's own outgoing stream, and
the confirmation is refused by the server unless a broadcast is live — and, for
3D, unless two eyes have actually delivered frames. 18 tests in
`test/stream-check.test.js`.

**Stage 5 — Recording and the marketplace. Done.** In a 1:1 both parties may
record, and the two recordings are made in different places on purpose.

**The creator's** is made on this server by
[`RecordingPipeline`](../server/live/recording.js), a subclass of the HLS
`TranscodePipeline` attached to the live session as an ordinary subscriber. It
therefore contains exactly what the phone sent — the creator's picture and the
creator's voice — and talkback, which travels the other way and never passes
through a subscriber, is *structurally* absent rather than filtered out. One
FFmpeg, one rung, one `-y` MP4 with `+faststart`. The parent's restart-on-exit
is overridden: respawning over a half-written MP4 truncates it, and an MP4 that
never got its index is unsalvageable, so a recorder that loses FFmpeg fails the
whole recording and says why. `stop()` sends `SIGINT`, waits for the child to
finalise, stores the file through `server/storage`, and writes the row.

**The viewer's** is made in their browser by
[`ViewerRecorder`](../src/live/recorder.js) — the canvas they are watching,
mixed with the sound they are hearing and their own microphone — and saved to
their own disk. It is never uploaded, and there is no route that would accept
it. A file with a paying customer's voice in it is not a thing this service
should hold, and the cheapest way to be sure of that is for it never to arrive.
This is the side `recording_policy` governs: the viewer asks over
`POST /api/live/watch/:id/recording/consent`, the creator answers, and the
answer does not outlive the turn.

**Only the creator's kind is sellable**, for the same reason: it is the only one
the customer is not in. Listing sets the title and the price
(`POST /api/recordings/:id/list`, `ready` recordings only); taking a listing
down does not revoke a purchase, because that would be a refund and a different
act. The **2D**/**3D** tag comes from `session.carryingStereo` at the moment the
file was finalised — frames actually received on both eyes, not what the phone
announced and not what the creator typed — so a broadcast whose second camera
dropped out is tagged 2D however it was configured.

A sale is a `credits.transfer()` like any other, keyed on the sale id, with
three separate defences against double-charging: the existing-sale read, the
transfer's `idemKey`, and `UNIQUE (recording_id, buyer_id)`. If the transfer
refuses, the sale row is deleted, so an unpaid sale can never look like an
entitlement. Delivery is deliberately **not** a `/stream/` URL — that path
serves any key it is given, which would make the key the entitlement. Instead
`GET /api/recordings/:id/file` checks the sale on every request and the storage
key never appears in a response body.

New tables (additive, no `ALTER`): `recordings` and `recording_sales`. 21 tests
in `test/recordings.test.js`, two of which record, store, list, buy and download
a real file through a real FFmpeg, and 7 in `test/recorder-client.test.js` over
the browser side's promises — nothing uploaded, talkback's microphone reused
rather than reopened, and only the microphone this page opened released
afterwards.

### Out of scope until asked

**Creator payouts.** Earnings accrue in the ledger; there is no withdrawal path,
and building one means KYC, tax reporting and a money-transmission question that
is a business decision before it is an engineering one.

### The material risk, stated plainly

Per-minute paid 1:1 video with private rooms and a recording marketplace is a
business model that App Review will read as an adult-content service if the
public-facing product is one. That judgement is made on the whole product, not
on the binary alone. The iOS app is and must remain a content-neutral capture
tool with no link to any of this — no feed, no catalogue, no pricing, no
marketplace, no path to a viewing surface. That is what keeps the app reviewable
on its own terms, and it is a constraint on this layer as much as on that one.
