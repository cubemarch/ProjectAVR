# Identity

Who is allowed to watch, who is allowed to broadcast, and how the server knows
they are still that person later.

Three checks, answering three different questions:

| Check | Who | When | Question it answers |
| --- | --- | --- | --- |
| **Age assurance** | every account | once, at registration | Is this person over 18, on a genuine government document? |
| **Enrolment** | creators | once, at registration | Is this a real person holding that document, and what does their face look like? |
| **Portal face check** | creators | before going on air, once per browser session | Is the person at this keyboard the one who enrolled? |

They are deliberately not one check. A viewer proves an age with a document and
is never seen again — no selfie is taken and no face is enrolled, because
enrolling a face template for someone who will never be matched against it is
collection with no purpose, and the thing GDPR Article 9 exists to discourage.
A creator does the document check *and* leaves a face, because a creator is the
one whose account can put a picture in front of an audience.

Enrolment without the recurring check means a stolen password puts someone else
on air under a verified name. The recurring check without enrolment proves only
that a live human took a photo. Neither is useful alone.

### Where each one is asked

Both of the once-only checks belong to **registration**. The signup form has a
User / Creator toggle on it, and which side it was submitted from decides which
check the new account is sent to on its first screen — a viewer to the age
check, a creator to the enrolment. Neither is deferred to the first time the
account tries to do something, because an account that cannot do anything yet is
the cheapest possible moment to ask, and the most honest: what is being
collected is being collected to open the account, not sprung later.

The recurring check belongs to **going on air**, and to nothing else. Opening
Studio does not ask for it. Reading your own figures, setting a price, or
editing a profile are not acts anyone impersonates a creator to perform, and a
face check standing in front of them trains the creator to treat the check as
furniture. A password protects what Studio *shows*; a face protects what Studio
*does*. `POST /api/identity/broadcast/destination` is the one route that
enforces it, and `server/routes/creator.js` deliberately has no gate of its own.

### Adult-confirmed, without asking twice

A creator's enrolment already proves a date of birth: `fetchEnrolment` refuses
to report `verified` unless the document put the holder over 18. Sending them
through a second document scan a minute later collects the same evidence again.

So the question "is this account old enough to be here" is answered by
`adultConfirmed(user)` in `server/identity/age.js`, which is true when the age
assurance is current **or** — for a non-viewer — the creator verification is
current and `adult_confirmed`. It is derived at read time, and deliberately not
written down: the tempting shortcut is to insert an `age_assurances` row off the
back of an enrolment, and that row would have to carry a consent version, a
timestamp and an IP for a disclosure the creator never saw. A fabricated consent
record is worse than no record. The test `an enrolled creator is adult-confirmed
without a second document scan` asserts both halves — that the answer is true,
and that the table is still empty.

Every response that establishes a session (`register`, `login`, `refresh`,
`/me`, `/api/identity/status`) carries `adultConfirmed` alongside the two rows,
so no client has to re-derive it.

---

## The one rule

**ProjectAVR never stores a biometric identifier.** No face image, no face
template, no embedding, no document scan. Not in SQLite, not in S3, not in a
log.

This is not caution for its own sake. Illinois BIPA attaches a private right of
action with statutory damages to *possessing* a biometric identifier without
written consent and a published retention schedule — the liability follows
possession, not misuse. Texas CUBI is similar without the private action, and
GDPR Article 9 puts face templates in the special-category tier where the
default is prohibition. On top of that, a face template cannot be rotated after
a breach: a password compromise costs a reset, and a face compromise is
permanent.

The only reliable way out of all of it is not to hold the thing. So the
verification provider holds it, and this database holds an opaque reference and
the decisions that came back.

What *is* stored, in `creator_verifications`:

- `provider_subject_id` — the provider's account handle. Opaque, and the only
  thing that makes a later face check possible.
- `status`, `decline_reason`, `verified_at`, `expires_at`
- `document_country`, `document_type` — non-biometric, and needed to answer
  which country's documents a platform accepts
- `adult_confirmed` — a **boolean decision**, not a birth date. The only
  question an adult platform must be able to answer is whether they were over
  18 at verification; a date of birth would be personal data with no other use.
- `consent_version`, `consent_at`, `consent_ip`

And in `age_assurances`, for every account including viewers:

- `status`, `decline_reason`, `verified_at`, `expires_at`
- `adult_confirmed` — again a boolean, not a birth date
- `document_country`
- `consent_version`, `consent_at`, `consent_ip`

There is no `provider_subject_id` on that table, and that omission is the point:
an age check creates no durable handle at the provider because nothing will ever
be matched against it.

The test `no biometric identifier is stored anywhere in the schema` walks every
column in the database and fails the build if one turns up named like a face.
Deleting that test is a decision about legal exposure, not about test coverage.

---

## Why the browser, and not the phone

The face check runs in the creator's **web browser**, not in the capture app.

- The browser already holds a session this server issued and rotates. The phone
  is the thing being authorised; making it also the thing that authorises is
  circular.
- The capture app is about to take exclusive use of both cameras for a
  multi-cam stereo session. A verification SDK competing for `AVCaptureSession`
  is a race nobody wins.
- It means the phone never handles a face at all. Nothing biometric is ever in
  the address space of the app, or on the TCP socket into the ingest.

The capture app is never in any of it. It has no account on this server, no
sign-in, and no knowledge that verification exists — it is a general-purpose
broadcasting tool that sends video to an address and a key. This platform's
opinion about who is allowed to *be* that address's source is expressed
entirely in which addresses it hands out.

---

## The flow the product actually uses

The creator verifies in a browser and carries one URL across by hand.

```
 browser                       server                      capture app
   │                             │                              │
   │  clicks Go live             │                              │  asks for a
   │  POST /portal/unlock        │                              │  destination
   ├────────────────────────────►│  challenge, provider inquiry │
   │◄────────────────────────────┤                              │
   │  runs the selfie flow       │                              │
   │  POST /portal/unlock/:id/complete                          │
   ├────────────────────────────►│  server asks the provider    │
   │◄────────────────────────────┤  approved → unlock token     │
   │  (sessionStorage)           │                              │
   │                             │                              │
   │  POST /broadcast/destination   X-AVR-Portal-Unlock: …      │
   ├────────────────────────────►│  mints a grant               │
   │◄────────────────────────────┤  avr://pair?host=…&key=…&name│
   │                             │                              │
   │     creator scans the destination link off the screen ────►│
   │                             │                              │  confirms,
   │                             │                              │  saves to
   │                             │  HELLO { key: grant }        │  Keychain
   │                             │◄─────────────────────────────┤
   │                             │  ingest, attributed to userId│  green "Ready"
```

The unlock token is returned exactly once and lives in `sessionStorage`, which
is the whole mechanism behind "once per browser session": it dies with the tab,
a second browser gets its own check, it never survives a restart, and signing
out revokes it server-side rather than trusting the browser to forget.

Two things fall out of that which are worth stating plainly. A session holding
an unlock gets its destination in **one** round trip — `status: 'approved'` with
the URL attached — because asking the same person for a second selfie thirty
seconds after the first one teaches them the check is noise. And the unlock is
bound to the account that earned it, so one creator's face check cannot open
another's portal; the test `an unlock is bound to the account that earned it`
is what holds that.

The unlock header is a separate token rather than being keyed off the session
cookie because the refresh cookie's path is `/api/auth`, so it never reaches
`/api/identity/*` or `/api/creator/*` at all.

### Enrolment opens the portal itself

The diagram above starts at `POST /portal/unlock`, which is the returning
creator's path. A creator who has *just* enrolled does not take it, because
enrolment already is a face check: the enrol workflow runs `LIVENESS` and
`FACE_MATCH` against the document, and `didit.js` only reports `verified` when
both features passed. Requiring a selfie thirty seconds later asks for strictly
weaker evidence than the kind just collected — the same reasoning as the
one-round-trip destination above, applied one step earlier.

So `POST /enrol/complete` returns `unlockToken` alongside the verdict, and the
client stores it exactly as it stores the one from a face check. A creator who
enrolled at registration therefore reaches their first broadcast without a
second selfie — the enrolment was the check, and it was a stronger one.

Two constraints on that, both tested:

* **Only the call that resolves the verdict mints one.** The verification row is
  read before the provider is polled; if it was already `verified`, this is a
  replay and gets nothing. Without that, anyone holding the session cookie could
  re-poll for a fresh unlock whenever the old one expired and never face a check
  again.
* **The unlock has no `challenge_id`.** There is no challenge row to point at.
  `creator_portal_unlocks.challenge_id` is nullable for exactly this, and a
  null there means "enrolment opened it" in the audit trail.

None of this weakens the returning-creator check. A new tab tomorrow has no
token, no verdict to resolve, and gets the selfie.

---

## Authorising a second device

`POST /broadcast/challenge` and its pair still exist: the phone raises a
challenge, shows a four-character code, and the browser approves it.

```
 phone                        server                         browser
   │                            │                               │
   │ POST /broadcast/challenge  │                               │
   ├───────────────────────────►│  pending, code "K7QF"         │
   │◄───────────────────────────┤                               │
   │  shows "K7QF"              │      GET /status (poll)       │
   │                            │◄──────────────────────────────┤
   │                            ├──────────────────────────────►│
   │                            │   challenge + code "K7QF"     │  shows "K7QF"
   │                            │                               │
   │                            │  POST /challenges/:id/face-check {code}
   │                            │◄──────────────────────────────┤
   │                            ├──────────────────────────────►│  runs provider flow
   │                            │   inquiry + client token      │
   │                            │                               │
   │                            │  POST /challenges/:id/complete│
   │                            │◄──────────────────────────────┤
   │  GET /broadcast/challenge/:id   (server asks the provider) │
   ├───────────────────────────►│                               │
   │◄───────────────────────────┤  approved → grant (once)      │
   │  HELLO { key: grant }      │                               │
   ├───────────────────────────►│  ingest, attributed to userId │
```

Nothing in the shipped product calls it — the capture app has no account and
therefore cannot raise a challenge. It is kept because authorising a device that
is not the one you are sitting at is a real need, and because the four-character
code below is the part of the design worth not losing.

### The four-character code

The code is shown on the phone **and** in the browser, and the creator compares
them. It is the only part of the flow that is not otherwise load-bearing, and
removing it breaks everything else:

Without it, anyone holding the creator's password signs in from their own phone,
and the real creator — looking at a browser prompt that says only "confirm your
face to start broadcasting" — approves the attacker's session with their own
face. The face check passes. It was the right face. It authorised the wrong
device.

A wrong code does not offer another attempt. The innocent explanation is a typo;
the other one is that the prompt belongs to someone else's phone, and the safe
reading of an ambiguous signal here is to kill the challenge and make the real
device start again. The alphabet excludes `O/0`, `I/1`, `S/5`, `B/8` and `Z/2`,
because this gets read off a phone screen by someone holding a camera rig.

### Verdicts come from the provider

Every result is fetched server-side. `POST /challenges/:id/complete` means "I
finished the flow" — a prompt to go and ask, not a result. A client that could
report its own verdict would need only to report a good one.

Likewise the inquiry id to check comes from our own row, never from the request
body: a client that could name the inquiry could name somebody else's successful
one.

---

## Broadcast grants

A grant is what the phone puts in `HELLO.key` instead of the shared stream key.

The shared `AVR_LIVE_KEY` identifies *nobody*. Every phone presents the same
secret, so a live session cannot be attributed to a creator, and revoking one
device means re-pairing all of them. It stays the default because a fresh
checkout has no accounts and no provider, and a pairing flow that cannot work
out of the box is one nobody sets up.

A grant, by contrast, is:

- **per-creator** — the ingest session carries `userId` and `grantId`, so "who
  is on air" has an answer
- **single-use** — spent at HELLO, not at disconnect. A credential retired only
  on a clean close is replayable by anyone who can make the first attempt fail
- **short-lived** — `AVR_GRANT_TTL`, five minutes by default, whether or not it
  is ever presented
- **resumable for a moment** — presentable for `AVR_GRANT_RESUME` seconds after
  first use, measured from consumption and never refreshed, so a dropped frame
  does not end a broadcast the creator verified their face to start
- **hash-stored** — SHA-256 only, like refresh tokens; a stolen database yields
  no working credential
- **revocable in bulk** — when a challenge is denied, a creator signs out
  everywhere, a verification lapses, or consent is withdrawn

Set `AVR_IDENTITY_ENFORCE=1` to refuse anything else. The server will not start
with enforcement on and the mock provider selected: the mock approves every face
and every document, and an adult platform that believes it is checking documents
and is not is the worst available failure.

### A grant can also carry who it is for

If the creator picked somebody off the waiting list before minting, the grant is
bound to a **room**: one creator, one viewer, one broadcast. Pairing it to the
grant rather than to the link is the whole trick — the destination link stays a
plain `avr://pair?…` string, so nothing about "who is watching" is expressed in
the QR code or known to the capture app.

The sequence differs slightly between the two paths, because one of them has a
provider round trip in the middle:

| | Unlocked session | Face-check path |
| --- | --- | --- |
| The room is reserved | before the grant is minted | against the challenge |
| The grant is bound | two lines later, same request | at `/complete` |
| Found again by | nothing — it never needs a lookup | `challenge_id` |

A room is reserved by `viewerId` in the request body, and a creator reserving a
second one supersedes their first — two open invitations from one creator would
mean the next phone to connect could land in either. `POST
/broadcast/challenge/:id/cancel` closes the room with the challenge.

Two things a reader of this file should know about the privacy trade:

- **Creators see the display names of people waiting.** That is the feature —
  you cannot pick a person off a list of opaque ids — but it is other people's
  data on a screen, so the list carries a display name and a coarse device
  string (`"Apple Vision Pro"`, `"iPhone · Safari"`) and nothing else. No email,
  no IP, no raw user agent.
- **Nothing about a room is persisted.** No table, no schema change, no
  retention sweep to write. It is in-memory state in `server/live/rooms.js` and
  it dies with the process, which is also true of the broadcast it describes.

[LIVE.md](LIVE.md) has the shape of the waiting room and the admission check.

### Why not a durable key

This was briefly a `broadcast_keys` row instead: an API key, named, listed in
the portal, valid until revoked. That is the conventional design for a stream
credential and it is the wrong one here, for one reason that outweighs its
convenience.

A durable key moves the face check to *issuance*. The question this platform
has to answer is not "did this account verify once" but "is the verified person
the one about to go live", and only a credential minted per broadcast asks it at
the moment it matters. Everything else follows from that:

- **A ceiling on the damage.** A grant lifted off the wire is stale within
  minutes whether or not anyone notices. A durable key is stale when somebody
  notices.
- **Nothing to forget.** The retention sweep deletes expired grants because
  there is an expiry to sweep. A key nobody revokes stays live indefinitely, and
  the portal list that would surface it only helps a creator who looks.
- **A safe thing to put on a screen.** The portal now displays the link as a QR
  code, which is a bearer credential rendered at camera range of anyone in the
  room. That is defensible for a single-use credential that dies in five
  minutes and is close to indefensible for one that does not.

The cost is real and is paid by the creator: a browser has to be in reach every
time, including when a broadcast drops and has to be restarted. The resume
window covers the second case, and scanning covers the first — the QR code
replaced a copy-paste, so the five-minute window is generous rather than tight.

---

## Provider

**Didit**, chosen because one vendor covers both halves. A KYC session runs the
document forensics and the enrolment selfie; a later Biometric Authentication
session for the same person is a face check against what they already hold. The
alternative — a document vendor plus a separate face vendor — requires somebody
to hold the enrolment face to bridge them, and the only candidate for "somebody"
is us.

Three workflows must exist in the Didit console:

```
AVR_DIDIT_ENROL_WORKFLOW_ID       OCR + liveness + face match
AVR_DIDIT_FACEAUTH_WORKFLOW_ID    liveness + face match, no document
AVR_DIDIT_AGE_WORKFLOW_ID         OCR only — no selfie, no liveness
```

The age workflow **must not** capture a selfie. It is the one every viewer
passes, and a workflow that quietly collects a face turns a document check for
the whole user base into biometric collection for the whole user base. None of
Didit's stock workflows qualifies — all of them bundle liveness and face match —
so this one is built by hand with `features: [{"feature": "OCR"}]` and nothing
else. If it is ever unset the age check refuses with `identity_not_configured`
rather than borrowing the KYC workflow.

Two console settings, `is_document_selfie_portrait_match_enabled` and
`face_search_enabled`, default to true and cannot be changed through the v3
workflow API, which accepts only a short whitelist of fields. They are inert
here, and that was checked rather than assumed: the authoritative statement of
what a workflow will actually run is the `features` array on a session created
against it.

```
age workflow   → ["ID_VERIFICATION"]
Free KYC       → ["ID_VERIFICATION", "LIVENESS", "FACE_MATCH", "IP_ANALYSIS"]
```

Both settings govern what happens to a face once one has been captured, and no
feature in this workflow captures one. **Re-run that check** if the workflow is
ever edited in the console — it is the one assertion standing between an age
gate and biometric collection across the entire user base.

`AGE_ESTIMATION` is also on Didit's feature list. Do not use it: it infers age
from a face, which is the exact collection this workflow exists to avoid.

### `vendor_data` is the whole mechanism

Every session carries our user id as `vendor_data`. It does three jobs at once:
it ties a Didit-side investigation back to an account without us sending a name
or an email, it is how a face check finds the face enrolled earlier, and it is
the key `POST /v3/users/delete/` accepts for erasure.

A Biometric Authentication session sent **without** `portrait_image` resolves
its reference face by looking up whatever is already on file for that same
string — an approved liveness capture, then an ePassport chip photo, then the ID
document portrait. So the reference face is held by Didit and addressed by an id
that is meaningless outside our database. Sending `portrait_image` would mean
this server was holding the enrolment face, which is the arrangement the whole
integration exists to avoid; `test/didit.test.js` asserts that it never does.

That also makes `vendor_data` the `provider_subject_id` in the sense the
provider interface means — the provider's stable handle for this person. It is
our own user id rather than an opaque id minted by Didit, because with Didit
there is no other handle that both the face lookup and the erasure endpoint
accept. It is read back out of the decision rather than assumed, so a session
created against some other `vendor_data` cannot be collected as this user's
enrolment.

**Do not enable biometric template retention** in the Didit console. It keeps
face embeddings after a session is deleted, and Didit's own documentation is
blunt that this "is biometric data. It is not anonymous, it is not transient,
and it is not deleted with the session." The default, `delete_with_session`, is
the one that matches what `CONSENT_TEXT` promises.

### When the reference face is gone

Didit refuses to create a face-check session at all when it holds no face for a
`vendor_data`, with `400` and a `portrait_image` error. The adapter tags that as
`no_reference_face`, and `routes.js` answers it by expiring the verification,
revoking any outstanding grants and unlocks, and returning
`409 reenrolment_required`.

Expiring the row is the point. Our record says they enrolled; the provider says
there is nothing to compare a selfie against, so the record is a claim nobody
can check and it must stop authorising broadcasts. It is also the only exit — a
creator in this state can never pass a face check, and leaving the verification
in place would park them in front of a gate with no key. The portal offers
enrolment rather than a retry, and does not phrase it as a failed match: they
did nothing wrong.

The rest of the configuration:

```
AVR_GRANT_TTL            seconds a minted grant lasts       default 300
AVR_GRANT_RESUME         seconds to resume after first use  default 90
AVR_AGE_ASSURANCE_DAYS   how long an age check stands       default 730
AVR_PORTAL_UNLOCK_TTL    seconds a portal unlock lasts      default 7200
```

`AVR_PORTAL_UNLOCK_TTL` is an upper bound, not the usual end: the token normally
dies with the browser session long before it expires.

`AVR_GRANT_RESUME` at zero is a defensible setting and a harsh one: it makes a
single lost Wi-Fi frame end a broadcast, because a grant is consumed before the
session exists.

An API key alone is enough to select a provider over the stub, so a deployment
can end up naming a real provider while none of the three workflows exist and
every hosted flow fails at the moment a person reaches it. The server lists the
missing variables at startup and refuses to start at all if enforcement is on.

Setting two providers' keys at once is refused rather than guessed at, and a
value of `AVR_IDENTITY_PROVIDER` that this server does not know is fatal. That
second one matters more than it looks: falling back to the stub on a typo would
approve every document and every face, report itself as working, and give no
indication anywhere that the name was not understood.

### The account has to allow it, not just the key

Every check here is a session the **server** creates, and that can be an
account-level permission rather than a property of the key. Persona is the
cautionary example: `inquiries.create.api` is not on by default on every plan,
and a key that reads inquiries and accounts perfectly well is still refused.

```
POST /inquiries → 403  inquiries.create.api is not enabled
```

No template id fixes that and neither does the code. It is why the server routes
`401` and `403` from any provider to the same gate as a missing workflow id —
see `failedToStart` in `routes.js` — rather than calling it an outage and
offering a retry that cannot succeed.

The alternative, if a deployment cannot get server-side creation enabled, is to
have the browser start the session and have the server confirm the verdict by
reading it back. It is **not** what is built: it would mean the client chooses
when a check begins, so the server would have to mint a nonce as the reference
id and accept only a session carrying it, or one account could claim another's
completed session.

`server/identity/mock.js` is a deterministic stand-in with the same interface.
It makes the paths a real provider makes awkward to reach on demand — a declined
document, a face that does not match, a check that never completes — testable,
and it is refused under enforcement.

### A verdict belongs to the provider that issued it

`verifications.isCurrent()` and `ageAssurances.isCurrent()` both require the
row's `provider` to match the provider in use now. Changing provider therefore
invalidates every verification and every age assurance, and `redeemBroadcastGrant`
re-checks the verification at HELLO so keys already in circulation stop working
too, rather than staying good until their own expiry.

That is deliberate and it is the expensive direction on purpose. The case it
exists for is a server that ran against the stub — which approves every document
and every face — and then moved to a real provider: without it, the deployment
inherits a set of permanently verified accounts that no identity provider has
ever seen. Everyone re-enrols, which is cheap next to being wrong about who
somebody is.

It also applies to the Persona → Didit move, and correctly. A Persona
verification records a face held at Persona; a Didit face check can only resolve
a face held at Didit. The row would be true about the past and useless for the
question actually being asked.

### Age fails closed

An inquiry that passed every document check but did not yield a birthdate has
not answered the one question this platform must be able to answer, so it is
treated as a rejection with reason `age could not be established`. The birthdate
itself is read to compute the boolean and discarded.

---

## Consent and retention

Consent is recorded in the same statement that opens the enrolment, and before
the provider is called: the regimes that permit this processing require consent
to *precede* collection, not accompany it.

The disclosure text is served by the server (`GET /api/identity/consent`) rather
than duplicated in the client, and both checks refuse any version but the
current one. There are two disclosures and two versions — `CONSENT_VERSION` for
enrolment and `AGE_CONSENT_VERSION` for the age check — because they describe
materially different processing, and an age disclosure that talks about face
templates would be describing something that does not happen. Bump either
whenever its text changes in substance; the people who agreed to the old wording
are re-prompted, because rewriting the text cannot retroactively re-label what
somebody agreed to.

### The two agreements are versioned the same way

Separate from the identity disclosures, and on the same principle. Every account
accepts the terms of use at registration; an account that will point a camera at
itself accepts a second, stricter publisher agreement — at registration if it
signed up as a creator, or at the moment it asks to become one. The wording is
served by the server (`GET /api/auth/agreements`) and acceptance is submitted as
a **version string**, never a boolean: a client that posts `true` has said
nothing about which text it showed. A stale version is refused rather than
quietly upgraded, so a signup page left open across a deployment is sent back
to read the new one.

They are kept apart so a viewer is never shown publisher obligations that do not
apply to them, and so an account that becomes a creator later is asked the
creator question *at that moment* rather than deemed to have answered it at
signup. `POST /api/auth/become-creator` refuses without it and hands back the
text to display. What an account currently holds is one row per kind in
`account_agreements`, readable back to it on `/api/auth/me`.

Editing `TERMS_TEXT` or `CREATOR_TERMS_TEXT` without bumping the version in
`server/auth/agreements.js` leaves existing accounts recorded as having accepted
wording they never saw. That is the one change in that file that must not be
made silently.

`DELETE /api/identity/me` withdraws consent: it asks the provider to redact
first, and only deletes our row if that succeeded. A stranded account is
recoverable; a stranded biometric with no remaining handle to it is not. It also
deletes the age assurance and revokes every portal unlock, so the next visit
starts from nothing.

`runIdentitySweep()` runs hourly on every node — idempotent, so no coordination
is needed. It expires lapsed verifications, times out abandoned challenges, and
prunes resolved challenges after 30 days. The append-only `identity_events`
table is what survives: a creator is entitled to know what was decided about
them and when, and the platform has to be able to show that a rejection was the
provider's conclusion rather than a moderator's opinion.

---

## Endpoints

All under `/api/identity`, all requiring a normal access token.

| Method | Path | Caller | Purpose |
| --- | --- | --- | --- |
| `GET` | `/consent` | either | Both disclosures — enrolment and age — with versions |
| `GET` | `/status` | browser | Verification, age, unlock state + any pending challenge |
| `POST` | `/age` | browser | Record consent, open the document-only inquiry |
| `POST` | `/age/complete` | browser | Fetch and apply the age verdict |
| `POST` | `/enrol` | browser | Record consent, open a provider inquiry |
| `POST` | `/enrol/complete` | browser | Fetch and apply the enrolment verdict; returns an unlock if it clears |
| `POST` | `/portal/unlock` | browser | Start the face check owed before going on air |
| `POST` | `/portal/unlock/:id/complete` | browser | Fetch the verdict; returns the unlock token once |
| `POST` | `/broadcast/destination` | browser | The pasteable URL; one round trip when unlocked. Optional `viewerId` opens a room. |
| `POST` | `/broadcast/destination/:id/complete` | browser | Fetch the verdict and the URL, when not |
| `POST` | `/broadcast/challenge` | phone | Raise a sign-in challenge, get the code |
| `GET` | `/broadcast/challenge/:id` | phone | Poll; returns the grant once approved |
| `POST` | `/broadcast/challenge/:id/cancel` | phone | Abandon the sign-in |
| `POST` | `/challenges/:id/face-check` | browser | Check the code, start the face flow |
| `POST` | `/challenges/:id/complete` | browser | Fetch and apply the face verdict |
| `POST` | `/challenges/:id/deny` | browser | "That is not me" — also revokes outstanding grants |
| `DELETE` | `/me` | browser | Withdraw consent, redact at the provider |
| `GET` | `/events` | browser | The creator's own audit trail |

A challenge that is not yours returns **404**, not 403, so challenge ids cannot
be probed for existence. A room that is not yours does the same, on
`GET /api/live/rooms/:id`.

Choosing a viewer who has since closed their page returns **409**
(`viewer_gone`), before the provider is called — a face check spent on a room
that can no longer be opened is a face check wasted.

---

## Known gaps

- **`/media` and `/stream` are not age-gated.** Under `AVR_IDENTITY_ENFORCE=1`
  the catalogue is, so nothing is *discoverable* without an age check — but
  anyone holding a media URL can still fetch it. Closing that means signed
  delivery URLs, which is a different change to a different subsystem, and
  saying "the platform is age-gated" before it lands would be untrue. The
  catalogue is served `private, no-store` under enforcement, because a shared
  cache in front of it would hand one adult's pass to everyone behind it.
- **Webhooks.** `verifyPersonaSignature()` exists and is tested, but no webhook
  route is mounted, and nothing equivalent is written for Didit — sessions are
  polled. Polling covers the flow today; a webhook would remove the poll and
  handle verdicts that arrive after the creator has closed the tab. Didit's
  session payload takes a `callback`, so this is available when wanted.
- **Sanctions and PEP screening**, which an adult platform taking payments will
  eventually need. Didit has it: the "KYC + AML" workflow
  (`6b0a7415-…`) is the same enrolment flow with AML added, so this is a
  workflow id change rather than an integration.
- **Admin review.** A creator rejected by the provider has no appeal path.
