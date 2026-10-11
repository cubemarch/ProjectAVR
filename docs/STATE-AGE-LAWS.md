# State age-verification law

Twenty-seven US states require a commercial operator to verify that a viewer is
an adult before showing them material harmful to minors. The rest require
nothing. LustXR does the minimum each state asks for and nothing beyond it: a
document check where one is required, and a single button everywhere else.

> **Reviewed 2026-10-07.** This document and `server/identity/state-laws.js`
> describe the position on that date and have not been confirmed by counsel.
> Statutes are amended, enjoined, and allowed to take effect on their own
> schedule, and nothing in this codebase notices when they do. Re-reviewing is
> a calendar item, not a code change. See [Keeping it current](#keeping-it-current).

---

## Two gates, not one

| Tier | Who gets it | What it is | Where it is recorded |
| --- | --- | --- | --- |
| `verified` | the twenty-seven | a document or records check at the identity provider | `age_assurances` |
| `attest` | everywhere else | one button: *I am 18 or over* | `age_attestations` |

Asking every viewer in the country for a government document would be
collecting one because we could rather than because we had to. Twenty-three
states and the District of Columbia have decided they do not want that trade,
and it is not this platform's place to overrule them. Equally, a button is not
verification, and in a state that requires verification it is worth nothing.

So the two are **separate tables with separate accessors**, and
`adultConfirmed()` — the function every other subsystem uses to mean "this is a
confirmed adult" — deliberately does not look at the attestation table at all.
The single worst failure this subsystem could have is a read that cannot tell
the two apart, because the reader that forgets is the one that admits a
self-declared adult to Texas.

---

## Which gate a request gets

Decided per request, in `server/identity/jurisdiction.js`:

```
resolveRegion(req)  →  policyFor(where)  →  ageGate(req)
   where from             tier, methods,       ok / owes, against
   the edge               statute, limits      what this account has done
```

### The region is resolved on every request

Not stored on the account. People travel, and the question "may this person see
this" has a different answer in Portland than in Dallas. An Oregon button press
must not carry into Texas, and a Texas document check should not be demanded
again of someone who has gone home. Storing a state on the user row would get
both of those wrong in the direction that matters.

The region comes from the edge, from whichever of these the deployment sets, in
this order:

| Edge | Country header | Region header |
| --- | --- | --- |
| Cloudflare | `cf-ipcountry` | `cf-region-code` |
| Vercel | `x-vercel-ip-country` | `x-vercel-ip-country-region` |
| CloudFront | `cloudfront-viewer-country` | `cloudfront-viewer-country-region` |
| any reverse proxy | `x-geo-country` | `x-geo-region` |

`XX` (Cloudflare's "no country for this address") and `T1` (its Tor marker) are
read as *unknown*, not as places. Anything that is not two letters is discarded.

These headers are trivially forgeable by a client that can reach this process
directly. **`AVR_TRUST_PROXY` must match the real number of hops and the origin
must not be reachable except through the edge**, or a viewer sets their own
state. This is the one operational requirement the gate cannot check for itself.

### Unresolvable means covered

| What resolved | Tier | Reason |
| --- | --- | --- |
| nothing at all | `verified` | `region-unresolved` |
| a country that is not `US` | `attest` | `outside-us` |
| `US`, no state | `verified` | `us-state-unresolved` |
| `US`, a state in the table | `verified` | `statute` |
| `US`, a state or territory not in it | `attest` | `no-statute` |

Failing closed is the only safe direction here. Guessing "no statute" wrongly
serves adult material to a Texan with no check; guessing "covered" wrongly asks
a Californian for a document they did not legally have to show. One of those is
a lawsuit and the other is friction.

`AVR_GEO_FALLBACK=attest` inverts the two fallback rows, for a deployment that
genuinely has no geolocation in front of it and has decided knowingly to accept
that. It is never the default and the boot banner says so out loud. It does not
affect a state that *did* resolve — the setting says what to do when we do not
know, not what to do when we do.

**Cloudflare does not send a region by default.** `cf-ipcountry` arrives out of
the box; `cf-region-code` needs a Transform Rule adding it. Without one, every
US viewer lands on `us-state-unresolved` and is asked for a document — correct,
but it means twenty-four states are being over-checked and nobody will report it
as a bug.

### Non-US traffic

Gets the button, and **no non-US regime is modelled here**. The UK Online Safety
Act, France's Arcom rules and the German JMStV each impose their own duties that
this code does not implement. `AVR_AGE_NON_US=verify` is a blunt instrument for a
deployment that would rather over-check than serve a button into one of them; it
is not an implementation of any of those regimes.

---

## The twenty-seven

Methods are the coarse families in `METHODS`, not each statute's own wording:
**Digital ID** (a mobile credential), **Government ID** (a document photo,
checked commercially), **Records** (a commercial-database lookup), **Photo+ID**
(a contemporaneous photograph matched to a state ID), **Card/bank** (an
instrument only an adult may hold), **Anonymous** (an independent third party
that reports only yes or no).

| State | Citation | Methods | Special |
| --- | --- | --- | --- |
| Alabama | 2024 Ala. HB 164 | Gov ID, Digital ID, Records | technology-neutral |
| Arizona | Ariz. Rev. Stat. § 18-701 | Digital ID, Gov ID, Records | **no retention, no transmission to government** |
| Arkansas | 2023 Ark. Act 612 | Digital ID, Gov ID, Records | **NIST IAL2** |
| Florida | Fla. Stat. § 501.1737 | Gov ID, Digital ID, Records, **Anonymous** | **viewer must be offered the choice** |
| Georgia | 2024 Ga. SB 351 | Digital ID, Gov ID, Records | **NIST IAL2** |
| Idaho | 2024 Idaho H 498 | Digital ID, Gov ID, Records | |
| Indiana | Ind. Code § 24-4-23-7 | Digital ID, Records | third party required |
| Iowa | 2025 Iowa HF 864 | Digital ID, Records | AG may approve further methods |
| Kansas | 2024 Kan. SB 394 | Records | AG approval for anything else |
| Kentucky | *(see source)* | Gov ID, Records | |
| Louisiana | La. Rev. Stat. § 9:2800.28 | Digital ID, Gov ID, Records | the original; most others copy it |
| Mississippi | Miss. Code Ann. § 11-77-3 | Digital ID, Gov ID, Records | |
| Missouri | Mo. Rev. Stat. § 407.3405 | Digital ID, Gov ID, Records | third party required |
| Montana | *(see source)* | Digital ID, Gov ID, Records | |
| Nebraska | Neb. Rev. Stat. § 87-1002 | Digital ID, Gov ID, Records, Card/bank | |
| North Carolina | N.C. Gen. Stat. ch. 66, art. 51 | Records, Gov ID | |
| North Dakota | N.D. Cent. Code ch. 51-07 | Digital ID, Gov ID, Records | |
| Ohio | Ohio Rev. Code § 1349.10 | Gov ID, Records | geolocation duties; significant exemption |
| Oklahoma | Okla. Stat. tit. 15 | Digital ID, Records | third party required |
| South Carolina | S.C. Code Ann. tit. 37, ch. 1 | Digital ID, Records | third party required |
| South Dakota | S.D. Codified Laws ch. 22-24 | Gov ID, Card/bank, Records | |
| Tennessee | Tenn. Code Ann. § 39-17-912 | Photo+ID, Records | **verified session ≤ 60 minutes** |
| Texas | Tex. Civ. Prac. & Rem. Code ch. 129B | Digital ID, Gov ID, Records | |
| Utah | Utah Code Ann. § 78B-3-1001 | Digital ID, Records | third party required |
| Virginia | Va. Code Ann. § 8.01-40.5 | Records, Gov ID | |
| West Virginia | W. Va. Code § 49A-1-102 | Digital ID, Gov ID, Records | |
| Wyoming | Wyo. Stat. Ann. tit. 14 | Gov ID, Card/bank, Records | |

Source URLs are in `server/identity/state-laws.js`, one per row. **The linked
statute is authoritative and the citation is informational.** Kentucky and
Montana carry no citation because their published source does not make the code
section unambiguous, and a wrong citation in a compliance file is worse than an
absent one — it reads as having been checked.

### Why the methods list does not re-classify a passed check

Our provider runs one document or records check and returns one verdict. Every
one of these statutes accommodates a commercially reasonable third-party
document or records check under one name or another, so asking the code to
decide, after the fact, whether a given pass was a "digitized identification
card" or a "transactional record" would be theatre: the provider returns the
same thing either way.

The `methods` list therefore drives **what the viewer is offered** and what this
document claims we accept. It is not a post-hoc bucketing of results. The one
place it is load-bearing in the flow is Florida, below.

---

## The three states that need more than a check

### Florida — the viewer chooses

§ 501.1737 requires that a standard *and* an anonymous route both be **offered**
and that the viewer pick between them. Anonymous means the check runs at a
qualifying independent third party subject to the statute's privacy protections.
Offering only one of the two is a violation even if that one is the stronger
check.

So `POST /api/identity/age` refuses with **400 `choose_verification_method`**
when the policy requires a choice and the request did not make one. Defaulting
a method on the viewer's behalf would satisfy the letter of "we offered two" and
none of its purpose. The refusal carries the policy, so the browser can render
the chooser from the same data that caused the refusal.

**Operator obligation:** set `AVR_DIDIT_AGE_ANON_WORKFLOW_ID` (or
`AVR_PERSONA_AGE_ANON_TEMPLATE_ID`) to a workflow that actually runs at a
qualifying third party. Leave it unset and a viewer who picks anonymous is run
through the standard workflow instead — the server logs a warning, but the
warning is the only thing that distinguishes that from compliance.

### Tennessee — the hour

The Protect Tennessee Minors Act caps a verified session at sixty minutes.
This is the only recency rule among the twenty-seven, and it is the reason a
policy carries `sessionMinutes` at all rather than a Tennessee branch.

`assuranceSatisfies()` enforces it generically: a current two-year assurance
whose hour has run out is not a reason to skip the check, it is the reason to
run it again. `POST /api/identity/age` consults `ageGate()` rather than
`ageAssurances.isCurrent()` for exactly this — otherwise a Tennessee viewer
whose hour had lapsed would be told "already verified" and never re-checked.

The same assurance remains perfectly good in Texas. The hour belongs to the
state, not to the row.

### Arizona — nothing kept

§ 18-701 forbids retaining identifying information and forbids transmitting it
to any government entity. This is the strictest retention rule of the
twenty-seven, and the architecture already satisfies it: the provider returns a
boolean and a document country, no face or document image ever crosses back,
and nothing is forwarded anywhere. See `docs/IDENTITY.md`, *The one rule*.

### Arkansas and Georgia — IAL2

Both require that a commercially reasonable method meet or exceed NIST Identity
Assurance Level 2. **This is a provider configuration obligation, not a code
one.** Nothing in this repository can assert IAL2; confirm it against the
workflow you have configured before claiming these two states.

---

## What is recorded

`age_assurances` gains two columns:

- **`method`** — which route the viewer picked. Load-bearing only for Florida,
  where being able to show that the viewer chose is the point; informational
  everywhere else.
- **`jurisdiction`** — where they were when they were checked. Audit only: the
  gate re-resolves on every request and never reads this back.

`age_attestations` is one row per account: the region, the country, how the
region was resolved, the wording version, the timestamp, the IP, and an expiry.
`AVR_AGE_ATTESTATION_DAYS` (365) governs the expiry — shorter than an
assurance's two years on purpose, because it is worth much less and re-asking is
free.

The attestation wording is versioned (`ATTESTATION_VERSION`) and served by the
server, like the other two disclosures. `POST /api/identity/attest` refuses any
version but the current one: rewriting the sentence later must not silently
re-label what somebody clicked.

`DELETE /api/identity/me` deletes the attestation along with everything else.

---

## Endpoints and responses

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/identity/jurisdiction` | none | The policy for this request: tier, state, citation, statute URL, methods, and the attestation wording where one applies |
| `POST` | `/api/identity/attest` | yes | Record a button press. **403** where a statute requires a check |

`/jurisdiction` is served `private, no-store`. One cached copy served to the
next viewer is how a Texan gets Oregon's gate.

Every response that establishes a session — `register`, `login`, `refresh`,
`/api/auth/me`, `/api/identity/status` — carries two more fields:

```jsonc
"jurisdiction": { "tier": "verified", "state": "Tennessee", "sessionMinutes": 60, … },
"ageGate":      { "ok": false, "owes": "verification", "reason": "session_expired",
                  "sessionExpiresAt": "2026-10-07T14:03:11.000Z" }
```

A gated route answers **403** with one of two error codes, and they want
opposite things from the client:

| Code | Client should |
| --- | --- |
| `age_assurance_required` | send the viewer to the provider |
| `age_attestation_required` | show the button |

A client that treated them as the same thing would send a Californian to a
provider, which is the over-collection this whole design exists to avoid.

---

## What this does not do

- **VPNs are not modelled.** A viewer who routes through another state gets that
  state's gate. Every operator under these statutes has the same problem; the
  statutes ask for commercially reasonable methods, not for defeating
  deliberate evasion.
- **Non-US regimes are not implemented.** See above.
- **`/media` and `/stream` are still not gated.** The catalogue is, under
  `AVR_IDENTITY_ENFORCE=1`, so nothing is discoverable — but anyone holding a
  media URL can fetch it. This predates the jurisdiction work and is tracked in
  `docs/IDENTITY.md`, *Known gaps*.
- **Nothing here is legal advice,** and none of it has been reviewed by counsel.

---

## Keeping it current

`server/identity/state-laws.js` is deliberately a table with no imports, no
calls, and no decisions in it, so that someone who does not read JavaScript can
check it. A state that needs a special case needs a **field** there, read by a
general rule in `jurisdiction.js` — never a branch on a state code in a route
handler. There are twenty-seven of these and there will be more.

To add a state: add the entry, and if it needs behaviour nothing else has, add
a field and teach `policyFor`/`assuranceSatisfies` to read it. `test/jurisdiction.test.js`
asserts the count, that every method id is renderable, that every entry has a
source URL, and that Florida and Tennessee are still the only states claiming
their respective special rules — so a new entry that quietly claims one will
fail the suite rather than change behaviour unnoticed.

When the table is re-reviewed, move the date in this file's header **and** in
the header of `state-laws.js`. Both, because each is the one a different person
will read.
