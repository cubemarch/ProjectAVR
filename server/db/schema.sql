-- ProjectAVR schema.
--
-- Every table here is read far more than it is written, and nothing in the app
-- tier caches user state in process memory, so any number of app nodes can sit
-- in front of this database without coordinating with each other.

PRAGMA journal_mode = WAL;      -- readers never block on the writer
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;    -- WAL makes full fsync-per-commit unnecessary

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,

    -- 'viewer' | 'creator' | 'admin'
    role            TEXT NOT NULL DEFAULT 'viewer',

    -- Opaque per-user token embedded in the DeoVR/Play'a feed URL. Those
    -- players have no login flow, so the URL itself has to carry identity.
    feed_token      TEXT NOT NULL UNIQUE,

    disabled        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- Refresh tokens are stored (hashed) so sessions can be revoked. Access tokens
-- are stateless JWTs and deliberately are not stored - that is what keeps the
-- hot auth path from touching the database at all.
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TEXT NOT NULL,
    revoked_at      TEXT,
    user_agent      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS titles (
    id              TEXT PRIMARY KEY,
    creator_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    slug            TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    synopsis        TEXT,
    genre           TEXT,
    studio          TEXT,
    year            INTEGER,

    -- Playback layout. Mirrors src/catalog/media-format.js exactly.
    projection      TEXT NOT NULL DEFAULT 'flat',
    stereo          TEXT NOT NULL DEFAULT 'mono',
    fisheye_fov     INTEGER,
    lens            TEXT,

    duration        REAL NOT NULL DEFAULT 0,
    width           INTEGER,
    height          INTEGER,
    size_bytes      INTEGER,

    -- Pipeline state, distinct from `visibility`:
    -- 'draft' | 'uploading' | 'processing' | 'ready' | 'published' | 'failed'
    status          TEXT NOT NULL DEFAULT 'draft',
    status_detail   TEXT,

    -- 'public' | 'unlisted' | 'private'
    visibility      TEXT NOT NULL DEFAULT 'private',

    -- Storage keys, not URLs. URLs are minted per request so they can be
    -- signed, expiring, and pointed at whichever CDN edge is in front today.
    source_key      TEXT,
    hls_key         TEXT,
    poster_key      TEXT,
    backdrop_key    TEXT,

    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    published_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_titles_creator ON titles (creator_id);
CREATE INDEX IF NOT EXISTS idx_titles_browse ON titles (status, visibility, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_titles_projection ON titles (projection, stereo);

-- Resume position. One row per viewer per title; the browse UI reads these in
-- a single query rather than one per card.
CREATE TABLE IF NOT EXISTS watch_progress (
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title_id        TEXT NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
    position        REAL NOT NULL DEFAULT 0,
    completed       INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, title_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_user ON watch_progress (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS my_list (
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title_id        TEXT NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, title_id)
);

-- Append-only view log. Rolled up into per-title counters by a periodic job so
-- the creator dashboard never scans the raw table.
CREATE TABLE IF NOT EXISTS view_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title_id        TEXT NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
    user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
    seconds_watched REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_views_title_day ON view_events (title_id, created_at);

CREATE TABLE IF NOT EXISTS title_stats (
    title_id        TEXT PRIMARY KEY REFERENCES titles (id) ON DELETE CASCADE,
    views           INTEGER NOT NULL DEFAULT 0,
    seconds_watched REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracks an in-flight upload so a resumed or abandoned transfer can be
-- reconciled without leaving an orphaned title behind.
CREATE TABLE IF NOT EXISTS uploads (
    id              TEXT PRIMARY KEY,
    title_id        TEXT NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
    creator_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    storage_key     TEXT NOT NULL,
    original_name   TEXT,
    bytes_expected  INTEGER,
    bytes_received  INTEGER NOT NULL DEFAULT 0,

    -- 'pending' | 'complete' | 'aborted'
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_uploads_creator ON uploads (creator_id, status);

/* ------------------------------------------------------ identity verification -- */
--
-- Creators are identity-checked against a government document and a live face
-- before they may broadcast, and face-checked again each time they sign in from
-- the capture app.
--
-- READ THIS BEFORE ADDING A COLUMN.
--
-- Not one of these tables stores a biometric identifier. No face image, no
-- template, no embedding, no document scan. Everything below is either an
-- opaque reference issued by the verification provider, or non-biometric
-- metadata about a decision that was made elsewhere. That is a deliberate
-- design constraint, not an omission:
--
--   * Illinois BIPA attaches a private right of action and statutory damages
--     per violation to *possessing* a biometric identifier. Not possessing one
--     is the only reliable way to be outside it.
--   * GDPR Article 9 treats biometrics used for identification as special
--     category data, with a correspondingly heavy processing regime.
--   * A database breach here leaks reference strings that are worthless
--     without the provider's credentials, rather than the faces of every
--     creator on the platform.
--
-- If a face ever needs to be compared, it is sent to the provider and the
-- provider answers. We store the answer.

CREATE TABLE IF NOT EXISTS creator_verifications (
    user_id             TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

    -- 'persona' | 'mock'. Recorded per row so a provider migration can run
    -- incrementally instead of invalidating everyone at once.
    provider            TEXT NOT NULL,

    -- The provider's handle for this person. Opaque to us, and the only thing
    -- that makes a later face check possible.
    provider_subject_id TEXT,

    -- The enrolment attempt itself, kept for support and dispute handling.
    provider_inquiry_id TEXT,

    -- 'unstarted' | 'pending' | 'verified' | 'rejected' | 'expired'
    status              TEXT NOT NULL DEFAULT 'unstarted',
    decline_reason      TEXT,

    -- Non-biometric facts about the document, for audit and for jurisdictions
    -- that require knowing which country's document was accepted.
    document_country    TEXT,
    document_type       TEXT,

    -- Age is stored as a *decision*, not a birth date: the only question the
    -- platform needs answered is whether they were over 18 at verification.
    -- A birth date would be personal data we have no other use for.
    adult_confirmed     INTEGER NOT NULL DEFAULT 0,

    -- BIPA and GDPR both require informed consent recorded *before* collection.
    -- The version pins which disclosure text they actually agreed to, so a
    -- later rewrite of that text cannot be applied retroactively.
    consent_version     TEXT,
    consent_at          TEXT,
    consent_ip          TEXT,

    verified_at         TEXT,

    -- Verification is not forever. A creator whose check has lapsed re-enrols.
    expires_at          TEXT,

    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verifications_status ON creator_verifications (status, expires_at);

-- A sign-in on the capture app, waiting for a face check in the creator's
-- browser.
--
-- The check deliberately does not happen on the phone. The browser already
-- holds an authenticated session the server issued, it is a better place to run
-- a camera flow than inside a capture app that is about to take over both
-- cameras, and it means the phone never handles a face at all.
CREATE TABLE IF NOT EXISTS broadcast_challenges (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- Four characters, shown on the phone and again in the browser.
    --
    -- This is not decoration. Without it, anyone who has the creator's password
    -- can start a challenge from their own phone, and the real creator - who is
    -- looking at a browser prompt that says only "verify your face to start
    -- broadcasting" - approves the attacker's session with their own face. The
    -- code is the only thing that lets them notice.
    code                TEXT NOT NULL,

    -- 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'
    status              TEXT NOT NULL DEFAULT 'pending',

    -- Shown in the browser prompt so the creator can see what they are
    -- approving. Self-reported by the phone and therefore untrusted; it is
    -- displayed, never acted on.
    device_label        TEXT,
    device_ip           TEXT,

    -- The provider's face-check reference for this attempt.
    provider_ref        TEXT,
    decline_reason      TEXT,

    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    resolved_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_challenges_user ON broadcast_challenges (user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_expiry ON broadcast_challenges (expires_at);

-- What the phone actually broadcasts with, once a face check has passed.
--
-- This replaces the single shared `AVR_LIVE_KEY` for verified deployments. That
-- key identifies nobody: every phone presents the same secret, so an ingest
-- session cannot be attributed to a creator, and revoking one phone means
-- re-pairing all of them. A grant is per-creator, short-lived, single-use, and
-- traceable to the face check that produced it.
--
-- There was a period where this was a durable `broadcast_keys` row instead - an
-- API key with no expiry, revoked by hand. That is the conventional design and
-- it is wrong for this credential: it moves the face check to enrolment time,
-- so the question it answers becomes "did this account verify once" rather than
-- "is the verified person the one about to go on air". The inconvenience of
-- re-earning a grant is the control. See docs/IDENTITY.md.
CREATE TABLE IF NOT EXISTS broadcast_grants (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    challenge_id        TEXT REFERENCES broadcast_challenges (id) ON DELETE SET NULL,

    -- SHA-256, never the raw token, on the same reasoning as refresh_tokens:
    -- a stolen database should not yield working credentials.
    token_hash          TEXT NOT NULL UNIQUE,

    expires_at          TEXT NOT NULL,

    -- Set when a broadcast actually starts with it. A grant is good for one
    -- session, so a token captured in flight cannot be replayed into a second.
    consumed_at         TEXT,
    revoked_at          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_grants_user ON broadcast_grants (user_id, expires_at);

-- Superseded by `broadcast_grants` above and no longer read or written.
--
-- Left in place rather than dropped because there is no migration system here:
-- schema.sql is replayed on every open and every statement in it is
-- CREATE ... IF NOT EXISTS, so a DROP would run against live databases on every
-- restart and take real rows with it. An empty table is the cheaper mistake.
--
-- Rows here, if a deployment has any, are durable stream keys from the period
-- described in the `broadcast_grants` comment. Nothing reads this table, so
-- they authorise nothing; a deployment that ran that build should still expect
-- them to be dead and not merely ignored, which they are.
CREATE TABLE IF NOT EXISTS broadcast_keys (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash          TEXT NOT NULL UNIQUE,
    label               TEXT NOT NULL,
    challenge_id        TEXT REFERENCES broadcast_challenges (id) ON DELETE SET NULL,
    last_used_at        TEXT,
    revoked_at          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only record of every identity decision.
--
-- Required in practice by every regime that permits this kind of processing at
-- all: a creator is entitled to know what was decided about them and when, and
-- a platform has to be able to show that a rejection was the provider's
-- conclusion rather than a moderator's opinion.
CREATE TABLE IF NOT EXISTS identity_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             TEXT REFERENCES users (id) ON DELETE CASCADE,

    -- 'consent' | 'enrolment_started' | 'enrolment_result' | 'verification_expired'
    -- | 'age_started' | 'age_result'
    -- | 'portal_unlock_started' | 'portal_unlock_result'
    -- | 'challenge_created' | 'challenge_result'
    -- | 'grant_issued' | 'grant_used' | 'grant_rejected'
    -- | 'purged'
    kind                TEXT NOT NULL,

    -- 'ok' | 'failed' | 'error'
    outcome             TEXT NOT NULL,

    provider_ref        TEXT,

    -- Free text for humans. Must never carry biometric data; see the note at
    -- the top of this section.
    detail              TEXT,

    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_identity_events_user ON identity_events (user_id, created_at DESC);

/* ------------------------------------------------------------ age assurance -- */
--
-- Every account passes an age check at registration. Separate from
-- `creator_verifications` on purpose, and not a column on it:
--
--   * It is a different check. A viewer proves an age with a document. A
--     creator proves an identity with a document *and* binds a face to it, so
--     that a later face check can ask "is this still the same person". A viewer
--     is never face-bound and there is deliberately nothing here to face-check
--     against.
--   * It has a different retention story. An age assurance is discharged once
--     it is recorded; a creator's subject id is a live handle into the
--     provider's biometric store and has to be surrendered on withdrawal.
--   * Collapsing them would mean one row whose meaning depends on a level
--     column, and every read would have to remember to check it. The one that
--     forgets is the one that lets an unverified creator broadcast.
--
-- The same rule as above applies: no biometric identifier lands here. A date of
-- birth does not either - the platform's only question is whether they were
-- over 18, so that is the only answer stored.
CREATE TABLE IF NOT EXISTS age_assurances (
    user_id             TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

    provider            TEXT NOT NULL,
    provider_inquiry_id TEXT,

    -- 'unstarted' | 'pending' | 'verified' | 'rejected' | 'expired'
    status              TEXT NOT NULL DEFAULT 'unstarted',
    decline_reason      TEXT,

    adult_confirmed     INTEGER NOT NULL DEFAULT 0,
    document_country    TEXT,

    consent_version     TEXT,
    consent_at          TEXT,
    consent_ip          TEXT,

    verified_at         TEXT,
    expires_at          TEXT,

    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_age_assurances_status ON age_assurances (status, expires_at);

/* ------------------------------------------------------------ portal unlock -- */
--
-- One passed face check, holding the creator portal open for the rest of a
-- browser session.
--
-- The creator page is where broadcast destinations are issued, so reaching it
-- with a password alone is not enough: the face check binds the person at the
-- keyboard to the person who enrolled. Re-running it on every navigation would
-- be a camera prompt every few seconds and a provider inquiry to pay for each
-- time, so the passed check is recorded here and carried for the session.
--
-- The raw token is returned once and held in the browser's `sessionStorage`,
-- which is what makes this a *browser session* rather than an account-wide
-- flag: it dies with the tab, it is not shared with a second browser, and
-- signing out revokes it server-side regardless.
CREATE TABLE IF NOT EXISTS creator_portal_unlocks (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- SHA-256 only, on the same reasoning as refresh tokens.
    token_hash          TEXT NOT NULL UNIQUE,

    -- The face check that opened it, for the audit trail. Null when enrolment
    -- opened it directly: enrolment runs liveness and face match itself, so
    -- the creator is not sent through a second selfie to reach the portal they
    -- just proved their way into. There is no challenge row to point at.
    challenge_id        TEXT,

    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    revoked_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_portal_unlocks_user ON creator_portal_unlocks (user_id);

/* ============================================================================
 *
 *  Monetisation: profiles, pricing, and the credit ledger.
 *
 *  Everything below is additive. There is no migration system here - `getDb()`
 *  replays this file on every open and every statement is `CREATE ... IF NOT
 *  EXISTS` - so a new table is safe and a new *column* on an existing table is
 *  not. That is why a creator's pricing and a viewer's avatar live in tables of
 *  their own rather than as columns on `users`, which is also the better shape:
 *  the hot auth path reads `users` on every request and has no use for either.
 *
 * ========================================================================= */

/* ---------------------------------------------------------------- profiles -- */
--
-- The public face of an account, for both roles.
--
-- Separate from `users` because this is the row that gets read by strangers.
-- `users` holds an email address and a password hash; nothing here is a secret,
-- and keeping the two apart means a query that serves a profile page cannot
-- accidentally select a credential.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id         TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

    -- A storage key, not a URL, for the same reason posters are: the URL is
    -- minted per request so it can be signed, expiring, and pointed at
    -- whichever CDN edge is in front today.
    avatar_key      TEXT,

    -- One line under the name on a card, and a longer paragraph on the page.
    tagline         TEXT,
    bio             TEXT,

    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

/* -------------------------------------------------------- creator settings -- */
--
-- What a creator charges, and what they are willing to do.
--
-- Prices are in credits per minute. A credit is one US cent - see the ledger
-- below - so `250` is $2.50 a minute. Integers throughout: per-minute billing
-- that accumulates floating-point error across a two-hour session is a support
-- ticket nobody can reproduce.
--
-- 3D is two separate switches rather than one, because the decision genuinely
-- is two decisions: a creator may be happy to send stereo to one paying person
-- privately and not to an open room, or the reverse. Neither switch can be
-- turned on until the creator has passed the 3D stream check - that is enforced
-- in the application, because the check is session-scoped and this row is not.
CREATE TABLE IF NOT EXISTS creator_settings (
    user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

    public_2d_per_min       INTEGER NOT NULL DEFAULT 0,
    public_3d_per_min       INTEGER NOT NULL DEFAULT 0,
    private_2d_per_min      INTEGER NOT NULL DEFAULT 0,
    private_3d_per_min      INTEGER NOT NULL DEFAULT 0,

    public_3d_enabled       INTEGER NOT NULL DEFAULT 0,
    private_3d_enabled      INTEGER NOT NULL DEFAULT 0,

    -- Whether a viewer in a 1:1 may record the creator's voice:
    -- 'ask' | 'always' | 'never'. Defaults to 'ask', because in an
    -- all-party-consent jurisdiction silence is not agreement.
    recording_policy        TEXT NOT NULL DEFAULT 'ask',

    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ------------------------------------------------------------- credits -- */
--
-- The ledger.
--
-- **One credit is one US cent.** Every amount in this subsystem is an integer
-- number of credits and there is no other unit; dollars exist only in the
-- purchase row, where a payment processor insisted on them, and in the label
-- the browser prints. Naming the unit once and never converting is what keeps
-- a per-minute charge from drifting against a balance.
--
-- Append-only, and double-entry: a viewer being charged for a minute is *two*
-- rows with the same `ref_id` - a debit against the viewer and a credit to the
-- creator - so the sum of every delta in this table equals the credits ever
-- purchased, and any other answer is a bug with a query that finds it.
CREATE TABLE IF NOT EXISTS credit_accounts (
    user_id         TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,

    -- Derivable by summing the ledger, cached here so reading a balance is one
    -- indexed lookup rather than a scan that grows for the life of the account.
    -- Written in the same transaction as the ledger row, never on its own.
    balance         INTEGER NOT NULL DEFAULT 0,

    -- Lifetime totals, for the profile page and for reconciliation.
    purchased       INTEGER NOT NULL DEFAULT 0,
    earned          INTEGER NOT NULL DEFAULT 0,
    spent           INTEGER NOT NULL DEFAULT 0,

    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_ledger (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- Signed. Negative is money leaving this account.
    delta           INTEGER NOT NULL,

    -- 'purchase' | 'watch' | 'earn' | 'recording_sale' | 'recording_purchase'
    -- | 'refund' | 'adjustment'
    reason          TEXT NOT NULL,

    -- What this entry is about, for the statement line and for joining the two
    -- halves of a transfer back together.
    ref_type        TEXT,
    ref_id          TEXT,

    -- The balance this entry produced. Denormalised on purpose: a statement has
    -- to show a running balance, and recomputing it per row turns a page of
    -- history into a quadratic scan.
    balance_after   INTEGER NOT NULL,

    -- Set on entries that must not be applied twice - a retried purchase
    -- callback, a billing tick that arrives after a socket hiccup. Unique, so
    -- the second attempt loses to the constraint rather than to a race.
    idem_key        TEXT UNIQUE,

    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON credit_ledger (ref_type, ref_id);

-- One attempt to buy credits. Kept whatever the outcome: a failed purchase a
-- viewer swears they made is a support question, and a table with no row in it
-- cannot answer.
CREATE TABLE IF NOT EXISTS credit_purchases (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- What was charged, in the smallest unit of the currency, and what was
    -- granted. They are equal under the current pricing and are stored
    -- separately anyway, so a promotion later is a value change and not a
    -- schema change.
    amount_cents    INTEGER NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'usd',
    credits         INTEGER NOT NULL,

    -- Which processor took the money, and its id for the charge. 'stub' is the
    -- built-in one that takes nothing; it is recorded here so a stub purchase
    -- is identifiable forever rather than indistinguishable from a real one.
    provider        TEXT NOT NULL,
    provider_ref    TEXT,

    -- 'pending' | 'paid' | 'failed' | 'refunded'
    status          TEXT NOT NULL DEFAULT 'pending',
    failure_reason  TEXT,

    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON credit_purchases (user_id, created_at DESC);

/* ------------------------------------------------------------ agreements -- */

-- What an account agreed to, and which wording it was.
--
-- The terms are a file in the repo with a version string at the top. Storing
-- the version rather than the text means a later edit to the wording cannot
-- quietly rewrite what somebody accepted: an account holding version 1 is
-- visibly holding version 1 after the text becomes version 2, which is the
-- only way to know who needs asking again.
--
-- 'terms'   - the general terms of use, accepted by every account at signup.
-- 'creator' - the publisher agreement, accepted when an account becomes a
--             creator, whether at signup or later through Become a creator.
CREATE TABLE IF NOT EXISTS account_agreements (
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    version     TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_ip TEXT,

    PRIMARY KEY (user_id, kind)
);
