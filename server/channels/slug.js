/**
 * Channel names, and the words nobody may take.
 *
 * A channel name is the whole public address of a creator: `/<name>`, at the
 * root of the site. That is the shortest and most memorable form available, and
 * it is also the most dangerous one to hand out, because the root namespace is
 * shared with every route the server has and every route it will ever have.
 * `/live` is a document. `/api` is the API. `/unsubscribe` is a link inside
 * other people's mail. If a creator can be called `api`, one signup silently
 * breaks the application.
 *
 * So the rule is inverted from the usual one: a name is refused unless it is
 * provably safe, and the list below is long on purpose. It costs a creator one
 * retry to pick another name. It costs everybody else an outage, a support
 * queue or an impersonation to get this wrong, and a name once issued is in
 * links, in headsets and in other people's bookmarks - it cannot be taken back
 * cheaply.
 *
 * Three layers, checked in this order:
 *
 *   1. Shape. Length, character set, and the structural rules that keep a name
 *      from being mistaken for an id, a file or an encoded hostname.
 *   2. Reserved words. The list here, plus whatever a superuser has reserved at
 *      runtime - see `reservedSlugs` in `server/db/index.js`.
 *   3. Uniqueness, which only the database can answer.
 *
 * This module does 1 and 2 and holds no state, so it can be tested on its own
 * and reasoned about without a database.
 */

import { BRAND } from '../../brand.js';

/** Shortest allowed. Two characters is not a name, it is a collision. */
export const SLUG_MIN = 3;

/**
 * Longest allowed. Past this a name stops being an address somebody can say
 * out loud, which is the only reason to be at the root of the site at all.
 */
export const SLUG_MAX = 30;

/**
 * Lowercase, alphanumeric, hyphens inside only.
 *
 * No underscore: it disappears under the underline that every browser, chat
 * client and headset overlay draws on a link, so `my_channel` and `mychannel`
 * are the same string to a reader. No dot: it would make a name look like a
 * file, and `/dana.m3u` would have to be disambiguated from the playlist route
 * next to it. No leading or trailing hyphen, because both are invisible at the
 * ends of a word.
 */
const SHAPE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * Two hyphens in a row.
 *
 * Banned because `xn--` is the punycode prefix: a name containing it can be
 * rendered by some clients as an entirely different string in another script,
 * which is a homograph attack with extra steps. Nothing legitimate needs it.
 */
const DOUBLE_HYPHEN = /--/;

/**
 * Confusable-glyph skeleton.
 *
 * Reserved words are compared on this rather than literally, because a reserved
 * list that only blocks the exact spelling blocks nothing: `admin` is taken, so
 * the next person registers `adm1n`, `admln` or `adrnin` and is indistinguishable
 * from staff in every place a name is displayed at normal reading size.
 *
 * Each class of glyphs that renders alike is folded to one representative. The
 * digits are the obvious half; `rn`→`m` and `vv`→`w` are the half people forget,
 * and they are applied first so the letters they produce are then folded too.
 *
 * This is deliberately aggressive, and it does reject a small number of innocent
 * names whose skeleton happens to land on a reserved word. That is the correct
 * trade: the cost of a false positive is picking a different name, and the cost
 * of a false negative is somebody being impersonated by their own platform -
 * on a site where the impersonator could be soliciting payment.
 */
export function skeleton(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[-_\s.]/g, '')
        .replace(/rn/g, 'm')
        .replace(/vv/g, 'w')
        .replace(/[o0]/g, '0')
        .replace(/[il1|!]/g, '1')
        .replace(/[e3]/g, '3')
        .replace(/[a4@]/g, '4')
        .replace(/[s5$]/g, '5')
        .replace(/[t7]/g, '7')
        .replace(/[b8]/g, '8')
        .replace(/[gq9]/g, '9')
        .replace(/[z2]/g, '2');
}

/**
 * Words no ordinary account may hold.
 *
 * Grouped by why, because the groups age differently - the route list has to be
 * checked against the router when a route is added, while the impersonation list
 * only ever grows. A word may appear in more than one group; it is a Set.
 */
const RESERVED_GROUPS = {
    /**
     * Paths this server actually mounts today.
     *
     * Taken from the route table, not from memory: everything above the SPA
     * catch-all in `server/index.js`, plus the two client-side routes the
     * browser owns. If you add a top-level route, add it here in the same
     * commit - a name issued before the route exists will still be there
     * afterwards, and the creator holding it will have a channel that the
     * router shadows.
     */
    routes: [
        'api', 'art', 'assets', 'catalog', 'creator', 'delivery', 'deovr',
        'dlna', 'identity', 'live', 'media', 'pair', 'playlist', 'portal',
        'profile', 'stream', 'studio', 'transcode', 'unsubscribe', 'watch',
        'broadcast', 'recordings', 'rooms', 'health', 'auth', 'credits',
        'uploads', 'hls', 'ws', 'static', 'public', 'dist', 'files', 'comic',
        'comics'
    ],

    /**
     * Files served from the document root, and the names browsers and crawlers
     * fetch without being told to. A channel here would be shadowed by a static
     * file, or would shadow one.
     */
    wellKnown: [
        'index', 'favicon', 'robots', 'sitemap', 'manifest', 'humans',
        'security', 'ads', 'app-ads', 'browserconfig', 'crossdomain',
        'serviceworker', 'sw', 'well-known', 'apple-touch-icon', 'opensearch'
    ],

    /**
     * Names that read as infrastructure.
     *
     * These matter even though the site is path-addressed, because a channel
     * name is pasted into places that are host-addressed - a link in a bio, a
     * QR code on a poster - and the site's own domain followed by `/mail`
     * being a person is a phishing primitive that costs nothing to prevent.
     */
    infrastructure: [
        'www', 'web', 'mail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'ftp',
        'sftp', 'ssh', 'ns', 'ns1', 'ns2', 'dns', 'mx', 'cdn', 'edge', 'origin',
        'proxy', 'gateway', 'router', 'localhost', 'host', 'server', 'servers',
        'cluster', 'node', 'db', 'database', 'cache', 'redis', 'queue', 'worker',
        'cron', 'job', 'jobs', 'log', 'logs', 'metrics', 'status', 'ping',
        'monitor', 'graphql', 'grpc', 'rpc', 'rest', 'v1', 'v2', 'v3', 'beta',
        'alpha', 'dev', 'test', 'testing', 'staging', 'stage', 'prod',
        'production', 'sandbox', 'demo', 'example', 'localdomain', 'internal'
    ],

    /**
     * Authority. The group that exists because of impersonation rather than
     * collision, and the one the confusables folding above is really for.
     */
    authority: [
        'admin', 'admins', 'administrator', 'root', 'superuser', 'super',
        'sudo', 'owner', 'staff', 'team', 'crew', 'official', 'verified',
        'moderator', 'mod', 'mods', 'support', 'helpdesk', 'help', 'service',
        'customerservice', 'trust', 'safety', 'security', 'abuse', 'report',
        'reports', 'legal', 'compliance', 'billing', 'payments', 'payment',
        'finance', 'accounts', 'accounting', 'payouts', 'refund', 'refunds',
        'system', 'sysadmin', 'operator', 'ops', 'bot', 'bots', 'daemon',
        'anonymous', 'nobody', 'everyone', 'all', 'null', 'undefined', 'none'
    ],

    /**
     * RFC 2142 and the rest of the mailbox names a domain is expected to answer.
     * A person holding one of these can receive mail that was meant for the
     * organisation the moment anybody wires addresses to channel names.
     */
    mailboxes: [
        'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply',
        'donotreply', 'do-not-reply', 'info', 'contact', 'enquiries',
        'inquiries', 'sales', 'marketing', 'press', 'media-enquiries',
        'newsletter', 'notifications', 'alerts', 'notify'
    ],

    /**
     * The account and session surfaces. Some of these are not routes here yet
     * and are reserved precisely so they can become routes later without having
     * to take a name off somebody.
     */
    account: [
        'login', 'signin', 'sign-in', 'logout', 'signout', 'sign-out', 'signup',
        'sign-up', 'register', 'registration', 'join', 'account', 'accounts',
        'me', 'my', 'mine', 'user', 'users', 'member', 'members', 'profiles',
        'settings', 'preferences', 'config', 'configuration', 'password',
        'passwords', 'reset', 'forgot', 'verify', 'verification', 'confirm',
        'confirmation', 'activate', 'oauth', 'sso', 'session', 'sessions',
        'token', 'tokens', 'key', 'keys', 'secret', 'secrets', 'invite',
        'invites', 'referral', 'referrals', 'dashboard', 'console', 'manage',
        'management', 'moderation'
    ],

    /**
     * Age assurance, identity and records.
     *
     * This group is specific to an adult platform. A creator called `age`,
     * `verify-id` or `2257` would be a page people trust with a document scan,
     * and the records-custodian address in particular is a legal notice rather
     * than a person - see `docs/IDENTITY.md`.
     */
    compliance: [
        'age', 'ageverification', 'age-verification', 'adult', '18', '18plus',
        'eighteen', 'id', 'ids', 'idcheck', 'id-check', 'kyc', 'enrol',
        'enroll', 'enrolment', 'enrollment', 'consent', 'consents',
        'agreement', 'agreements', 'release', 'releases', 'records',
        'recordkeeping', 'custodian', '2257', 'usc2257', 'section2257',
        'takedown', 'csam', 'ncii', 'blocklist', 'appeal', 'appeals'
    ],

    /**
     * Navigation and content surfaces. Same reasoning as `account`: these are
     * the words a site reaches for when it grows a page, and reserving them now
     * is free.
     */
    surfaces: [
        'home', 'index', 'browse', 'explore', 'discover', 'search', 'find',
        'trending', 'popular', 'featured', 'recommended', 'new', 'latest',
        'top', 'best', 'random', 'all', 'feed', 'feeds', 'rss', 'atom',
        'subscriptions', 'following', 'followers', 'library', 'collection',
        'collections', 'playlists', 'queue', 'history', 'mylist', 'my-list',
        'favourites', 'favorites', 'likes', 'saved', 'bookmarks', 'channel',
        'channels', 'category', 'categories', 'tag', 'tags', 'genre', 'genres',
        'video', 'videos', 'clip', 'clips', 'title', 'titles', 'show', 'shows',
        'episode', 'episodes', 'series', 'movie', 'movies', 'film', 'films',
        'broadcasts', 'streams', 'streaming', 'player', 'play', 'embed',
        'share', 'go', 'link', 'links', 'url', 'short', 'qr', 'download',
        'downloads', 'upload', 'inbox', 'messages', 'chat', 'comments',
        'reactions', 'private', 'market', 'waiting'
    ],

    /**
     * Commerce, policy and the pages a regulator or a payment processor expects
     * to be able to find at a predictable address.
     */
    policy: [
        'about', 'aboutus', 'company', 'careers', 'jobs', 'blog', 'news',
        'docs', 'documentation', 'guide', 'guides', 'faq', 'faqs', 'learn',
        'tutorial', 'tutorials', 'terms', 'tos', 'eula', 'privacy', 'policy',
        'policies', 'cookies', 'gdpr', 'ccpa', 'dmca', 'copyright', 'licence',
        'license', 'disclaimer', 'accessibility', 'imprint', 'impressum',
        'pricing', 'plans', 'plan', 'premium', 'pro', 'upgrade', 'subscribe',
        'subscription', 'checkout', 'cart', 'order', 'orders', 'invoice',
        'invoices', 'receipt', 'receipts', 'gift', 'gifts', 'promo', 'coupon',
        'discount', 'affiliate', 'partners', 'advertise', 'advertising',
        'sponsor', 'sponsors', 'donate', 'tip', 'tips', 'ledger', 'wallet',
        'balance', 'topup', 'top-up', 'purchase', 'purchases', 'earnings',
        'payout'
    ],

    /**
     * This product, its past names and the things it talks to.
     *
     * The brand itself is folded in from `brand.js` rather than written out, so
     * a rename cannot leave the old name claimable on the next deploy. The
     * literals beside it are the names this codebase has shipped under or
     * alongside, and they stay reserved after a rename for exactly the same
     * reason an expired domain stays dangerous.
     */
    brand: [
        'lustxr', 'carnal3d', 'avr', 'projectavr', 'vrecord', 'avrcapture',
        'questjam', 'deo', 'deovr', 'skybox', 'pigasus', 'heresphere',
        'quest', 'oculus', 'vive', 'pico', 'valve', 'index', 'vision',
        'visionpro', 'steamvr', 'openxr', 'webxr', 'lustyx', 'lusty-x'
    ]
};

/**
 * Every reserved word, flattened.
 *
 * Exported because the settings UI shows the count and the superuser console
 * lists them, and because a test asserts that the route group still matches the
 * router.
 */
export const RESERVED_SLUGS = new Set(Object.values(RESERVED_GROUPS).flat().concat(BRAND.toLowerCase()));

/** The groups, for a UI that wants to explain *why* a word is refused. */
export { RESERVED_GROUPS };

/** Skeletons of the built-in list, computed once. */
const RESERVED_SKELETONS = new Set([...RESERVED_SLUGS].map(skeleton));

/**
 * Is this name reserved, allowing for confusable spellings?
 *
 * @param {string} slug - Already shape-checked and lowercased.
 * @param {Iterable<string>} [extra] - Runtime reservations from the database.
 */
export function isReserved(slug, extra = []) {
    const shape = skeleton(slug);
    if (RESERVED_SKELETONS.has(shape)) return true;

    for (const word of extra) {
        if (skeleton(word) === shape) return true;
    }

    return false;
}

/**
 * Fold whatever the creator typed towards a legal name, without judging it.
 *
 * Separate from validation on purpose. This is what turns a display name into a
 * suggestion and what forgives a pasted `/Dana/` or a stray capital; it is not
 * what decides whether the result may be used, because silently rewriting
 * somebody's chosen name into a different one that happens to be free is worse
 * than telling them it is taken.
 */
export function normaliseSlug(input) {
    return String(input ?? '')
        .normalize('NFKD')
        // Strip the combining marks NFKD just separated out, so an accented
        // name folds to its base letters rather than to nothing. Written as
        // escapes because the literal range is invisible in an editor.
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, SLUG_MAX)
        // The slice can leave a trailing hyphen behind.
        .replace(/-+$/g, '');
}

/**
 * A starting suggestion for a creator who has not chosen one.
 *
 * Returns null rather than a fallback when the display name has nothing usable
 * in it - a name made entirely of emoji or of a script this folds away should
 * produce an empty field for the creator to fill, not `user-7` presented as
 * though the system had an opinion.
 */
export function suggestSlug(displayName) {
    const slug = normaliseSlug(displayName);
    return slug.length >= SLUG_MIN ? slug : null;
}

/**
 * Decide whether a name may be used.
 *
 * Shape and reservation only. Uniqueness is the database's answer and is
 * checked by the caller, because it is the one part that can change between
 * this returning ok and the row being written.
 *
 * @param {unknown} input - Raw, as typed.
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.extraReserved] - Runtime reservations.
 * @param {boolean} [opts.allowReserved] - Superusers may hold reserved names;
 *   this is how the platform's own channels get the names everybody else
 *   cannot. It does not relax the shape rules, which exist to stop a name
 *   breaking the router rather than to stop it being claimed.
 * @returns {{ok: true, slug: string}|{ok: false, error: string, code: string}}
 */
export function validateSlug(input, { extraReserved = [], allowReserved = false } = {}) {
    const slug = String(input ?? '').trim().toLowerCase();

    if (!slug) {
        return { ok: false, code: 'slug_required', error: 'Pick a channel name.' };
    }

    if (slug.length < SLUG_MIN) {
        return {
            ok: false,
            code: 'slug_too_short',
            error: `Channel names are at least ${SLUG_MIN} characters.`
        };
    }

    if (slug.length > SLUG_MAX) {
        return {
            ok: false,
            code: 'slug_too_long',
            error: `Channel names are at most ${SLUG_MAX} characters.`
        };
    }

    if (!SHAPE.test(slug)) {
        return {
            ok: false,
            code: 'slug_shape',
            error: 'Use lowercase letters, numbers and hyphens, starting and ending with a letter or number.'
        };
    }

    if (DOUBLE_HYPHEN.test(slug)) {
        return {
            ok: false,
            code: 'slug_double_hyphen',
            error: 'Two hyphens in a row are not allowed.'
        };
    }

    // A name that is only digits reads as a record id wherever it appears, and
    // the first time anything in this codebase accepts an id or a name in the
    // same position, it becomes one.
    if (/^\d+$/.test(slug)) {
        return {
            ok: false,
            code: 'slug_numeric',
            error: 'Channel names need at least one letter.'
        };
    }

    if (!allowReserved && isReserved(slug, extraReserved)) {
        return {
            ok: false,
            code: 'slug_reserved',
            error: 'That name is reserved. Please choose another.'
        };
    }

    return { ok: true, slug };
}
