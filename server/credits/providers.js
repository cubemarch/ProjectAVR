/**
 * Payment providers.
 *
 * Taking money is the one part of this product that cannot be written twice.
 * So the ledger, the purchase row, the idempotency key and the per-minute
 * billing are all real and all tested, and the thing that actually moves money
 * is behind this interface with exactly one implementation: a stub that moves
 * none. Wiring a processor in later is writing a second object with these four
 * methods, not rewriting the accounting.
 *
 * @typedef {object} Checkout
 * @property {string} providerRef - The processor's id for this charge.
 * @property {string|null} redirectUrl - Hosted payment page, if there is one.
 * @property {boolean} settled - True if the money is already taken and the
 *   credits can be granted in this request.
 *
 * @typedef {object} ChargeStatus
 * @property {'pending'|'paid'|'failed'} status
 * @property {string|null} failureReason
 *
 * @typedef {object} PaymentProvider
 * @property {string} name
 * @property {boolean} isStub
 * @property {(input: {userId: string, purchaseId: string, amountCents: number, currency: string}) => Promise<Checkout>} createCharge
 * @property {(providerRef: string) => Promise<ChargeStatus>} fetchCharge
 */

/**
 * The amounts the buy-credits panel offers, in cents.
 *
 * Cents rather than dollars because a credit is a cent and the rest of the
 * subsystem never sees a dollar; the browser is the only place that divides.
 */
export const CREDIT_TIERS = [1000, 2500, 5000, 10000];

/**
 * The bounds on "Other".
 *
 * A floor because a $0.50 purchase costs more in processor fees than it is
 * worth, and a ceiling because the largest number a person types by accident is
 * usually the one with an extra zero on it.
 */
export const CUSTOM_MIN_CENTS = 500;
export const CUSTOM_MAX_CENTS = 50_000;

/**
 * Credits granted for an amount paid.
 *
 * One for one, deliberately: a bonus-credits tier is a pricing decision that
 * belongs in one function when somebody makes it, and the purchase row already
 * stores `amount_cents` and `credits` separately so making that change later
 * does not touch the schema.
 */
export function creditsFor(amountCents) {
    return Math.trunc(amountCents);
}

/**
 * Whether an amount is one this server will accept.
 *
 * @returns {{ok: true, amountCents: number} | {ok: false, error: string}}
 */
export function validateAmount(input) {
    const amountCents = Math.trunc(Number(input));

    if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return { ok: false, error: 'amountCents must be a positive whole number of cents' };
    }

    if (CREDIT_TIERS.includes(amountCents)) return { ok: true, amountCents };

    if (amountCents < CUSTOM_MIN_CENTS || amountCents > CUSTOM_MAX_CENTS) {
        return {
            ok: false,
            error: `a custom amount must be between $${CUSTOM_MIN_CENTS / 100} and $${CUSTOM_MAX_CENTS / 100}`
        };
    }

    return { ok: true, amountCents };
}

/* ------------------------------------------------------------------- stub -- */

let stubCounter = 0;
let warned = false;

/**
 * A processor that takes no money and always succeeds.
 *
 * Every purchase it settles is recorded with `provider = 'stub'`, permanently,
 * so a demo balance can always be told apart from a paid one by a query rather
 * than by remembering which environment it came from. It also says so on the
 * console the first time it is used, because a payment provider that silently
 * approves everything is exactly the thing that should be impossible to run in
 * production without noticing.
 */
export function stubProvider() {
    return {
        name: 'stub',
        isStub: true,

        async createCharge({ purchaseId }) {
            if (!warned) {
                warned = true;
                console.warn(
                    '[payments] AVR_PAYMENTS_PROVIDER=stub - credits are being granted without taking any money. ' +
                        'Set a real provider before this server sees a real customer.'
                );
            }

            stubCounter += 1;
            return { providerRef: `stub_${purchaseId.slice(0, 8)}_${stubCounter}`, redirectUrl: null, settled: true };
        },

        async fetchCharge() {
            return { status: 'paid', failureReason: null };
        }
    };
}

/* --------------------------------------------------------------- selection -- */

const PROVIDERS = { stub: stubProvider };

let cached = null;

/**
 * The configured provider.
 *
 * An unrecognised name is fatal, for the same reason it is in
 * `identity/providers.js`: falling back to the stub would turn a typo into a
 * server that hands out credits for free and reports itself as working.
 *
 * @returns {PaymentProvider}
 */
export function getPaymentProvider() {
    if (cached) return cached;

    const wanted = process.env.AVR_PAYMENTS_PROVIDER || 'stub';
    const make = PROVIDERS[wanted];

    if (!make) {
        throw new Error(
            `AVR_PAYMENTS_PROVIDER=${wanted} is not a provider this server has. ` +
                `Known: ${Object.keys(PROVIDERS).join(', ')}.`
        );
    }

    cached = make();
    return cached;
}

/** Tests swap providers between cases; nothing else should call this. */
export function resetPaymentProvider() {
    cached = null;
    warned = false;
}

/** One line for the startup banner, so a stub is visible without reading env. */
export function paymentsBanner() {
    const provider = getPaymentProvider();
    return (
        `Payments     ${provider.name}` +
        (provider.isStub ? '  ⚠ STUB — grants credits without taking any money' : '')
    );
}
