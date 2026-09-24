import express from 'express';

import { credits, purchases } from '../db/index.js';
import { requireAuth, rateLimit } from '../auth/middleware.js';
import {
    CREDIT_TIERS,
    CUSTOM_MAX_CENTS,
    CUSTOM_MIN_CENTS,
    creditsFor,
    getPaymentProvider,
    validateAmount
} from './providers.js';

/**
 * Buying credits, and reading what happened to them.
 *
 * The rule this file exists to enforce: credits are only ever created by a
 * settled purchase, in the same request that settled it, under an idempotency
 * key derived from the purchase id. There is no other path into the ledger from
 * the outside, so "where did this balance come from" always has an answer with
 * a row behind it.
 *
 * See `docs/MONETISATION.md` for the model, and `db/schema.sql` for why every
 * amount here is an integer number of cents.
 */

/** What a ledger row looks like on a statement. */
function entryView(row) {
    return {
        id: row.id,
        delta: row.delta,
        reason: row.reason,
        refType: row.ref_type,
        refId: row.ref_id,
        balanceAfter: row.balance_after,
        createdAt: row.created_at
    };
}

function purchaseView(row) {
    return {
        id: row.id,
        amountCents: row.amount_cents,
        currency: row.currency,
        credits: row.credits,
        provider: row.provider,
        status: row.status,
        failureReason: row.failure_reason,
        createdAt: row.created_at,
        settledAt: row.settled_at
    };
}

export function accountView(userId) {
    const account = credits.account(userId);

    return {
        balance: account.balance,
        purchased: account.purchased,
        earned: account.earned,
        spent: account.spent
    };
}

/**
 * @param {import('express').Express} app
 */
export function mountCredits(app) {
    const router = express.Router();

    router.use(express.json({ limit: '4kb' }));

    /** Balance, lifetime totals, and what the buy panel should offer. */
    router.get('/', requireAuth, (req, res) => {
        const provider = getPaymentProvider();

        res.set('Cache-Control', 'no-store');
        res.json({
            account: accountView(req.auth.sub),
            tiers: CREDIT_TIERS,
            customMinCents: CUSTOM_MIN_CENTS,
            customMaxCents: CUSTOM_MAX_CENTS,
            // The browser says so on the button. A person spending money has a
            // right to know whether any is being taken.
            provider: { name: provider.name, isStub: provider.isStub }
        });
    });

    router.get('/ledger', requireAuth, (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ entries: credits.history(req.auth.sub, req.query.limit).map(entryView) });
    });

    router.get('/purchases', requireAuth, (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ purchases: purchases.forUser(req.auth.sub).map(purchaseView) });
    });

    /**
     * Buy credits.
     *
     * The purchase row is written *before* the processor is called, so a
     * request that dies halfway leaves a pending row somebody can reconcile
     * rather than money taken against nothing.
     */
    router.post(
        '/purchases',
        requireAuth,
        rateLimit({ windowMs: 60_000, max: 10 }),
        async (req, res, next) => {
            const amount = validateAmount(req.body?.amountCents);

            if (!amount.ok) {
                res.status(400).json({ error: amount.error });
                return;
            }

            const provider = getPaymentProvider();
            const granted = creditsFor(amount.amountCents);

            const purchase = purchases.create({
                userId: req.auth.sub,
                amountCents: amount.amountCents,
                credits: granted,
                provider: provider.name
            });

            try {
                const charge = await provider.createCharge({
                    userId: req.auth.sub,
                    purchaseId: purchase.id,
                    amountCents: amount.amountCents,
                    currency: purchase.currency
                });

                if (!charge.settled) {
                    // A hosted flow. The credits are granted when the processor
                    // says the money arrived, not when the browser comes back
                    // from its page, which is a thing anyone can navigate to.
                    const pending = purchases.settle(purchase.id, 'pending', {
                        providerRef: charge.providerRef
                    });

                    res.status(202).json({
                        purchase: purchaseView(pending),
                        redirectUrl: charge.redirectUrl,
                        account: accountView(req.auth.sub)
                    });
                    return;
                }

                // Keyed on the purchase id, so a retry of this request - or a
                // processor callback arriving for the same charge - finds the
                // entry already written and grants nothing a second time.
                const posted = credits.post({
                    userId: req.auth.sub,
                    delta: granted,
                    reason: 'purchase',
                    refType: 'purchase',
                    refId: purchase.id,
                    idemKey: `purchase:${purchase.id}`
                });

                const paid = purchases.settle(purchase.id, 'paid', { providerRef: charge.providerRef });

                res.status(201).json({
                    purchase: purchaseView(paid),
                    account: accountView(req.auth.sub),
                    balance: posted.balance
                });
            } catch (err) {
                // The row stays, with the reason on it. A purchase that failed
                // silently is the support ticket nobody can answer.
                purchases.settle(purchase.id, 'failed', { failureReason: err.message.slice(0, 200) });
                next(err);
            }
        }
    );

    app.use('/api/credits', router);
}
