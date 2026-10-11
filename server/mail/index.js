import crypto from 'node:crypto';

import { emailMessages } from '../db/index.js';
import { deriveKey } from '../auth/tokens.js';
import { getMailProvider, publicOrigin } from './providers.js';
import { TEMPLATES, render } from './templates.js';

/**
 * Sending email.
 *
 * One entry point, `notify`, and three rules it enforces that the callers
 * must not be trusted to remember:
 *
 *   1. A message whose template is `marketing` goes nowhere unless the account
 *      has opted in. The check is here, on the category the template declares,
 *      rather than at each call site. A call site that forgets is the whole
 *      failure mode this subsystem has to be immune to.
 *
 *   2. Every attempt is written to `email_messages`, including the ones that
 *      are suppressed and the ones the transport refuses. See the comment on
 *      that table for why the suppressed ones are the interesting rows.
 *
 *   3. It never throws and never blocks the thing that triggered it. An
 *      account whose welcome email bounced is still an account; a 500 on
 *      `POST /register` because a mail API was briefly down would be a far
 *      worse outcome than a missing email, and the delivery log means the
 *      failure is still visible afterwards.
 *
 * Rule 3 is why callers do not `await` this. They call it and move on.
 */

/* --------------------------------------------------------------- sending -- */

/** In-flight sends, so shutdown and tests can wait for them. */
const inFlight = new Set();

/**
 * Send the email for something that happened. Fire and forget.
 *
 * @param {string} kind - a key of {@link TEMPLATES}
 * @param {object|null} user - the `users` row; null or address-less is suppressed
 * @param {object} [data] - whatever the template needs
 * @returns {Promise<object|null>} the delivery-log row. Never rejects.
 */
export function notify(kind, user, data = {}) {
    const work = deliver(kind, user, data).catch((err) => {
        // Only reachable if the logging itself failed - `deliver` handles
        // transport errors internally. Nothing left to do but say so.
        console.error(`[mail] ${kind} could not be recorded:`, err.message);
        return null;
    });

    inFlight.add(work);
    work.finally(() => inFlight.delete(work));

    return work;
}

/** Wait for every in-flight send. For shutdown, and for tests that assert on the log. */
export async function drainMail() {
    while (inFlight.size) await Promise.all([...inFlight]);
}

async function deliver(kind, user, data) {
    const template = TEMPLATES[kind];
    if (!template) throw new Error(`no email template named ${kind}`);

    const provider = getMailProvider();
    const recipient = user?.email ?? null;

    const suppression = suppressedBecause(template.category, user);
    const unsubscribe = template.category === 'marketing' && user ? unsubscribeUrl(user.id) : null;

    const { subject, text, html } = render(kind, data, { origin: publicOrigin(), unsubscribeUrl: unsubscribe });

    const row = emailMessages.open({
        userId: user?.id ?? null,
        kind,
        category: template.category,
        recipient: recipient ?? '(none)',
        subject,
        provider: provider.name,
        status: suppression ? 'suppressed' : 'queued',
        detail: suppression
    });

    if (suppression) return row;

    try {
        const { providerRef } = await provider.send({
            to: recipient,
            subject,
            text,
            html,
            bulk: template.category === 'marketing',
            headers: unsubscribe
                ? {
                      // RFC 8058. The POST form is what lets Gmail and Outlook
                      // show their own one-click unsubscribe control, which is
                      // the one people actually use instead of the spam button.
                      'List-Unsubscribe': `<${unsubscribe}>`,
                      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                  }
                : undefined
        });

        return emailMessages.settle(row.id, 'sent', { providerRef });
    } catch (err) {
        console.error(`[mail] ${kind} to ${recipient} failed:`, err.message);
        return emailMessages.settle(row.id, 'failed', { detail: err.message });
    }
}

/**
 * Why this message is not being sent, or null if it is.
 *
 * @param {import('./templates.js').MailCategory} category
 * @param {object|null} user
 * @returns {string|null}
 */
function suppressedBecause(category, user) {
    if (!user?.email) return 'no address on the account';
    if (category !== 'marketing') return null;

    if (!user.marketing_emails) return 'not opted in to marketing email';
    if (user.disabled) return 'account is disabled';

    return null;
}

/* ----------------------------------------------------------- unsubscribe -- */

/**
 * The unsubscribe link's proof.
 *
 * An HMAC over the account id rather than a column, so there is nothing to
 * store, nothing to expire and nothing to leak. It is deliberately not a
 * session token: it authorises exactly one irreversible-in-the-safe-direction
 * action - turning marketing off - and nothing else. It never expires, because
 * an unsubscribe link that stops working is worse than useless; rotating
 * `AVR_JWT_SECRET` invalidates every one of them at once if that is ever
 * needed.
 *
 * @param {string} userId
 */
export function unsubscribeToken(userId) {
    return crypto.createHmac('sha256', deriveKey('unsubscribe')).update(String(userId)).digest('base64url');
}

/** Constant-time, so the token cannot be recovered a byte at a time. */
export function unsubscribeTokenValid(userId, token) {
    const expected = Buffer.from(unsubscribeToken(userId));
    const given = Buffer.from(String(token ?? ''));

    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** @param {string} userId */
export function unsubscribeUrl(userId) {
    const query = new URLSearchParams({ u: userId, t: unsubscribeToken(userId) });
    return `${publicOrigin()}/unsubscribe?${query}`;
}
