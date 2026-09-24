/**
 * In-process memoisation with TTL and explicit invalidation.
 *
 * Deliberately per-node and not shared. Each app node keeps its own copy, so
 * adding nodes never adds coordination; the cost is that an invalidation on one
 * node is not seen by another until its TTL lapses. For catalog data - where
 * being a few seconds stale is harmless - that trade is worth it. Anything
 * needing strict cross-node consistency must not be cached here.
 */

export class TtlCache {
    /**
     * @param {number} ttlMs
     */
    constructor(ttlMs = 5000) {
        this.ttlMs = ttlMs;
        this.entries = new Map();
    }

    /**
     * Return the cached value, computing it if absent or stale.
     *
     * In-flight promises are cached too, so a burst of concurrent requests on a
     * cold key produces one computation rather than one per request - the
     * stampede that turns a slow query into an outage.
     *
     * @template T
     * @param {string} key
     * @param {() => T | Promise<T>} compute
     * @returns {T | Promise<T>}
     */
    get(key, compute) {
        const hit = this.entries.get(key);

        if (hit && hit.expires > Date.now()) return hit.value;

        const value = compute();
        this.entries.set(key, { value, expires: Date.now() + this.ttlMs });

        // Never cache a rejection: a transient failure would otherwise be
        // served for the rest of the TTL.
        if (value && typeof value.then === 'function') {
            value.catch(() => this.entries.delete(key));
        }

        return value;
    }

    invalidate(key) {
        if (key === undefined) this.entries.clear();
        else this.entries.delete(key);
    }

    get size() {
        return this.entries.size;
    }
}
