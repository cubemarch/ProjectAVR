import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getProvider } from '../identity/providers.js';

/**
 * Database access.
 *
 * SQLite in WAL mode is the reference backend: readers never block on the
 * writer, which matches this workload (browse traffic dwarfs writes by orders
 * of magnitude). Everything goes through the small repository objects below
 * rather than raw SQL scattered across route handlers, so swapping in Postgres
 * for a multi-writer deployment means reimplementing this one file.
 *
 * The app tier keeps no user state in process memory. Any node can serve any
 * request, which is what makes horizontal scaling a matter of adding machines.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const DB_PATH = process.env.AVR_DB || path.join(ROOT, 'data', 'projectavr.db');

let db = null;

/**
 * Open the database, applying the schema if needed.
 *
 * Under the cluster supervisor every worker calls this within milliseconds of
 * the others, and the schema includes DDL plus a `journal_mode` change - both
 * of which take a write lock. Without the busy timeout the losers of that race
 * get `SQLITE_BUSY` immediately and the worker dies on boot.
 *
 * `busy_timeout` is set before anything that needs a lock, so contenders wait
 * their turn instead of failing. The retry loop is a second line of defence for
 * the case where even that window is exceeded.
 *
 * @returns {DatabaseSync}
 */
export function getDb() {
    if (db) return db;

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout = 10000;');

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            db.exec(schema);
            addMissingColumns(db);
            return db;
        } catch (err) {
            lastError = err;
            if (!/locked|busy/i.test(err.message)) break;
            sleepSync(150 * (attempt + 1));
        }
    }

    db.close();
    db = null;
    throw lastError;
}

/**
 * Columns added to a table that already exists.
 *
 * `schema.sql` is all `CREATE TABLE IF NOT EXISTS`, which is idempotent but
 * also inert: a column added to the file never reaches a database that was
 * created before it. This is the smallest thing that closes that gap - an
 * additive, nullable-column-only migration, applied at open, in the same
 * retry loop as the schema itself.
 *
 * `NOT NULL` is permitted alongside a constant `DEFAULT`, and only there.
 * SQLite accepts that form because the default is what every existing row
 * gets, so the statement is still a single rewrite-free addition with no
 * backfill to plan and no window in which the column is half-populated. A
 * `NOT NULL` with no default is rejected by SQLite itself.
 *
 * Deliberately not a migration framework. Anything that needs to *change* or
 * *drop* a column, or backfill one from another, needs a versioned migration
 * and a plan for running it, and should not be smuggled in here.
 */
const ADDED_COLUMNS = [
    // Packaging output. See `server/media/jobs.js`.
    { table: 'titles', column: 'renditions', type: 'TEXT' },

    // Marketing consent. Off for every account that predates the checkbox,
    // which is the only defensible reading of an account that was never asked.
    { table: 'users', column: 'marketing_emails', type: 'INTEGER NOT NULL DEFAULT 0' },

    // Which method satisfied the state statute, and which state's. Null for
    // every check that predates the jurisdiction layer, which is honest: those
    // ran before the server knew where the viewer was, so there is no answer to
    // backfill. They still read as valid assurances - the gate asks whether a
    // current check exists, not which state it was taken under.
    { table: 'age_assurances', column: 'method', type: 'TEXT' },
    { table: 'age_assurances', column: 'jurisdiction', type: 'TEXT' }
];

function addMissingColumns(database) {
    for (const { table, column, type } of ADDED_COLUMNS) {
        const present = database.prepare(`PRAGMA table_info(${table})`).all();
        if (!present.length) continue;
        if (present.some((c) => c.name === column)) continue;

        database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
}

/** Blocking sleep - this runs during boot, before any request is served. */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Has the database been opened yet?
 *
 * For cold paths that would rather do nothing than bring a database into
 * existence as a side effect of a lookup - {@link getDb} creates the file and
 * applies the schema, which is the right behaviour at boot and the wrong one
 * halfway through rejecting a bad credential.
 */
export function dbIsOpen() {
    return db !== null;
}

export function closeDb() {
    db?.close();
    db = null;
}

export const newId = () => crypto.randomUUID();

/** Long, URL-safe, unguessable. Used for feed tokens and refresh tokens. */
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/* ------------------------------------------------------------------- users -- */

export const users = {
    /**
     * @param {{email: string, passwordHash: string, displayName: string,
     *          role?: string, marketingEmails?: boolean}} input
     * @returns {object} The created user row.
     */
    create({ email, passwordHash, displayName, role = 'viewer', marketingEmails = false }) {
        const id = newId();

        getDb()
            .prepare(
                `INSERT INTO users (id, email, password_hash, display_name, role, feed_token, marketing_emails)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(id, email.trim(), passwordHash, displayName.trim(), role, newToken(), marketingEmails ? 1 : 0);

        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
    },

    byEmail(email) {
        return getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim()) ?? null;
    },

    /**
     * The same lookup, ignoring case.
     *
     * Addresses are stored as the account typed them, so an exact match is
     * right for sign-in (where the account supplies both sides) and wrong for
     * anything matching against a value written somewhere else - a config
     * variable, a support ticket, an invoice.
     */
    byEmailInsensitive(email) {
        return (
            getDb()
                .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
                .get(String(email).trim()) ?? null
        );
    },

    byFeedToken(token) {
        return getDb().prepare('SELECT * FROM users WHERE feed_token = ? AND disabled = 0').get(token) ?? null;
    },

    /**
     * Everybody holding one exact role. Not ranked - `withRole('admin')` does
     * not include superusers, because the callers that want this want the set
     * to reconcile, not the set to admit.
     */
    withRole(role) {
        return getDb().prepare('SELECT * FROM users WHERE role = ?').all(role);
    },

    setRole(id, role) {
        getDb().prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, id);
        return this.byId(id);
    },

    rotateFeedToken(id) {
        const token = newToken();
        getDb().prepare("UPDATE users SET feed_token = ?, updated_at = datetime('now') WHERE id = ?").run(token, id);
        return token;
    },

    /**
     * Opt in or out of marketing email.
     *
     * Reachable from the settings page and, without a session, from the
     * unsubscribe link in a marketing email. Nothing else may call it: an
     * opt-in has to come from the person, and a code path that sets this to 1
     * as a side effect of something else is the thing that turns a mailing
     * list into a complaint.
     */
    setMarketingEmails(id, on) {
        getDb()
            .prepare("UPDATE users SET marketing_emails = ?, updated_at = datetime('now') WHERE id = ?")
            .run(on ? 1 : 0, id);

        return this.byId(id);
    },

    count() {
        return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
    },

    /** Shape sent to the client. Never includes the password hash. */
    publicView(user) {
        if (!user) return null;
        return {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            role: user.role,
            feedToken: user.feed_token,
            marketingEmails: Boolean(user.marketing_emails),
            createdAt: user.created_at
        };
    }
};

/* ---------------------------------------------------------- refresh tokens -- */

export const sessions = {
    /**
     * @param {string} userId
     * @param {string} tokenHash - SHA-256 of the raw token; the raw value never lands in the database.
     * @param {Date} expiresAt
     * @param {string} [userAgent]
     */
    create(userId, tokenHash, expiresAt, userAgent) {
        const id = newId();
        getDb()
            .prepare(
                `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .run(id, userId, tokenHash, expiresAt.toISOString(), userAgent?.slice(0, 300) ?? null);
        return id;
    },

    byHash(tokenHash) {
        return (
            getDb()
                .prepare(
                    `SELECT * FROM refresh_tokens
                     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
                )
                .get(tokenHash, new Date().toISOString()) ?? null
        );
    },

    revoke(id) {
        getDb().prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?").run(id);
    },

    revokeAllForUser(userId) {
        getDb()
            .prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL")
            .run(userId);
    },

    /** Housekeeping; safe to call on a timer from every node. */
    pruneExpired() {
        return getDb()
            .prepare('DELETE FROM refresh_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL')
            .run(new Date(Date.now() - 86_400_000).toISOString()).changes;
    }
};

/* ------------------------------------------------------------------ titles -- */

const TITLE_COLUMNS = `
    id, creator_id, slug, title, synopsis, genre, studio, year,
    projection, stereo, fisheye_fov, lens,
    duration, width, height, size_bytes,
    status, status_detail, visibility,
    source_key, hls_key, poster_key, backdrop_key, renditions,
    created_at, updated_at, published_at
`;

export const titles = {
    create(input) {
        const id = newId();

        getDb()
            .prepare(
                `INSERT INTO titles (id, creator_id, slug, title, synopsis, genre, studio, year,
                                     projection, stereo, fisheye_fov, lens, visibility, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                id,
                input.creatorId,
                input.slug,
                input.title,
                input.synopsis ?? null,
                input.genre ?? null,
                input.studio ?? null,
                input.year ?? null,
                input.projection ?? 'flat',
                input.stereo ?? 'mono',
                input.fisheyeFov ?? null,
                input.lens ?? null,
                input.visibility ?? 'private',
                input.status ?? 'draft'
            );

        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare(`SELECT ${TITLE_COLUMNS} FROM titles WHERE id = ?`).get(id) ?? null;
    },

    bySlug(slug) {
        return getDb().prepare(`SELECT ${TITLE_COLUMNS} FROM titles WHERE slug = ?`).get(slug) ?? null;
    },

    /** Everything a viewer is allowed to browse. */
    listPublished() {
        return getDb()
            .prepare(
                `SELECT ${TITLE_COLUMNS} FROM titles
                 WHERE status = 'published' AND visibility = 'public'
                 ORDER BY published_at DESC, created_at DESC`
            )
            .all();
    },

    listByCreator(creatorId) {
        return getDb()
            .prepare(`SELECT ${TITLE_COLUMNS} FROM titles WHERE creator_id = ? ORDER BY updated_at DESC`)
            .all(creatorId);
    },

    /**
     * Partial update restricted to an allow-list, so a request body can never
     * reach columns like `creator_id` or `status`.
     */
    update(id, patch) {
        const allowed = {
            title: 'title',
            synopsis: 'synopsis',
            genre: 'genre',
            studio: 'studio',
            year: 'year',
            projection: 'projection',
            stereo: 'stereo',
            fisheyeFov: 'fisheye_fov',
            lens: 'lens',
            visibility: 'visibility',
            duration: 'duration',
            width: 'width',
            height: 'height',
            sizeBytes: 'size_bytes',
            sourceKey: 'source_key',
            hlsKey: 'hls_key',
            posterKey: 'poster_key',
            backdropKey: 'backdrop_key',
            renditions: 'renditions'
        };

        const sets = [];
        const values = [];

        for (const [key, column] of Object.entries(allowed)) {
            if (patch[key] === undefined) continue;
            sets.push(`${column} = ?`);
            values.push(patch[key]);
        }

        if (!sets.length) return this.byId(id);

        values.push(id);
        getDb()
            .prepare(`UPDATE titles SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .run(...values);

        return this.byId(id);
    },

    setStatus(id, status, detail = null) {
        getDb()
            .prepare(
                `UPDATE titles
                 SET status = ?, status_detail = ?, updated_at = datetime('now'),
                     published_at = CASE WHEN ? = 'published' AND published_at IS NULL
                                         THEN datetime('now') ELSE published_at END
                 WHERE id = ?`
            )
            .run(status, detail, status, id);

        return this.byId(id);
    },

    remove(id) {
        getDb().prepare('DELETE FROM titles WHERE id = ?').run(id);
    },

    slugExists(slug) {
        return !!getDb().prepare('SELECT 1 FROM titles WHERE slug = ?').get(slug);
    }
};

/* ---------------------------------------------------------------- progress -- */

export const progress = {
    set(userId, titleId, position, completed = false) {
        getDb()
            .prepare(
                `INSERT INTO watch_progress (user_id, title_id, position, completed, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'))
                 ON CONFLICT (user_id, title_id)
                 DO UPDATE SET position = excluded.position,
                               completed = excluded.completed,
                               updated_at = datetime('now')`
            )
            .run(userId, titleId, position, completed ? 1 : 0);
    },

    /**
     * All of a viewer's positions in one query, keyed by slug.
     *
     * Slug rather than row id, because that is what the client calls a title
     * everywhere else - the catalog, the URL and the DeoVR feed all use it.
     * Returning row ids here would silently fail to match anything.
     */
    forUser(userId) {
        const rows = getDb()
            .prepare(
                `SELECT t.slug, p.position, p.completed
                 FROM watch_progress p
                 JOIN titles t ON t.id = p.title_id
                 WHERE p.user_id = ?`
            )
            .all(userId);

        return Object.fromEntries(rows.map((r) => [r.slug, { position: r.position, completed: !!r.completed }]));
    }
};

export const myList = {
    add(userId, titleId) {
        getDb()
            .prepare('INSERT OR IGNORE INTO my_list (user_id, title_id) VALUES (?, ?)')
            .run(userId, titleId);
    },

    remove(userId, titleId) {
        getDb().prepare('DELETE FROM my_list WHERE user_id = ? AND title_id = ?').run(userId, titleId);
    },

    /** Slugs, for the same reason as {@link progress.forUser}. */
    forUser(userId) {
        return getDb()
            .prepare(
                `SELECT t.slug FROM my_list m JOIN titles t ON t.id = m.title_id WHERE m.user_id = ?`
            )
            .all(userId)
            .map((r) => r.slug);
    }
};

/* --------------------------------------------------------------- analytics -- */

export const analytics = {
    /**
     * Record a view. Writes to an append-only log and bumps a counter in the
     * same transaction, so the dashboard reads one row instead of aggregating.
     */
    recordView(titleId, userId, secondsWatched) {
        const database = getDb();

        database.exec('BEGIN');
        try {
            database
                .prepare('INSERT INTO view_events (title_id, user_id, seconds_watched) VALUES (?, ?, ?)')
                .run(titleId, userId ?? null, secondsWatched);

            database
                .prepare(
                    `INSERT INTO title_stats (title_id, views, seconds_watched, updated_at)
                     VALUES (?, 1, ?, datetime('now'))
                     ON CONFLICT (title_id)
                     DO UPDATE SET views = views + 1,
                                   seconds_watched = seconds_watched + excluded.seconds_watched,
                                   updated_at = datetime('now')`
                )
                .run(titleId, secondsWatched);

            database.exec('COMMIT');
        } catch (err) {
            database.exec('ROLLBACK');
            throw err;
        }
    },

    forCreator(creatorId) {
        return getDb()
            .prepare(
                `SELECT t.id, t.title, t.status, t.visibility,
                        COALESCE(s.views, 0) AS views,
                        COALESCE(s.seconds_watched, 0) AS seconds_watched
                 FROM titles t
                 LEFT JOIN title_stats s ON s.title_id = t.id
                 WHERE t.creator_id = ?
                 ORDER BY views DESC`
            )
            .all(creatorId);
    },

    /** Daily view counts for the last N days, for the dashboard sparkline. */
    dailyForCreator(creatorId, days = 30) {
        return getDb()
            .prepare(
                `SELECT date(v.created_at) AS day, COUNT(*) AS views
                 FROM view_events v
                 JOIN titles t ON t.id = v.title_id
                 WHERE t.creator_id = ? AND v.created_at >= date('now', ?)
                 GROUP BY day
                 ORDER BY day`
            )
            .all(creatorId, `-${days} days`);
    }
};

/* ----------------------------------------------------------------- uploads -- */

export const uploads = {
    create({ titleId, creatorId, storageKey, originalName, bytesExpected }) {
        const id = newId();
        getDb()
            .prepare(
                `INSERT INTO uploads (id, title_id, creator_id, storage_key, original_name, bytes_expected)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(id, titleId, creatorId, storageKey, originalName ?? null, bytesExpected ?? null);
        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM uploads WHERE id = ?').get(id) ?? null;
    },

    complete(id, bytesReceived) {
        getDb()
            .prepare(
                `UPDATE uploads SET status = 'complete', bytes_received = ?, updated_at = datetime('now')
                 WHERE id = ?`
            )
            .run(bytesReceived, id);
        return this.byId(id);
    },

    abort(id) {
        getDb()
            .prepare("UPDATE uploads SET status = 'aborted', updated_at = datetime('now') WHERE id = ?")
            .run(id);
    }
};

/* ---------------------------------------------- identity verification -- */

/**
 * Does this row come from the provider the server is using now?
 *
 * A verdict is only worth what the thing that issued it was. The stub approves
 * every document and every face, so a row it wrote is not evidence that anybody
 * was checked - and switching the deployment to Persona does not retroactively
 * make it so. Without this, the first real deployment of a server that was ever
 * run against the stub inherits a set of permanently verified accounts that no
 * identity provider has ever seen.
 *
 * Deliberately symmetric: moving *away* from Persona invalidates its rows too.
 * A verdict belongs to the provider that issued it, and re-enrolling is cheap
 * next to being wrong about who somebody is.
 */
function issuedByCurrentProvider(row) {
    return row.provider === getProvider().name;
}

/**
 * Creator identity verification.
 *
 * Nothing here holds a biometric identifier - see the long note in schema.sql.
 * These rows record what a provider decided, not what it looked at.
 */
export const verifications = {
    byUser(userId) {
        return getDb().prepare('SELECT * FROM creator_verifications WHERE user_id = ?').get(userId) ?? null;
    },

    /**
     * Record consent and open an enrolment.
     *
     * Consent is written in the same statement that starts the enrolment, and
     * before the provider is ever called, because the regimes that allow this
     * processing require consent to precede collection - not accompany it.
     *
     * @param {{userId: string, provider: string, inquiryId: string,
     *          consentVersion: string, consentIp?: string}} input
     */
    startEnrolment({ userId, provider, inquiryId, consentVersion, consentIp }) {
        getDb()
            .prepare(
                `INSERT INTO creator_verifications
                     (user_id, provider, provider_inquiry_id, status,
                      consent_version, consent_at, consent_ip)
                 VALUES (?, ?, ?, 'pending', ?, datetime('now'), ?)
                 ON CONFLICT (user_id) DO UPDATE SET
                     provider            = excluded.provider,
                     provider_inquiry_id = excluded.provider_inquiry_id,
                     status              = 'pending',
                     decline_reason      = NULL,
                     consent_version     = excluded.consent_version,
                     consent_at          = excluded.consent_at,
                     consent_ip          = excluded.consent_ip,
                     updated_at          = datetime('now')`
            )
            .run(userId, provider, inquiryId, consentVersion, consentIp ?? null);

        return this.byUser(userId);
    },

    /**
     * Apply a provider verdict.
     *
     * @param {string} userId
     * @param {{status: string, subjectId?: string|null, documentCountry?: string|null,
     *          documentType?: string|null, adultConfirmed?: boolean,
     *          declineReason?: string|null, expiresAt?: string|null}} result
     */
    resolve(userId, result) {
        const verified = result.status === 'verified';

        getDb()
            .prepare(
                `UPDATE creator_verifications SET
                     status              = ?,
                     provider_subject_id = COALESCE(?, provider_subject_id),
                     document_country    = COALESCE(?, document_country),
                     document_type       = COALESCE(?, document_type),
                     adult_confirmed     = ?,
                     decline_reason      = ?,
                     verified_at         = CASE WHEN ? THEN datetime('now') ELSE verified_at END,
                     expires_at          = COALESCE(?, expires_at),
                     updated_at          = datetime('now')
                 WHERE user_id = ?`
            )
            .run(
                result.status,
                result.subjectId ?? null,
                result.documentCountry ?? null,
                result.documentType ?? null,
                result.adultConfirmed ? 1 : 0,
                result.declineReason ?? null,
                verified ? 1 : 0,
                result.expiresAt ?? null,
                userId
            );

        return this.byUser(userId);
    },

    /**
     * Is this creator cleared to broadcast right now?
     *
     * Expiry is evaluated here rather than trusted from the stored status, so a
     * verification that lapsed while nobody was looking cannot keep working
     * until some sweep gets round to it.
     */
    isCurrent(row) {
        if (!row || row.status !== 'verified') return false;
        if (!issuedByCurrentProvider(row)) return false;
        if (!row.expires_at) return true;
        return new Date(row.expires_at).getTime() > Date.now();
    },

    /** Mark lapsed rows so the portal can prompt for re-enrolment. */
    expireLapsed() {
        return getDb()
            .prepare(
                `UPDATE creator_verifications SET status = 'expired', updated_at = datetime('now')
                 WHERE status = 'verified' AND expires_at IS NOT NULL AND expires_at < ?`
            )
            .run(new Date().toISOString()).changes;
    },

    /**
     * Forget someone.
     *
     * A deletion request has to reach the provider too - that is where the
     * biometric actually lives - so this returns the reference the caller must
     * use to finish the job, rather than quietly dropping the only handle to it.
     */
    forget(userId) {
        const row = this.byUser(userId);
        getDb().prepare('DELETE FROM creator_verifications WHERE user_id = ?').run(userId);
        return row ? { provider: row.provider, subjectId: row.provider_subject_id } : null;
    },

    publicView(row) {
        if (!row) return { status: 'unstarted', adultConfirmed: false };
        return {
            status: this.isCurrent(row) ? 'verified' : row.status === 'verified' ? 'expired' : row.status,
            adultConfirmed: Boolean(row.adult_confirmed),
            documentCountry: row.document_country,
            verifiedAt: row.verified_at,
            expiresAt: row.expires_at,
            declineReason: row.decline_reason
        };
    }
};

/* -------------------------------------------------------- age assurance -- */

/**
 * Whatever proves an account holder is old enough to be here.
 *
 * Deliberately not folded into {@link verifications}; see the note above
 * `age_assurances` in `schema.sql` for why the two checks stay apart.
 */
export const ageAssurances = {
    byUser(userId) {
        return getDb().prepare('SELECT * FROM age_assurances WHERE user_id = ?').get(userId) ?? null;
    },

    /**
     * @param {{userId: string, provider: string, inquiryId: string,
     *          consentVersion: string, consentIp?: string,
     *          method?: string|null, jurisdiction?: string|null}} input
     */
    start({ userId, provider, inquiryId, consentVersion, consentIp, method, jurisdiction }) {
        getDb()
            .prepare(
                `INSERT INTO age_assurances
                     (user_id, provider, provider_inquiry_id, status,
                      consent_version, consent_at, consent_ip, method, jurisdiction)
                 VALUES (?, ?, ?, 'pending', ?, datetime('now'), ?, ?, ?)
                 ON CONFLICT (user_id) DO UPDATE SET
                     provider            = excluded.provider,
                     provider_inquiry_id = excluded.provider_inquiry_id,
                     status              = 'pending',
                     decline_reason      = NULL,
                     consent_version     = excluded.consent_version,
                     consent_at          = excluded.consent_at,
                     consent_ip          = excluded.consent_ip,
                     method              = excluded.method,
                     jurisdiction        = excluded.jurisdiction,
                     updated_at          = datetime('now')`
            )
            .run(
                userId,
                provider,
                inquiryId,
                consentVersion,
                consentIp ?? null,
                method ?? null,
                jurisdiction ?? null
            );

        return this.byUser(userId);
    },

    /**
     * @param {string} userId
     * @param {{status: string, adultConfirmed?: boolean, documentCountry?: string|null,
     *          declineReason?: string|null, expiresAt?: string|null}} result
     */
    resolve(userId, result) {
        // An adult decision is the whole point of the check, so a provider that
        // says "verified" without confirming one is not a pass. Failing closed
        // here rather than at the reader means there is one place to audit.
        const verified = result.status === 'verified' && result.adultConfirmed === true;

        getDb()
            .prepare(
                `UPDATE age_assurances SET
                     status           = ?,
                     adult_confirmed  = ?,
                     document_country = COALESCE(?, document_country),
                     decline_reason   = ?,
                     verified_at      = CASE WHEN ? THEN datetime('now') ELSE verified_at END,
                     expires_at       = COALESCE(?, expires_at),
                     updated_at       = datetime('now')
                 WHERE user_id = ?`
            )
            .run(
                verified ? 'verified' : result.status === 'verified' ? 'rejected' : result.status,
                result.adultConfirmed ? 1 : 0,
                result.documentCountry ?? null,
                result.declineReason ?? (result.status === 'verified' && !result.adultConfirmed ? 'under 18' : null),
                verified ? 1 : 0,
                result.expiresAt ?? null,
                userId
            );

        return this.byUser(userId);
    },

    /** Evaluated rather than trusted from the stored status, as for verifications. */
    isCurrent(row) {
        if (!row || row.status !== 'verified' || !row.adult_confirmed) return false;
        if (!issuedByCurrentProvider(row)) return false;
        if (!row.expires_at) return true;
        return new Date(row.expires_at).getTime() > Date.now();
    },

    forget(userId) {
        getDb().prepare('DELETE FROM age_assurances WHERE user_id = ?').run(userId);
    },

    publicView(row) {
        if (!row) return { status: 'unstarted', adultConfirmed: false };
        return {
            status: this.isCurrent(row) ? 'verified' : row.status === 'verified' ? 'expired' : row.status,
            adultConfirmed: Boolean(row.adult_confirmed),
            documentCountry: row.document_country,
            method: row.method ?? null,
            verifiedAt: row.verified_at,
            expiresAt: row.expires_at,
            declineReason: row.decline_reason
        };
    }
};

/* -------------------------------------------------------- age attestation -- */

/**
 * "I am 18", pressed in a state that asks for nothing more.
 *
 * Kept apart from {@link ageAssurances} at every level - its own table, its own
 * accessor, its own reader - so that no caller can pick one up believing it is
 * the other. See the comment over `age_attestations` in `schema.sql`.
 */
export const ageAttestations = {
    byUser(userId) {
        return getDb().prepare('SELECT * FROM age_attestations WHERE user_id = ?').get(userId) ?? null;
    },

    /**
     * @param {{userId: string, version: string, region?: string|null,
     *          country?: string|null, resolvedBy?: string|null,
     *          ip?: string|null, expiresAt?: string|null}} input
     */
    record({ userId, version, region, country, resolvedBy, ip, expiresAt }) {
        getDb()
            .prepare(
                `INSERT INTO age_attestations
                     (user_id, region, country, resolved_by, version, attested_at, attested_ip, expires_at)
                 VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
                 ON CONFLICT (user_id) DO UPDATE SET
                     region      = excluded.region,
                     country     = excluded.country,
                     resolved_by = excluded.resolved_by,
                     version     = excluded.version,
                     attested_at = excluded.attested_at,
                     attested_ip = excluded.attested_ip,
                     expires_at  = excluded.expires_at`
            )
            .run(userId, region ?? null, country ?? null, resolvedBy ?? null, version, ip ?? null, expiresAt ?? null);

        return this.byUser(userId);
    },

    /** Evaluated rather than trusted, for the same reason as every other gate here. */
    isCurrent(row) {
        if (!row) return false;
        if (!row.expires_at) return true;
        return new Date(row.expires_at).getTime() > Date.now();
    },

    forget(userId) {
        getDb().prepare('DELETE FROM age_attestations WHERE user_id = ?').run(userId);
    },

    publicView(row) {
        if (!row) return { status: 'none' };

        return {
            status: this.isCurrent(row) ? 'attested' : 'expired',
            region: row.region,
            version: row.version,
            attestedAt: row.attested_at,
            expiresAt: row.expires_at
        };
    }
};

/* ------------------------------------------------------- portal unlocks -- */

export const portalUnlocks = {
    /**
     * @param {{userId: string, tokenHash: string, challengeId?: string|null,
     *          ttlSeconds: number}} input
     */
    create({ userId, tokenHash, challengeId = null, ttlSeconds }) {
        const id = newId();

        // One unlock per browser at a time is the honest model, but a creator
        // with a laptop and a desktop is not doing anything wrong, so old
        // unlocks are left to expire rather than being revoked here.
        getDb()
            .prepare(
                `INSERT INTO creator_portal_unlocks (id, user_id, token_hash, challenge_id, expires_at)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .run(id, userId, tokenHash, challengeId, new Date(Date.now() + ttlSeconds * 1000).toISOString());

        return id;
    },

    byHash(tokenHash) {
        return (
            getDb()
                .prepare(
                    `SELECT * FROM creator_portal_unlocks
                     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
                )
                .get(tokenHash, new Date().toISOString()) ?? null
        );
    },

    revoke(tokenHash) {
        getDb()
            .prepare("UPDATE creator_portal_unlocks SET revoked_at = datetime('now') WHERE token_hash = ?")
            .run(tokenHash);
    },

    /** Signing out closes the portal, on every device the account is open on. */
    revokeAllForUser(userId) {
        return getDb()
            .prepare(
                `UPDATE creator_portal_unlocks SET revoked_at = datetime('now')
                 WHERE user_id = ? AND revoked_at IS NULL`
            )
            .run(userId).changes;
    },

    purgeExpired() {
        return getDb()
            .prepare('DELETE FROM creator_portal_unlocks WHERE expires_at < ?')
            .run(new Date().toISOString()).changes;
    }
};

/* ------------------------------------------------- broadcast challenges -- */

export const challenges = {
    /**
     * @param {{userId: string, code: string, deviceLabel?: string,
     *          deviceIp?: string, ttlSeconds: number}} input
     */
    create({ userId, code, deviceLabel, deviceIp, ttlSeconds }) {
        const id = newId();

        getDb()
            .prepare(
                `INSERT INTO broadcast_challenges
                     (id, user_id, code, device_label, device_ip, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
                id,
                userId,
                code,
                deviceLabel?.slice(0, 120) ?? null,
                deviceIp?.slice(0, 64) ?? null,
                new Date(Date.now() + ttlSeconds * 1000).toISOString()
            );

        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM broadcast_challenges WHERE id = ?').get(id) ?? null;
    },

    /**
     * The one the browser should be prompting about.
     *
     * Newest first and one at a time: a creator being shown two simultaneous
     * approval prompts cannot meaningfully tell them apart, which is exactly
     * the confusion the code is there to prevent.
     */
    pendingForUser(userId) {
        return (
            getDb()
                .prepare(
                    `SELECT * FROM broadcast_challenges
                     WHERE user_id = ? AND status = 'pending' AND expires_at > ?
                     ORDER BY created_at DESC LIMIT 1`
                )
                .get(userId, new Date().toISOString()) ?? null
        );
    },

    /**
     * Record which provider check is answering this challenge.
     *
     * Separate from {@link resolve} because the challenge is still pending at
     * this point - the face flow has only just been handed to the browser - and
     * resolving it would stamp a resolution time on something unresolved.
     */
    attachProviderRef(id, providerRef) {
        getDb()
            .prepare("UPDATE broadcast_challenges SET provider_ref = ? WHERE id = ? AND status = 'pending'")
            .run(providerRef, id);
    },

    /**
     * Settle a challenge.
     *
     * Approved rows are still fair game: a challenge stays revocable right up
     * until the phone spends it, so "that was not me" a moment too late still
     * works, and an approval nobody collected can still lapse.
     */
    resolve(id, status, { providerRef = null, declineReason = null } = {}) {
        getDb()
            .prepare(
                `UPDATE broadcast_challenges
                 SET status = ?, provider_ref = COALESCE(?, provider_ref), decline_reason = ?, resolved_at = datetime('now')
                 WHERE id = ? AND status IN ('pending', 'approved')`
            )
            .run(status, providerRef, declineReason, id);

        return this.byId(id);
    },

    /** Called when a grant is handed to the phone, so it cannot be re-approved. */
    consume(id) {
        getDb().prepare("UPDATE broadcast_challenges SET status = 'consumed' WHERE id = ?").run(id);
    },

    /** Includes approvals nobody collected - an unspent approval is not a grant. */
    expireStale() {
        return getDb()
            .prepare(
                `UPDATE broadcast_challenges SET status = 'expired'
                 WHERE status IN ('pending', 'approved') AND expires_at < ?`
            )
            .run(new Date().toISOString()).changes;
    },

    /**
     * `created_at` is written by SQLite's `datetime('now')`, which is
     * space-separated rather than ISO-8601, so the cutoff has to be formatted
     * the same way or the string comparison drifts by a day at the boundary.
     */
    prune(olderThanDays = 30) {
        const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
        return getDb().prepare('DELETE FROM broadcast_challenges WHERE created_at < ?').run(cutoff).changes;
    }
};

/* ----------------------------------------------------- broadcast grants -- */

/**
 * Single-use, short-lived per-creator broadcast authorisation.
 *
 * A grant is earned with a face check and spent on one broadcast. There was a
 * brief period where this was a durable `broadcast_keys` row instead - an API
 * key that lasted until revoked - and the schema comment on that table records
 * why it was reverted: a credential that does not expire moves the face check
 * away from the moment it is about to matter.
 *
 * Two clocks, not one. `expires_at` bounds how long an uncollected grant is
 * worth anything; the resume window bounds how long a *spent* one still is, so
 * that a dropped Wi-Fi frame does not end a broadcast the creator verified their
 * face to start.
 */
export const grants = {
    /**
     * @param {{userId: string, tokenHash: string, challengeId?: string|null,
     *          ttlSeconds: number}} input
     */
    create({ userId, tokenHash, challengeId = null, ttlSeconds }) {
        const id = newId();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

        getDb()
            .prepare(
                `INSERT INTO broadcast_grants (id, user_id, challenge_id, token_hash, expires_at)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .run(id, userId, challengeId, tokenHash, expiresAt);

        return getDb().prepare('SELECT * FROM broadcast_grants WHERE id = ?').get(id);
    },

    /**
     * A grant that may still be presented, or null.
     *
     * Three conditions, all in SQL so there is one place to read them: not
     * revoked, not past `expires_at`, and either never spent or spent inside the
     * resume window. The window is measured from `consumed_at` and never
     * refreshed, so reconnecting does not extend it - it bounds the total life
     * of a spent grant rather than granting a fresh one per attempt.
     *
     * @param {string} tokenHash
     * @param {number} resumeSeconds
     */
    byHash(tokenHash, resumeSeconds) {
        return (
            getDb()
                .prepare(
                    `SELECT * FROM broadcast_grants
                      WHERE token_hash = ?
                        AND revoked_at IS NULL
                        AND expires_at > datetime('now')
                        AND (consumed_at IS NULL
                             OR consumed_at > datetime('now', ?))`
                )
                .get(tokenHash, `-${Math.max(0, Math.floor(resumeSeconds))} seconds`) ?? null
        );
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM broadcast_grants WHERE id = ?').get(id) ?? null;
    },

    /**
     * Spend it.
     *
     * `consumed_at IS NULL` in the WHERE clause, so the first caller wins and a
     * reconnection inside the resume window does not push the window forward.
     */
    consume(id) {
        return getDb()
            .prepare("UPDATE broadcast_grants SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL")
            .run(id).changes;
    },

    countLiveForUser(userId) {
        return getDb()
            .prepare(
                `SELECT COUNT(*) AS n FROM broadcast_grants
                  WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
            )
            .get(userId).n;
    },

    revokeAllForUser(userId) {
        return getDb()
            .prepare("UPDATE broadcast_grants SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL")
            .run(userId).changes;
    },

    /** Sweep grants that can no longer authorise anything. */
    pruneExpired(days = 7) {
        return getDb()
            .prepare('DELETE FROM broadcast_grants WHERE expires_at < ?')
            .run(new Date(Date.now() - days * 86_400_000).toISOString()).changes;
    }
};

/* ----------------------------------------------------- identity events -- */

export const identityEvents = {
    /**
     * @param {{userId?: string|null, kind: string, outcome: string,
     *          providerRef?: string|null, detail?: string|null}} event
     */
    record({ userId = null, kind, outcome, providerRef = null, detail = null }) {
        getDb()
            .prepare(
                `INSERT INTO identity_events (user_id, kind, outcome, provider_ref, detail)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .run(userId, kind, outcome, providerRef, detail ? String(detail).slice(0, 500) : null);
    },

    forUser(userId, limit = 50) {
        return getDb()
            .prepare('SELECT * FROM identity_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(userId, limit);
    }
};

/* ------------------------------------------------------------ agreements -- */

export const agreements = {
    /**
     * Record an acceptance, overwriting any earlier one of the same kind.
     *
     * Re-accepting is an update rather than a second row because the question
     * the table answers is "what is this account currently holding", and a
     * history of superseded versions answers a different question nobody has
     * asked yet.
     */
    accept({ userId, kind, version, ip = null }) {
        getDb()
            .prepare(
                `INSERT INTO account_agreements (user_id, kind, version, accepted_ip)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (user_id, kind)
                 DO UPDATE SET version = excluded.version,
                               accepted_at = datetime('now'),
                               accepted_ip = excluded.accepted_ip`
            )
            .run(userId, kind, version, ip);

        return this.get(userId, kind);
    },

    get(userId, kind) {
        return (
            getDb()
                .prepare('SELECT * FROM account_agreements WHERE user_id = ? AND kind = ?')
                .get(userId, kind) ?? null
        );
    },

    /** @returns {Record<string, {version: string, acceptedAt: string}>} */
    forUser(userId) {
        const rows = getDb().prepare('SELECT * FROM account_agreements WHERE user_id = ?').all(userId);

        return Object.fromEntries(
            rows.map((row) => [row.kind, { version: row.version, acceptedAt: row.accepted_at }])
        );
    }
};

/* -------------------------------------------------------------- profiles -- */

export const profiles = {
    byId(userId) {
        return getDb().prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId) ?? null;
    },

    /**
     * The row, creating an empty one if this account has never had a profile.
     *
     * An account with no profile row and an account with an empty profile are
     * the same thing to every caller, so the difference is not worth making
     * every caller handle.
     */
    ensure(userId) {
        const existing = this.byId(userId);
        if (existing) return existing;

        getDb().prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)').run(userId);
        return this.byId(userId);
    },

    /** @param {{avatarKey?: string|null, tagline?: string|null, bio?: string|null}} patch */
    update(userId, patch) {
        this.ensure(userId);

        const fields = [];
        const values = [];

        // Only the keys actually present are written, so a caller updating a
        // tagline cannot blank an avatar by omission.
        if ('avatarKey' in patch) {
            fields.push('avatar_key = ?');
            values.push(patch.avatarKey ?? null);
        }
        if ('tagline' in patch) {
            fields.push('tagline = ?');
            values.push(patch.tagline ?? null);
        }
        if ('bio' in patch) {
            fields.push('bio = ?');
            values.push(patch.bio ?? null);
        }

        if (fields.length) {
            getDb()
                .prepare(`UPDATE user_profiles SET ${fields.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`)
                .run(...values, userId);
        }

        return this.byId(userId);
    },

    /**
     * Profiles for a set of accounts, in one query.
     *
     * The live row on the home page renders a dozen creators at once; doing
     * this per card is the classic N+1 that only shows up once there are
     * enough creators to notice.
     *
     * @returns {Map<string, object>}
     */
    forUsers(userIds) {
        const ids = [...new Set(userIds)].filter(Boolean);
        if (!ids.length) return new Map();

        const rows = getDb()
            .prepare(`SELECT * FROM user_profiles WHERE user_id IN (${ids.map(() => '?').join(', ')})`)
            .all(...ids);

        return new Map(rows.map((row) => [row.user_id, row]));
    },

    publicView(row) {
        return {
            tagline: row?.tagline ?? null,
            bio: row?.bio ?? null,
            hasAvatar: !!row?.avatar_key
        };
    }
};

/* ------------------------------------------------------- creator settings -- */

export const creatorSettings = {
    byId(userId) {
        return getDb().prepare('SELECT * FROM creator_settings WHERE user_id = ?').get(userId) ?? null;
    },

    ensure(userId) {
        const existing = this.byId(userId);
        if (existing) return existing;

        getDb().prepare('INSERT OR IGNORE INTO creator_settings (user_id) VALUES (?)').run(userId);
        return this.byId(userId);
    },

    /**
     * Write a validated patch.
     *
     * Validation lives in the route, not here: what counts as a sane price is a
     * product decision that belongs next to the error message, and a repository
     * that silently clamps is one that makes a bug look like a preference.
     */
    update(userId, patch) {
        this.ensure(userId);

        const columns = {
            public2dPerMin: 'public_2d_per_min',
            public3dPerMin: 'public_3d_per_min',
            private2dPerMin: 'private_2d_per_min',
            private3dPerMin: 'private_3d_per_min',
            public3dEnabled: 'public_3d_enabled',
            private3dEnabled: 'private_3d_enabled',
            recordingPolicy: 'recording_policy'
        };

        const fields = [];
        const values = [];

        for (const [key, column] of Object.entries(columns)) {
            if (!(key in patch)) continue;

            fields.push(`${column} = ?`);
            values.push(typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key]);
        }

        if (fields.length) {
            getDb()
                .prepare(`UPDATE creator_settings SET ${fields.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`)
                .run(...values, userId);
        }

        return this.byId(userId);
    },

    forUsers(userIds) {
        const ids = [...new Set(userIds)].filter(Boolean);
        if (!ids.length) return new Map();

        const rows = getDb()
            .prepare(`SELECT * FROM creator_settings WHERE user_id IN (${ids.map(() => '?').join(', ')})`)
            .all(...ids);

        return new Map(rows.map((row) => [row.user_id, row]));
    },

    /** What a viewer is allowed to know: the prices, and whether 3D is on offer. */
    publicView(row) {
        return {
            public2dPerMin: row?.public_2d_per_min ?? 0,
            public3dPerMin: row?.public_3d_per_min ?? 0,
            private2dPerMin: row?.private_2d_per_min ?? 0,
            private3dPerMin: row?.private_3d_per_min ?? 0,
            public3dEnabled: !!row?.public_3d_enabled,
            private3dEnabled: !!row?.private_3d_enabled
        };
    }
};

/* --------------------------------------------------------------- credits -- */

/**
 * The credit ledger.
 *
 * One credit is one US cent, everywhere, with no other unit and no conversion.
 *
 * Every movement is an append-only row plus an update to a cached balance, in
 * one transaction. `post()` is the only way credits move: there is deliberately
 * no "set the balance" call, because a balance that can be assigned is a
 * balance the ledger cannot explain.
 */
export const credits = {
    account(userId) {
        const row = getDb().prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(userId);
        if (row) return row;

        getDb().prepare('INSERT OR IGNORE INTO credit_accounts (user_id) VALUES (?)').run(userId);
        return getDb().prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(userId);
    },

    balance(userId) {
        return this.account(userId).balance;
    },

    /**
     * Move credits, and say why.
     *
     * @param {object} entry
     * @param {string} entry.userId
     * @param {number} entry.delta - Signed, in credits. Negative spends.
     * @param {string} entry.reason
     * @param {string|null} [entry.refType]
     * @param {string|null} [entry.refId]
     * @param {string|null} [entry.idemKey] - Replay guard. A second post with
     *   the same key is a no-op that returns the first one's result.
     * @param {boolean} [entry.allowNegative] - Off by default. Only an
     *   administrative adjustment has any business taking an account below zero.
     * @returns {{balance: number, entryId: number|null, applied: boolean}}
     * @throws {Error} with `.code = 'insufficient_credits'`
     */
    post({ userId, delta, reason, refType = null, refId = null, idemKey = null, allowNegative = false }) {
        const amount = Math.trunc(delta);
        if (!Number.isFinite(amount) || amount === 0) {
            throw Object.assign(new Error('a ledger entry must move a whole, non-zero number of credits'), {
                code: 'invalid_amount'
            });
        }

        const database = getDb();
        this.account(userId);

        database.exec('BEGIN IMMEDIATE');
        try {
            // Inside the transaction, so two concurrent retries of the same
            // charge cannot both find nothing and both insert.
            if (idemKey) {
                const seen = database.prepare('SELECT * FROM credit_ledger WHERE idem_key = ?').get(idemKey);
                if (seen) {
                    database.exec('COMMIT');
                    return { balance: seen.balance_after, entryId: seen.id, applied: false };
                }
            }

            const current = database.prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(userId);
            const next = current.balance + amount;

            if (next < 0 && !allowNegative) {
                throw Object.assign(new Error('not enough credits'), { code: 'insufficient_credits' });
            }

            const result = database
                .prepare(
                    `INSERT INTO credit_ledger (user_id, delta, reason, ref_type, ref_id, balance_after, idem_key)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(userId, amount, reason, refType, refId, next, idemKey);

            database
                .prepare(
                    `UPDATE credit_accounts
                        SET balance = ?,
                            purchased = purchased + ?,
                            earned = earned + ?,
                            spent = spent + ?,
                            updated_at = datetime('now')
                      WHERE user_id = ?`
                )
                .run(
                    next,
                    reason === 'purchase' ? amount : 0,
                    amount > 0 && reason !== 'purchase' ? amount : 0,
                    amount < 0 ? -amount : 0,
                    userId
                );

            database.exec('COMMIT');
            return { balance: next, entryId: Number(result.lastInsertRowid), applied: true };
        } catch (err) {
            database.exec('ROLLBACK');
            throw err;
        }
    },

    /**
     * Move credits from one account to another as a single fact.
     *
     * Two rows, one `refId`, one transaction. A viewer's minute leaving their
     * balance and arriving in the creator's are the same event, and a crash
     * between them would otherwise create or destroy money.
     */
    transfer({ fromUserId, toUserId, amount, reason, refType = null, refId = null, idemKey = null }) {
        const credited = Math.trunc(amount);
        if (credited <= 0) {
            throw Object.assign(new Error('a transfer must be positive'), { code: 'invalid_amount' });
        }

        const database = getDb();
        this.account(fromUserId);
        this.account(toUserId);

        database.exec('BEGIN IMMEDIATE');
        try {
            if (idemKey) {
                const seen = database.prepare('SELECT * FROM credit_ledger WHERE idem_key = ?').get(idemKey);
                if (seen) {
                    database.exec('COMMIT');
                    return { balance: seen.balance_after, applied: false };
                }
            }

            const payer = database.prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(fromUserId);
            const payerNext = payer.balance - credited;

            if (payerNext < 0) {
                throw Object.assign(new Error('not enough credits'), { code: 'insufficient_credits' });
            }

            const payee = database.prepare('SELECT * FROM credit_accounts WHERE user_id = ?').get(toUserId);
            const payeeNext = payee.balance + credited;

            // The debit carries the idempotency key. One key per event, and the
            // two halves are already atomic, so putting it on both would only
            // create a second way for a replay to half-apply.
            database
                .prepare(
                    `INSERT INTO credit_ledger (user_id, delta, reason, ref_type, ref_id, balance_after, idem_key)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(fromUserId, -credited, reason, refType, refId, payerNext, idemKey);

            database
                .prepare(
                    `INSERT INTO credit_ledger (user_id, delta, reason, ref_type, ref_id, balance_after, idem_key)
                     VALUES (?, ?, ?, ?, ?, ?, NULL)`
                )
                .run(toUserId, credited, 'earn', refType, refId, payeeNext);

            database
                .prepare(
                    `UPDATE credit_accounts SET balance = ?, spent = spent + ?, updated_at = datetime('now')
                      WHERE user_id = ?`
                )
                .run(payerNext, credited, fromUserId);

            database
                .prepare(
                    `UPDATE credit_accounts SET balance = ?, earned = earned + ?, updated_at = datetime('now')
                      WHERE user_id = ?`
                )
                .run(payeeNext, credited, toUserId);

            database.exec('COMMIT');
            return { balance: payerNext, payeeBalance: payeeNext, applied: true };
        } catch (err) {
            database.exec('ROLLBACK');
            throw err;
        }
    },

    history(userId, limit = 50) {
        return getDb()
            .prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
            .all(userId, Math.min(Number(limit) || 50, 200));
    },

    /**
     * The two things that have to be true of the whole ledger.
     *
     * `balanceSum === ledgerSum` - the cached balances agree with the rows
     * behind them. This one holds no matter what anybody does, because both are
     * written in the same transaction, and it failing means a balance was
     * changed by something that did not write a row.
     *
     * `ledgerSum === purchased + adjusted` - nothing creates or destroys credits
     * except buying them and an explicit administrative adjustment. A transfer
     * nets to zero by construction, so this is what catches a half-written one.
     *
     * Exposed rather than described, because an invariant nothing checks is a
     * comment.
     */
    audit() {
        const db = getDb();
        const sum = (where = '') =>
            db.prepare(`SELECT COALESCE(SUM(delta), 0) AS n FROM credit_ledger ${where}`).get().n;

        return {
            ledgerSum: sum(),
            balanceSum: db.prepare('SELECT COALESCE(SUM(balance), 0) AS n FROM credit_accounts').get().n,
            purchased: sum("WHERE reason = 'purchase'"),
            adjusted: sum("WHERE reason = 'adjustment'")
        };
    }
};

/* ------------------------------------------------------------- purchases -- */

export const purchases = {
    /** @param {{userId: string, amountCents: number, credits: number, provider: string}} input */
    create({ userId, amountCents, credits: granted, provider, providerRef = null, currency = 'usd' }) {
        const id = newId();

        getDb()
            .prepare(
                `INSERT INTO credit_purchases (id, user_id, amount_cents, currency, credits, provider, provider_ref)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(id, userId, amountCents, currency, granted, provider, providerRef);

        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM credit_purchases WHERE id = ?').get(id) ?? null;
    },

    settle(id, status, { providerRef = null, failureReason = null } = {}) {
        getDb()
            .prepare(
                `UPDATE credit_purchases
                    SET status = ?,
                        provider_ref = COALESCE(?, provider_ref),
                        failure_reason = ?,
                        settled_at = datetime('now')
                  WHERE id = ?`
            )
            .run(status, providerRef, failureReason, id);

        return this.byId(id);
    },

    forUser(userId, limit = 25) {
        return getDb()
            .prepare('SELECT * FROM credit_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(userId, Math.min(Number(limit) || 25, 100));
    }
};

/* ------------------------------------------------------------ recordings -- */

/**
 * A creator's recordings of their own 1:1s, and their listings.
 *
 * Only the creator's side is here. See the comment over `recordings` in
 * `schema.sql` for why the viewer's recording is not, and why that is what
 * makes selling one possible.
 */
export const recordings = {
    /** Opened when the file starts, not when it finishes: a crash should leave a row. */
    start({ creatorId, roomId = null, sessionId = null, stereo = 'mono' }) {
        const id = newId();

        getDb()
            .prepare(
                `INSERT INTO recordings (id, creator_id, room_id, session_id, stereo)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .run(id, creatorId, roomId, sessionId, stereo);

        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM recordings WHERE id = ?').get(id) ?? null;
    },

    /**
     * The file landed.
     *
     * `stereo` is re-read from the session at this point rather than trusted
     * from `start`: a rig whose second camera dropped out partway through
     * announced two eyes and delivered one, and the tag has to describe the
     * file that exists.
     */
    finish(id, { storageKey, durationMs = 0, sizeBytes = 0, stereo = null }) {
        getDb()
            .prepare(
                `UPDATE recordings
                    SET status = 'ready',
                        storage_key = ?,
                        duration_ms = ?,
                        size_bytes = ?,
                        stereo = COALESCE(?, stereo),
                        finished_at = datetime('now')
                  WHERE id = ?`
            )
            .run(storageKey, Math.trunc(durationMs), Math.trunc(sizeBytes), stereo, id);

        return this.byId(id);
    },

    fail(id, reason) {
        getDb()
            .prepare(
                `UPDATE recordings
                    SET status = 'failed', failure_reason = ?, finished_at = datetime('now')
                  WHERE id = ?`
            )
            .run(String(reason ?? '').slice(0, 200), id);

        return this.byId(id);
    },

    forCreator(creatorId, limit = 50) {
        return getDb()
            .prepare('SELECT * FROM recordings WHERE creator_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(creatorId, Math.min(Number(limit) || 50, 200));
    },

    /**
     * Put it on sale, or take it off.
     *
     * Listing writes the price and the title together because a listing with no
     * price is not a listing, and the marketplace query keys on `listed_at`.
     * Unlisting leaves both in place: somebody who already bought it keeps a
     * receipt that names what they bought.
     */
    list(id, { title, price }) {
        getDb()
            .prepare(
                `UPDATE recordings
                    SET title = ?, price = ?, listed_at = datetime('now'), unlisted_at = NULL
                  WHERE id = ?`
            )
            .run(title, Math.trunc(price), id);

        return this.byId(id);
    },

    unlist(id) {
        getDb()
            .prepare("UPDATE recordings SET unlisted_at = datetime('now') WHERE id = ?").run(id);

        return this.byId(id);
    },

    /** The marketplace. Listed, still listed, and actually playable. */
    listed({ limit = 50, stereo = null } = {}) {
        const clause = stereo === '3d' ? "AND r.stereo != 'mono'" : stereo === '2d' ? "AND r.stereo = 'mono'" : '';

        return getDb()
            .prepare(
                `SELECT r.*, u.display_name AS creator_name,
                        (SELECT COUNT(*) FROM recording_sales s WHERE s.recording_id = r.id) AS sales
                   FROM recordings r
                   JOIN users u ON u.id = r.creator_id
                  WHERE r.listed_at IS NOT NULL
                    AND r.unlisted_at IS NULL
                    AND r.status = 'ready'
                    ${clause}
                  ORDER BY r.listed_at DESC
                  LIMIT ?`
            )
            .all(Math.min(Number(limit) || 50, 200));
    }
};

export const recordingSales = {
    byPair(recordingId, buyerId) {
        return (
            getDb()
                .prepare('SELECT * FROM recording_sales WHERE recording_id = ? AND buyer_id = ?')
                .get(recordingId, buyerId) ?? null
        );
    },

    create({ recordingId, buyerId, price }) {
        const id = newId();

        getDb()
            .prepare('INSERT INTO recording_sales (id, recording_id, buyer_id, price) VALUES (?, ?, ?, ?)')
            .run(id, recordingId, buyerId, Math.trunc(price));

        return getDb().prepare('SELECT * FROM recording_sales WHERE id = ?').get(id);
    },

    /**
     * Buy a listed recording: one sale row, one transfer, keyed on the sale.
     *
     * A sale is not a different kind of money from a watched minute, so it is
     * the same `credits.transfer` - two ledger rows sharing a `ref_id`, in one
     * SQLite transaction. What is different is that the reference has to exist
     * before the money moves, because the `ref_id` a statement line points at
     * is the sale. So the row is written first and removed again if the
     * transfer refuses; a sale that was never paid for must not sit in the
     * table looking like an entitlement.
     *
     * Three defences against paying twice, which is the failure that actually
     * matters here. The read below catches the ordinary double click; the
     * `idemKey` catches the retry that races past it and returns the first
     * answer rather than a second charge; and `UNIQUE (recording_id, buyer_id)`
     * is the one the database enforces whatever the code does.
     */
    buy({ recording, buyerId }) {
        const owned = this.byPair(recording.id, buyerId);
        if (owned) return { sale: owned, applied: false };

        const sale = this.create({ recordingId: recording.id, buyerId, price: recording.price });

        try {
            credits.transfer({
                fromUserId: buyerId,
                toUserId: recording.creator_id,
                amount: recording.price,
                reason: 'recording_purchase',
                refType: 'recording_sale',
                refId: sale.id,
                idemKey: `recording-sale:${sale.id}`
            });
        } catch (err) {
            getDb().prepare('DELETE FROM recording_sales WHERE id = ?').run(sale.id);
            throw err;
        }

        return { sale, applied: true };
    },

    /** What this account has bought, with enough of the recording to render a shelf. */
    forBuyer(buyerId, limit = 50) {
        return getDb()
            .prepare(
                `SELECT s.*, r.title, r.stereo, r.duration_ms, r.status, u.display_name AS creator_name
                   FROM recording_sales s
                   JOIN recordings r ON r.id = s.recording_id
                   JOIN users u ON u.id = r.creator_id
                  WHERE s.buyer_id = ?
                  ORDER BY s.created_at DESC
                  LIMIT ?`
            )
            .all(buyerId, Math.min(Number(limit) || 50, 200));
    },

    forRecording(recordingId) {
        return getDb()
            .prepare('SELECT * FROM recording_sales WHERE recording_id = ? ORDER BY created_at DESC')
            .all(recordingId);
    }
};

/* ----------------------------------------------------------------- email -- */

/**
 * The delivery log. See the comment on `email_messages` in `schema.sql` for
 * what it is for and why the body is not in it.
 */
export const emailMessages = {
    /**
     * @param {{userId?: string|null, kind: string, category: string,
     *          recipient: string, subject: string, provider: string,
     *          status?: string, detail?: string|null}} input
     * @returns {object} the row, so the caller can settle it by id
     */
    open({ userId = null, kind, category, recipient, subject, provider, status = 'queued', detail = null }) {
        const id = newId();

        getDb()
            .prepare(
                `INSERT INTO email_messages
                     (id, user_id, kind, category, recipient, subject, provider, status, detail, settled_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'queued' THEN NULL ELSE datetime('now') END)`
            )
            .run(
                id,
                userId,
                kind,
                category,
                recipient,
                subject.slice(0, 200),
                provider,
                status,
                detail ? String(detail).slice(0, 500) : null,
                status
            );

        return this.byId(id);
    },

    byId(id) {
        return getDb().prepare('SELECT * FROM email_messages WHERE id = ?').get(id) ?? null;
    },

    /** @param {'sent'|'failed'|'suppressed'} status */
    settle(id, status, { providerRef = null, detail = null } = {}) {
        getDb()
            .prepare(
                `UPDATE email_messages
                    SET status = ?, provider_ref = ?, detail = ?, settled_at = datetime('now')
                  WHERE id = ?`
            )
            .run(status, providerRef, detail ? String(detail).slice(0, 500) : null, id);

        return this.byId(id);
    },

    forUser(userId, limit = 50) {
        return getDb()
            .prepare('SELECT * FROM email_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
            .all(userId, Math.min(Number(limit) || 50, 200));
    },

    /**
     * Everyone who has said yes to marketing and still has a usable account.
     *
     * The opt-in is the `WHERE`, not a filter applied afterwards by whoever is
     * sending. A broadcast that reads the whole table and remembers to skip
     * people is one refactor away from not skipping them.
     */
    marketingAudience() {
        return getDb()
            .prepare('SELECT * FROM users WHERE marketing_emails = 1 AND disabled = 0 ORDER BY created_at')
            .all();
    }
};

export { nowIso };

/* --------------------------------------------------------- channel names -- */

/**
 * The names a channel answers to.
 *
 * One of them is primary and is what the site builds links from; the rest are
 * aliases that resolve to the same channel. Who may hold more than one is
 * decided in `server/channels/index.js` - this layer only enforces that a name
 * belongs to at most one account and that an account has at most one primary.
 *
 * Every slug reaching these methods is expected to be already lowercased and
 * shape-checked by `validateSlug`. Nothing here re-validates, because a second
 * validator that disagrees with the first is worse than one.
 */
export const channelSlugs = {
    /** @returns {{userId: string, slug: string, isPrimary: boolean}|null} */
    resolve(slug) {
        const row = getDb()
            .prepare('SELECT slug, user_id, is_primary FROM channel_slugs WHERE slug = ?')
            .get(String(slug ?? '').toLowerCase());

        return row ? { userId: row.user_id, slug: row.slug, isPrimary: row.is_primary === 1 } : null;
    },

    /** Every name this channel answers to, primary first. */
    forUser(userId) {
        return getDb()
            .prepare(
                `SELECT slug, is_primary, created_at
                   FROM channel_slugs
                  WHERE user_id = ?
                  ORDER BY is_primary DESC, created_at ASC`
            )
            .all(userId)
            .map((row) => ({
                slug: row.slug,
                isPrimary: row.is_primary === 1,
                createdAt: row.created_at
            }));
    },

    /** The name to build links out of, or null for a channel with no name yet. */
    primaryFor(userId) {
        const row = getDb()
            .prepare('SELECT slug FROM channel_slugs WHERE user_id = ? AND is_primary = 1')
            .get(userId);

        return row?.slug ?? null;
    },

    /**
     * Take a name.
     *
     * Returns false rather than throwing when the name is gone, because losing
     * a race for a name is an ordinary outcome that the form above has to
     * render, not an exceptional one. Any other constraint failure is a bug and
     * is allowed to propagate.
     *
     * @param {{userId: string, slug: string, primary?: boolean}} opts
     */
    claim({ userId, slug, primary = false }) {
        const db = getDb();
        const name = String(slug).toLowerCase();

        try {
            if (primary) {
                // Demote first: the partial unique index would otherwise reject
                // the insert, and SQLite has no deferred constraints to lean on.
                db.prepare('UPDATE channel_slugs SET is_primary = 0 WHERE user_id = ?').run(userId);
            }

            db.prepare(
                'INSERT INTO channel_slugs (slug, user_id, is_primary) VALUES (?, ?, ?)'
            ).run(name, userId, primary ? 1 : 0);

            return true;
        } catch (err) {
            if (/UNIQUE|constraint/i.test(err.message)) return false;
            throw err;
        }
    },

    /**
     * Give a name up.
     *
     * Refuses to remove the last one. A channel with no name is unreachable at
     * the only address its audience knows, and there is no UI anywhere that
     * asks for that - so it is prevented here rather than guarded at each call
     * site that might one day exist.
     */
    release({ userId, slug }) {
        const db = getDb();
        const name = String(slug).toLowerCase();

        const held = this.forUser(userId);
        if (held.length <= 1) return { ok: false, code: 'last_name' };

        const row = held.find((s) => s.slug === name);
        if (!row) return { ok: false, code: 'not_found' };

        db.prepare('DELETE FROM channel_slugs WHERE slug = ? AND user_id = ?').run(name, userId);

        // Releasing the primary promotes the oldest survivor, so the invariant
        // "every channel has exactly one primary" holds without the caller
        // having to think about it.
        if (row.isPrimary) {
            const next = this.forUser(userId)[0];
            if (next) {
                db.prepare('UPDATE channel_slugs SET is_primary = 1 WHERE slug = ?').run(next.slug);
            }
        }

        return { ok: true };
    },

    /** Promote one of a channel's existing names to be the canonical one. */
    setPrimary({ userId, slug }) {
        const db = getDb();
        const name = String(slug).toLowerCase();

        const owned = db
            .prepare('SELECT 1 FROM channel_slugs WHERE slug = ? AND user_id = ?')
            .get(name, userId);

        if (!owned) return false;

        db.prepare('UPDATE channel_slugs SET is_primary = 0 WHERE user_id = ?').run(userId);
        db.prepare('UPDATE channel_slugs SET is_primary = 1 WHERE slug = ?').run(name);

        return true;
    }
};

/* -------------------------------------------------------- reserved names -- */

/**
 * Names a superuser has taken out of circulation at runtime.
 *
 * Layered over the built-in list in `server/channels/slug.js`, never replacing
 * it: the built-in list contains the router's own paths and must not be
 * editable by anybody, including a superuser who is one typo away from
 * releasing `api`.
 */
export const reservedSlugs = {
    /** @returns {string[]} Just the words, for `validateSlug`'s `extraReserved`. */
    all() {
        return getDb()
            .prepare('SELECT slug FROM reserved_slugs ORDER BY slug')
            .all()
            .map((row) => row.slug);
    },

    /** The same list with its provenance, for the console that manages it. */
    list() {
        return getDb()
            .prepare(
                `SELECT r.slug, r.reason, r.created_at, u.display_name AS reserved_by
                   FROM reserved_slugs r
              LEFT JOIN users u ON u.id = r.reserved_by
                  ORDER BY r.created_at DESC`
            )
            .all()
            .map((row) => ({
                slug: row.slug,
                reason: row.reason,
                reservedBy: row.reserved_by,
                createdAt: row.created_at
            }));
    },

    /**
     * Reserve a name.
     *
     * Idempotent: reserving a reserved name succeeds and changes nothing, so a
     * double-submitted form is not an error to render.
     */
    add({ slug, reservedBy = null, reason = null }) {
        getDb()
            .prepare(
                `INSERT INTO reserved_slugs (slug, reserved_by, reason) VALUES (?, ?, ?)
                 ON CONFLICT (slug) DO NOTHING`
            )
            .run(String(slug).toLowerCase(), reservedBy, reason ? String(reason).slice(0, 200) : null);

        return true;
    },

    /** Release one. Cannot touch the built-in list, which is not in this table. */
    remove(slug) {
        return (
            getDb()
                .prepare('DELETE FROM reserved_slugs WHERE slug = ?')
                .run(String(slug).toLowerCase()).changes > 0
        );
    }
};
