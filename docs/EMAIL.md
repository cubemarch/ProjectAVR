# Email

What the server sends, who can turn it off, and why the answer to the second
question is not "all of it".

Nothing here is a mailing list product. There is one entry point, `notify`, a
catalogue of templates, and a delivery log. The interesting decisions are about
consent and about who enforces it.

## The three categories

Every template declares one, next to its wording, in
[`server/mail/templates.js`](../server/mail/templates.js).

| Category | What it is | Optional? |
| --- | --- | --- |
| **transactional** | The account asked for this by doing the thing it reports: a receipt, the result of a check they started, the confirmation of a signup. | No |
| **security** | Something changed about who can get into the account. | No |
| **marketing** | Everything else. | Yes, and off until asked for |

The line between the first and the third is the one that gets blurred in
practice, so it is worth stating plainly: a message is transactional because
the person caused it, not because it is timely. "Your favourite creator is
live" is marketing. So is "here is what you missed". Filing either under
transactional to escape the opt-in is the failure this taxonomy exists to make
visible, and the category sits in the template so that the decision is made
once, in the open, rather than at each call site.

Security mail is never optional for a different reason. Its whole value is that
it arrives when the person who caused the change would rather it did not — a
"you were signed out everywhere" notice that respects a preference is a notice
that an attacker can switch off.

The regimes that matter (CAN-SPAM, GDPR, PECR) all carve transactional messages
out of consent requirements precisely on this basis, so the split is not only
good manners.

## Who enforces the opt-in

`suppressedBecause` in [`server/mail/index.js`](../server/mail/index.js), and
nothing else. It reads the category the template declared and the account's
`marketing_emails` column, and no caller is asked to remember anything.

That is deliberate. The realistic way a system like this sends marketing to
somebody who refused it is not a broken checkbox, it is a new call site added
six months later by someone who did not know there was a rule. A check at the
one place every message passes through cannot be forgotten by a call site that
does not know it exists.

The same reasoning is why `emailMessages.marketingAudience()` puts the opt-in
in its `WHERE` rather than returning everybody for the caller to filter.

## The delivery log

Every attempt is written to `email_messages`, including the ones that never
went anywhere:

| status | meaning |
| --- | --- |
| `queued` | handed to the transport, not yet answered |
| `sent` | the transport accepted it, and `provider_ref` finds it in their logs |
| `failed` | the transport refused it; `detail` says what it said |
| `suppressed` | it was never offered to the transport; `detail` says why |

The suppressed rows are the interesting ones. "We never sent you that" and "we
have no idea whether we sent you that" are different answers to a complaint,
and only the first one is available if the suppressions are not recorded.

**The body is never stored.** The subject is, because it is what identifies a
message in a conversation with a person who received it; the contents of a
receipt or an identity result in the application database, duplicated from the
mail the person already has, would be a second copy of something to protect for
no benefit. The transport's error text is recorded, the message that produced
it is not.

`user_id` is `ON DELETE SET NULL` while `recipient` is kept, so the
acknowledgement of a deletion request survives the deletion it acknowledges.

## Sending is not part of the request

`notify` is fire-and-forget: it never throws, never rejects, and callers do not
`await` it. An account whose welcome email bounced is still an account, and a
500 on `POST /api/auth/register` because a mail API was briefly down would be a
far worse outcome than a missing email. The failure is still visible afterwards
— that is what the log is for.

`drainMail()` waits for the in-flight sends. Shutdown uses it; so do the tests,
which assert on the log rather than on the transport.

## Transports

Same arrangement as identity and payments, for the same reasons:

- A stub (`log`) is the default. It delivers nothing, prints each message to
  the console, and says so loudly the first time it is used.
- An unrecognised `AVR_MAIL_PROVIDER` is **fatal at startup**, not a quiet
  fallback. A typo that silently resolved to the stub would stop every receipt
  and every security notice while the logs, the API and the delivery table all
  went on reporting success.
- A single provider key present selects that provider. Two keys is ambiguous
  and is refused rather than guessed at.

Three real transports ship. Two of them — Resend and Postmark — are plain JSON
over HTTPS through the global `fetch`. Mail is the classic place a project
acquires an SMTP library, a MIME builder and their dependency trees, and none
of that is needed to POST a small object to an HTTP API.

Postmark separates transactional and broadcast traffic onto different message
streams; `bulk` on the outbound message (set from the template's category)
picks which. Sending marketing down a transactional stream is how a sending
account gets suspended.

### Why there is an SMTP transport as well

Neither hosted transport may actually be used for this platform. This is
written down because "just use Resend" is the obvious suggestion and will
keep coming back otherwise: the obstacle is not technical, and no amount of
configuration gets around it. Sending through one anyway risks the account,
and with it every receipt and every password reset.

Every mainstream provider checked prohibits the content. Policies read
2026-10-10 and 2026-10-11:

| Provider | Where it says so |
| --- | --- |
| Resend | AUP, prohibited content |
| Postmark | ToS, prohibited content |
| Mailgun, SendGrid, Mailchimp | same clause by name |
| Brevo | Anti-Spam Policy §D.3, "We prohibit sexual content" |
| SMTP2GO | Terms, "Pornographic or adult content" — "even if 'opt-in'" |
| MailerSend | ToU, "Pornography", "Escort services" |
| Elastic Email | AUP, "pornographic, sexually explicit, or otherwise adult-oriented" |
| SMTP.com | T&C, "obscenity/sexually explicit", at their "sole discretion" |
| Mailjet (Sinch) | No explicit clause, but §2c covers anything "immoral… offensive and/or obscene" |

Mailjet is the instructive one: its only pornography clause concerns child
abuse material, so a keyword search suggests it is permitted. The catch-all
in §2c is what actually governs, and it is unbounded. Absence of an explicit
prohibition is not permission.

When assessing a new candidate, read for the *structure* of the policy rather
than searching it for one word. These documents generally have two lists: an
outright prohibition, and a longer list of sensitive industries allowed after
a vetting conversation. Brevo is the clearest example — "Dating services"
sits in the vetting list, while sexually explicit content sits in the
prohibited one, and its restrictions apply "whether using dedicated IP or
not". Finding adult-adjacent categories in the negotiable list says nothing
about this platform, and a dedicated IP does not buy an exception.

Amazon SES is the exception worth recording, because on the terms it is
*allowed* and the obvious objection is therefore wrong. The AWS Acceptable
Use Policy has no adult-content clause at all — its only sexual-content
provision concerns child sexual abuse material — and Service Terms §15 (SES)
adds none. The omission reads as deliberate: §11.6 bars "sexually explicit"
content and "adult services" for SNS, and the same drafters left it out of
SES.

SES is nevertheless not an option here, for a reason that has nothing to do
with content. Production access was refused on this AWS account on
2026-06-10, for a different and far easier product — plain transactional SaaS
mail, verified Easy DKIM, custom MAIL FROM domain, SPF, DMARC, suppression
lists and SNS event monitoring — with no reason given beyond "we identified
some concerns". Without production access SES is sandboxed to 200 messages a
day addressed only to pre-verified recipients, which cannot send a signup
verification to a new user. Re-applying for an adult platform, on an account
already refused once, would risk a second refusal and an explicit
adult-content disclosure against the account that also hosts unrelated
products.

So the third transport (`smtp`) speaks to a mail server we run. It keeps to
the same rule as the other two — [`server/mail/smtp.js`](../server/mail/smtp.js)
is written out rather than installed. What is needed is genuinely small: one
envelope, one recipient, two body parts, no attachments, no connection pool
and no queue, because the thing on the other end is the queue.

Two properties of it are deliberate and should survive editing:

- **It will not downgrade.** Asked for STARTTLS and offered a server that
  does not advertise it, it fails the send instead of continuing in clear. The
  traffic here is password resets and receipts.
- **It never puts a credential or a message body in an error.** Only the
  server's complaint and the verb that drew it, which is the same rule
  `postJson` follows for the HTTP transports.

`AVR_SMTP_HOST` on its own is enough to select it; port 587 means STARTTLS and
465 means implicit TLS without being told. `bulk` is ignored — one mail server
has one queue on one IP, and recording a distinction that does not exist on
the wire would only make the delivery log lie. The full variable list is in
[`.env.example`](../.env.example).

`AVR_PUBLIC_URL` is the one piece of configuration email cannot do without.
Every other part of the server learns its own address from the request in front
of it; an email has no request to read. Unset, links come out pointing at
localhost — wrong, but wrong in a way that is obvious in a test inbox rather
than silently half-working. See [`.env.example`](../.env.example) for the rest.

### Where that mail server is allowed to run

The content question recurs one level down: a mail server needs a host, and a
host has an acceptable use policy of its own. Read 2026-10-11:

| Host | Content | Outbound port 25 |
| --- | --- | --- |
| AWS | No adult clause in the AUP at all | Blocked by default, lifted on request |
| OVH, US entity | No adult clause; the prohibited list is harm-to-persons, closed with "otherwise objectionable" | **Open by default** on VPS and dedicated; blocked on Public Cloud |
| BuyVM / Frantech | "a Law of the Land stance when it comes to content" | Blocked by default, unblocked by ticket |
| Hetzner | T&C §8.2, may not publish "pornographic or obscene material" | — |
| Contabo | T&C, content published "does not contain any pornographic or obscene materials" | — |

Only OVH's US terms were read. Its European entities contract separately and
the German hosts' wording above is a fair warning that those may differ.

Three things are easy to get wrong here.

**Port 25 is operational policy, not contractual.** It lives in the
documentation rather than the terms, so reading a T&C tells you nothing about
it — all five contracts are silent. It has to be checked separately, and the
answer can differ *within* one provider: OVH leaves it open on a VPS and
closed on a Public Cloud instance.

**Hetzner and Contabo both prohibit _publishing_.** A smarthost relaying
password resets and receipts transmits; it publishes nothing, and what is
published sits on another provider entirely. That reading is arguable and may
well be right, but it is a reading, and an abuse complaint still puts an adult
platform in front of a reviewer who has to agree with it. Not a position to
put the password resets on.

**A permissive host is not automatically the right answer**, for the same
reason a permissive relay is not. Hosts that advertise tolerance collect the
traffic everyone else refused, and their address ranges get blocklisted to
match. A mail server's one asset is the reputation of its IP, so trading a
cold address you control for a tainted one you do not is not an improvement.
That is what makes OVH the interesting fallback and BuyVM much less so — the
same content answer, from ranges that are unremarkable.

## Unsubscribing

The link carries an HMAC over the account id, derived from `AVR_JWT_SECRET`.
No column, nothing to expire, nothing to leak, and rotating the secret
invalidates every outstanding link at once. It authorises exactly one action —
turning marketing off — and is not a session of any kind.

There is no sign-in. Somebody who has stopped wanting our email is the person
least willing to sign in to say so, and a link that demands a password before
it will honour an opt-out is how a list earns spam complaints instead of
unsubscribes.

**`GET /unsubscribe` does not unsubscribe.** It renders a page with one button;
`POST` is what acts. Every corporate mail gateway, link scanner and preview
generator fetches the URLs in a message before a human sees them, so a GET that
acted would unsubscribe people by way of their employer's virus scanner and
nobody would ever work out why the list was shrinking. That shape is also what
RFC 8058 one-click requires, so the `List-Unsubscribe-Post` header on the
message and the button on the page hit the same endpoint.

## Where the switch lives

Three places, all the same column:

- **The signup form** — an unticked checkbox. Only a literal `true` counts;
  a client that posts the string `"on"` has not told us which way the box was
  set, and the safe reading of "not clear" is not "yes".
- **Profile → You** — a checkbox with its own save button, deliberately not
  folded into "Save profile", so that editing a tagline cannot carry an opt-in
  along with it.
- **The unsubscribe link** — one direction only.

`GET /api/profile` reports it as `emails.marketing`. It is not on
`profileView`, because that shape is also how somebody else's profile is
returned, and what mail an account has agreed to receive is nobody else's
business.

## Adding a message

1. Add a template to `TEMPLATES` with an honest `category`.
2. Call `notify('your-kind', user, { ...whatever it needs })` from wherever the
   thing happened. Do not await it, and do not check anybody's preferences
   first — that is not your job and you will get it wrong.

The catalogue is meant to stay readable in one screen. It is the thing to open
when somebody asks why they received an email.
