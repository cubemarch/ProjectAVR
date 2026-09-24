import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard and ships in Node's standard library, so there is no
 * native build step and no dependency to keep patched. The cost parameters
 * below target roughly 100 ms per hash on current server hardware - slow enough
 * to make offline cracking expensive, fast enough that a login does not tie up
 * the event loop (the async form runs on the threadpool).
 *
 * The parameters are stored inside each hash string, so they can be raised
 * later without invalidating existing passwords: an old hash still verifies
 * against its own recorded cost, and `needsRehash` flags it for upgrade on the
 * next successful login.
 */

const scrypt = promisify(crypto.scrypt);

const DEFAULTS = {
    N: 16384, // CPU/memory cost
    r: 8, // block size
    p: 1, // parallelisation
    keyLength: 32,
    saltLength: 16
};

// scrypt needs maxmem above roughly 128 * N * r bytes, with headroom.
const maxmem = (N, r) => 256 * N * r;

/**
 * @param {string} password
 * @returns {Promise<string>} Encoded as `scrypt$N$r$p$salt$hash`, both base64url.
 */
export async function hashPassword(password) {
    assertPasswordShape(password);

    const { N, r, p, keyLength, saltLength } = DEFAULTS;
    const salt = crypto.randomBytes(saltLength);
    const derived = await scrypt(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: maxmem(N, r) });

    return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Always performs the full derivation - including for unknown users, where the
 * caller should pass a dummy hash - so response timing does not reveal whether
 * an account exists.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;

    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);

    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // Reject absurd parameters from a tampered row rather than allocating GBs.
    if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

    let salt;
    let expected;
    try {
        salt = Buffer.from(parts[4], 'base64url');
        expected = Buffer.from(parts[5], 'base64url');
    } catch {
        return false;
    }

    if (!salt.length || !expected.length) return false;

    let derived;
    try {
        derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
            N,
            r,
            p,
            maxmem: maxmem(N, r)
        });
    } catch {
        return false;
    }

    return crypto.timingSafeEqual(derived, expected);
}

/** True when a stored hash used weaker parameters than we now require. */
export function needsRehash(stored) {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
    return Number(parts[1]) < DEFAULTS.N;
}

/**
 * A syntactically valid hash of a random value, used as the comparison target
 * when an email does not exist so that path costs the same as a real
 * verification.
 *
 * Built on first use rather than at module load: a top-level await here would
 * add its ~100 ms to the startup of every module that imports this one.
 *
 * @returns {Promise<string>}
 */
let dummyHashPromise = null;
export function getDummyHash() {
    dummyHashPromise ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
    return dummyHashPromise;
}

function assertPasswordShape(password) {
    if (typeof password !== 'string') {
        throw new Error('Password must be a string');
    }
    if (password.length < 10) {
        throw new Error('Password must be at least 10 characters');
    }
    // scrypt itself has no length ceiling, but an unbounded input is a cheap
    // way for a client to burn server CPU.
    if (password.length > 256) {
        throw new Error('Password must be at most 256 characters');
    }
}
