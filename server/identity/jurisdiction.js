import { BRAND } from '../../brand.js';
import { METHODS, STATE_LAWS, US_REGIONS } from './state-laws.js';

/**
 * Which age check this viewer owes, and why.
 *
 * Twenty-seven states require a verified adult before anything harmful to
 * minors is shown. The rest require nothing, and in the rest a document check
 * is a privacy cost nobody asked us to impose - so they get a button. This
 * module is what decides which of those two a given request is in.
 *
 * Three ideas, and the whole file is them:
 *
 *   **A region.** Resolved from the edge, never from the client. See
 *   {@link resolveRegion} for why an unresolvable one fails closed.
 *
 *   **A policy.** {@link STATE_LAWS} turned into something the server can
 *   enforce and the browser can render. Two tiers: `verified` and `attest`.
 *
 *   **Satisfaction.** Whether what this account has already done is enough
 *   *for that policy*, which is not the same question as whether they have
 *   ever passed a check - Tennessee caps a verified session at an hour.
 *
 * What this module deliberately does **not** do is re-decide, after a check has
 * passed, which statutory bucket it fell into. Our provider performs one
 * document check; every one of these statutes accommodates a commercially
 * reasonable third-party document or records check, under one name or another.
 * The per-state `methods` list drives *what the viewer is offered* and what the
 * compliance documentation says we accept. Pretending the code can tell a
 * "digitized identification card" from a "transactional record" after the fact
 * would be theatre - the provider returns one verdict either way.
 */

/* ------------------------------------------------------------- attestation -- */

/**
 * The self-declaration shown where no statute requires more.
 *
 * Versioned and recorded like the other two disclosures, for the same reason:
 * so that rewriting this sentence later cannot silently re-label what somebody
 * clicked. It is weaker than both of them because it is a weaker thing - it
 * records that a person was asked and answered, and claims nothing about a
 * document.
 */
export const ATTESTATION_VERSION = '2026-10-07.1';

export const ATTESTATION_TEXT = [
    `${BRAND} is an adult platform. Everything on it is intended for adults only.`,
    'Your state does not require a document check, so we are not asking you for one. Confirm you are 18 or over to continue.',
    'We record that you confirmed this, when, and from which state. We do not record anything else about you here.'
].join('\n\n');

/**
 * How long a self-declaration stands before it is asked again.
 *
 * A year, because re-asking more often than that would be friction with no
 * legal purpose in a state that requires nothing - and never re-asking would
 * mean a single click in 2026 standing for an account forever.
 */
export const ATTESTATION_DAYS = Number(process.env.AVR_AGE_ATTESTATION_DAYS || 365);

/* ------------------------------------------------------- region resolution -- */

/**
 * Edge headers that carry a viewer's country and region, in priority order.
 *
 * All of them are set by infrastructure in front of this process and all of
 * them are trivially forgeable by a client talking to this process directly -
 * which is exactly as dangerous as it sounds, and is why `trust proxy` has to
 * be configured correctly for a deployment and why the server must not be
 * reachable except through the edge that sets these. See `docs/STATE-AGE-LAWS.md`.
 *
 * Cloudflare sends `cf-ipcountry` out of the box but *not* a region; the region
 * header is one a Transform Rule has to add. A deployment that has not added it
 * resolves country-only, which fails closed for US traffic rather than guessing
 * a state.
 */
const EDGE_HEADERS = [
    { country: 'cf-ipcountry', region: 'cf-region-code', source: 'cloudflare' },
    { country: 'x-vercel-ip-country', region: 'x-vercel-ip-country-region', source: 'vercel' },
    { country: 'cloudfront-viewer-country', region: 'cloudfront-viewer-country-region', source: 'cloudfront' },
    { country: 'x-geo-country', region: 'x-geo-region', source: 'proxy' }
];

/**
 * What to do when the region cannot be resolved.
 *
 * `strict` - the default - treats an unknown viewer as being in a covered
 * state. That is the only safe direction for this particular error: guessing
 * "no law" wrongly means serving adult material to a Texan with no check,
 * which is the liability the whole file exists to avoid, while guessing
 * "covered" wrongly means asking a Californian for a document they did not
 * legally have to show. One of those is a lawsuit and the other is friction.
 *
 * `attest` exists for a deployment that genuinely has no geolocation in front
 * of it and has decided, knowingly, to accept that. It is never the default and
 * the boot banner says so out loud.
 */
function fallbackTier() {
    return process.env.AVR_GEO_FALLBACK === 'attest' ? 'attest' : 'verified';
}

/** A pinned region for development and tests, e.g. `US-TX`. */
function pinnedRegion() {
    const pinned = process.env.AVR_GEO_DEFAULT_REGION;
    if (!pinned) return null;

    const [country, region] = String(pinned).toUpperCase().split('-');
    if (!country) return null;

    return { country, region: region ?? null, source: 'configured' };
}

/**
 * Where this request is coming from.
 *
 * Returns the region as a bare two-letter code (`TX`), not the ISO 3166-2 form
 * (`US-TX`), because that is what every edge in {@link EDGE_HEADERS} sends and
 * normalising in both directions would be two conversions where one will do.
 *
 * `source` is carried through to the client and into the audit record so that
 * "why was I asked for ID" has an answer that does not require reading a log.
 *
 * @param {import('express').Request} req
 * @returns {{country: string|null, region: string|null, source: string}}
 */
export function resolveRegion(req) {
    const pinned = pinnedRegion();
    if (pinned) return pinned;

    for (const { country, region, source } of EDGE_HEADERS) {
        const countryValue = headerCode(req, country);
        if (!countryValue) continue;

        return { country: countryValue, region: headerCode(req, region), source };
    }

    return { country: null, region: null, source: 'unknown' };
}

/** Headers arrive as strings, repeated headers as arrays; both can be junk. */
function headerCode(req, name) {
    const raw = req?.headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (typeof value !== 'string') return null;

    // `XX` is Cloudflare's "no country for this address" and `T1` is its Tor
    // exit marker. Both mean "unknown", and both would otherwise be stored and
    // rendered as if they were places.
    const code = value.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return null;
    if (code === 'XX' || code === 'T1') return null;

    return code;
}

/* -------------------------------------------------------------- the policy -- */

/**
 * @typedef {object} Policy
 * @property {'verified'|'attest'} tier what this viewer has to do
 * @property {string|null} country
 * @property {string|null} region
 * @property {string|null} stateName full name, for the sentence shown to the viewer
 * @property {string|null} citation
 * @property {string|null} source URL of the statute
 * @property {string[]} methods method ids from {@link METHODS}
 * @property {number|null} sessionMinutes statutory ceiling on a verified session
 * @property {boolean} requiresChoice the viewer must be offered a choice of method
 * @property {boolean} noRetention identifying information may not be retained
 * @property {'ial2'|null} assuranceLevel
 * @property {string|null} note
 * @property {string} reason why this policy and not another, for the audit trail
 */

/** Everywhere with no statute: one button, and nothing is collected. */
const ATTEST_METHODS = ['attestation'];

/**
 * The policy for a resolved region.
 *
 * @param {{country: string|null, region: string|null, source?: string}} where
 * @returns {Policy}
 */
export function policyFor({ country, region, source = 'unknown' }) {
    // Nothing resolved at all. Fail closed unless a deployment has said not to.
    if (!country) {
        return {
            ...base(),
            tier: fallbackTier(),
            methods: fallbackTier() === 'verified' ? ['government_id', 'digitized_id', 'transactional'] : ATTEST_METHODS,
            reason: 'region-unresolved'
        };
    }

    if (country !== 'US') {
        // The UK's Online Safety Act, France's Arcom regime and the German JMStV
        // all impose their own duties and none of them is modelled here. This
        // branch is the honest admission of that, not a finding that those
        // places require nothing. See `docs/STATE-AGE-LAWS.md`.
        return {
            ...base(),
            country,
            region,
            tier: process.env.AVR_AGE_NON_US === 'verify' ? 'verified' : 'attest',
            methods: process.env.AVR_AGE_NON_US === 'verify' ? ['government_id', 'transactional'] : ATTEST_METHODS,
            reason: 'outside-us'
        };
    }

    // A US viewer whose state did not come through. Same reasoning as above:
    // twenty-seven of fifty-one possibilities require a check, so guessing is
    // not a coin flip we are entitled to take.
    if (!region || !US_REGIONS.has(region)) {
        return {
            ...base(),
            country,
            region: null,
            tier: fallbackTier(),
            methods: fallbackTier() === 'verified' ? ['government_id', 'digitized_id', 'transactional'] : ATTEST_METHODS,
            reason: 'us-state-unresolved'
        };
    }

    const law = STATE_LAWS[region];

    if (!law) {
        return { ...base(), country, region, tier: 'attest', methods: ATTEST_METHODS, reason: 'no-statute' };
    }

    return {
        tier: 'verified',
        country,
        region,
        stateName: law.name,
        citation: law.citation ?? null,
        source: law.source,
        methods: law.methods,
        sessionMinutes: law.sessionMinutes ?? null,
        requiresChoice: Boolean(law.requiresChoice),
        noRetention: Boolean(law.noRetention),
        assuranceLevel: law.assuranceLevel ?? null,
        note: law.note ?? null,
        reason: 'statute'
    };
}

function base() {
    return {
        tier: 'attest',
        country: null,
        region: null,
        stateName: null,
        citation: null,
        source: null,
        methods: ATTEST_METHODS,
        sessionMinutes: null,
        requiresChoice: false,
        noRetention: false,
        assuranceLevel: null,
        note: null,
        reason: 'unknown'
    };
}

/**
 * Resolution and policy in one call, which is how every caller wants it.
 *
 * @param {import('express').Request} req
 * @returns {Policy & {source_: string}}
 */
export function jurisdictionFor(req) {
    const where = resolveRegion(req);
    return { ...policyFor(where), resolvedBy: where.source };
}

/* ------------------------------------------------------------ satisfaction -- */

/**
 * A stored timestamp as milliseconds, whichever of the two forms it is in.
 *
 * Rows in this schema carry both: columns written by JavaScript hold an ISO
 * string, and columns defaulted by SQLite's `datetime('now')` hold
 * `YYYY-MM-DD HH:MM:SS` with no zone marker - which is UTC, but which
 * `Date.parse` reads as *local* time. Left alone that puts Tennessee's hour out
 * by the server's offset: an hour that never ends west of Greenwich and one
 * that ended before it started east of it.
 */
function parseStamp(value) {
    if (typeof value !== 'string') return NaN;

    const text = value.trim();
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

/**
 * Is a passed document check still good enough for this policy?
 *
 * Separate from `ageAssurances.isCurrent` because that answers "did this
 * account ever pass, and has the two-year assurance window run out" - an
 * account-level question with one answer. This answers a per-request question
 * whose answer changes with where the request came from, and in Tennessee
 * changes once an hour.
 *
 * @param {Policy} policy
 * @param {{verified_at?: string|null}|null} assurance a current `age_assurances` row
 * @returns {{ok: boolean, reason: string|null, expiresAt: string|null}}
 */
export function assuranceSatisfies(policy, assurance) {
    if (!assurance) return { ok: false, reason: 'no_assurance', expiresAt: null };

    if (!policy.sessionMinutes) return { ok: true, reason: null, expiresAt: null };

    const verifiedAt = parseStamp(assurance.verified_at);
    if (!Number.isFinite(verifiedAt)) {
        return { ok: false, reason: 'session_expired', expiresAt: null };
    }

    const endsAt = verifiedAt + policy.sessionMinutes * 60_000;
    if (endsAt <= Date.now()) {
        return { ok: false, reason: 'session_expired', expiresAt: new Date(endsAt).toISOString() };
    }

    return { ok: true, reason: null, expiresAt: new Date(endsAt).toISOString() };
}

/**
 * Is a self-declaration enough here, and is this one still live?
 *
 * An attestation never satisfies a `verified` policy. That is the whole point
 * of the two tiers, and it is also what makes a viewer who attested in Oregon
 * and then opened the site in Texas get asked for a document rather than
 * waved through on last month's button press.
 *
 * @param {Policy} policy
 * @param {{attested_at?: string|null, expires_at?: string|null}|null} attestation
 */
export function attestationSatisfies(policy, attestation) {
    if (policy.tier !== 'attest') return { ok: false, reason: 'verification_required' };
    if (!attestation) return { ok: false, reason: 'no_attestation' };

    const expiresAt = parseStamp(attestation.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return { ok: false, reason: 'attestation_expired' };
    }

    return { ok: true, reason: null };
}

/* ----------------------------------------------------------- the client view -- */

/**
 * The policy as the browser needs it: enough to render the right gate and to
 * explain itself, and nothing that would let a client talk its way past one.
 *
 * Note what is absent. There is no "you have passed" field here - that comes
 * from the session payload, which the server owns. A client that believed this
 * object could tell it whether to show the catalogue would be wrong, and the
 * gate that matters is on `/api/catalog` regardless of what this renders.
 *
 * @param {Policy} policy
 */
export function publicPolicy(policy) {
    return {
        tier: policy.tier,
        country: policy.country,
        region: policy.region,
        state: policy.stateName,
        citation: policy.citation,
        statuteUrl: policy.source,
        requiresChoice: policy.requiresChoice,
        sessionMinutes: policy.sessionMinutes,
        methods: policy.methods.map((id) =>
            id === 'attestation'
                ? { id, label: 'Confirm your age', describe: 'Confirm that you are 18 or over.' }
                : { id, ...pick(METHODS[id]) }
        ),
        attestation: policy.tier === 'attest' ? { version: ATTESTATION_VERSION, text: ATTESTATION_TEXT } : null
    };
}

function pick(method) {
    return method ? { label: method.label, describe: method.describe } : { label: 'Verification', describe: '' };
}

/**
 * One line for the boot banner.
 *
 * Said out loud for the same reason the identity provider is: a deployment
 * running without geolocation in front of it looks, from the inside, exactly
 * like one that has it and is seeing only domestic traffic.
 */
export function jurisdictionBanner() {
    const pinned = pinnedRegion();

    if (pinned) {
        return `Age gate     every viewer treated as ${[pinned.country, pinned.region].filter(Boolean).join('-')} (AVR_GEO_DEFAULT_REGION)`;
    }

    const strict = fallbackTier() === 'verified';

    return (
        `Age gate     ${Object.keys(STATE_LAWS).length} states require verification; ` +
        `unresolved viewers ${strict ? 'are verified too' : '⚠ get the button (AVR_GEO_FALLBACK=attest)'}`
    );
}
