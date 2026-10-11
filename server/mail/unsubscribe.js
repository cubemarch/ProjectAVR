import express from 'express';

import { BRAND } from '../../brand.js';
import { users } from '../db/index.js';
import { unsubscribeTokenValid } from './index.js';

/**
 * The unsubscribe link, and the one-click endpoint behind it.
 *
 * No session. Someone who has stopped wanting our email is exactly the person
 * least willing to sign in to say so, and a link that demands a password
 * before it will honour an unsubscribe is how a mailing list earns spam
 * complaints instead of opt-outs. The HMAC in the URL is the whole
 * authorisation, and it can do nothing except turn marketing off - see
 * `unsubscribeToken`.
 *
 * ## Why GET does not unsubscribe
 *
 * Every corporate mail gateway, link scanner and preview generator fetches the
 * URLs in an email before a human sees them. If GET performed the opt-out,
 * subscribers would be unsubscribed by their employer's virus scanner, and
 * nobody would ever find out why the list was shrinking. So GET renders a page
 * with one button, and POST is what acts - which is also the shape RFC 8058
 * one-click requires, so the `List-Unsubscribe-Post` header on the message and
 * the button on this page hit the same endpoint.
 */
export const UNSUBSCRIBE_PATH = '/unsubscribe';

/**
 * @param {import('express').Express} app
 */
export function mountUnsubscribe(app) {
    const form = express.urlencoded({ extended: false, limit: '2kb' });

    app.get(UNSUBSCRIBE_PATH, (req, res) => {
        const user = resolve(req.query.u, req.query.t);

        res.set('Cache-Control', 'no-store');

        if (!user) {
            res.status(400).type('html').send(page({ heading: 'That link is not valid', body: EXPIRED, form: null }));
            return;
        }

        if (!user.marketing_emails) {
            res.type('html').send(page({ heading: 'Already unsubscribed', body: DONE, form: null }));
            return;
        }

        res.type('html').send(
            page({
                heading: `Unsubscribe ${escapeHtml(user.email)}?`,
                body: `<p>You will stop receiving news and offers from ${escapeHtml(BRAND)}.</p>
                       <p class="quiet">Receipts, security notices and the results of identity checks
                       will still be sent. Those are part of your account, not marketing.</p>`,
                form: { u: String(req.query.u), t: String(req.query.t) }
            })
        );
    });

    app.post(UNSUBSCRIBE_PATH, form, (req, res) => {
        // Mail clients doing RFC 8058 one-click post the form body, not the
        // query string, and some post the query string; accept either.
        const id = req.body?.u ?? req.query.u;
        const token = req.body?.t ?? req.query.t;

        const user = resolve(id, token);

        if (!user) {
            res.status(400).set('Cache-Control', 'no-store');
            res.type('html').send(page({ heading: 'That link is not valid', body: EXPIRED, form: null }));
            return;
        }

        users.setMarketingEmails(user.id, false);

        res.set('Cache-Control', 'no-store');
        res.type('html').send(page({ heading: 'Unsubscribed', body: DONE, form: null }));
    });
}

/** @returns {object|null} the account, if the signature over its id checks out */
function resolve(id, token) {
    if (typeof id !== 'string' || typeof token !== 'string') return null;
    if (!unsubscribeTokenValid(id, token)) return null;

    return users.byId(id);
}

/* ----------------------------------------------------------------- page -- */

const EXPIRED = `<p>The link may have been truncated by your mail client, or the address it was
    issued for no longer exists.</p>
    <p class="quiet">You can change this from your profile at any time.</p>`;

const DONE = `<p>You will no longer receive news or offers from ${escapeHtml(BRAND)}.</p>
    <p class="quiet">Receipts, security notices and the results of identity checks will still be
    sent. Those are part of your account, not marketing. You can opt back in from your profile.</p>`;

function page({ heading, body, form }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Email preferences &mdash; ${escapeHtml(BRAND)}</title>
<style>
    html { color-scheme: dark; }
    body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        padding: 2rem 1.5rem; box-sizing: border-box;
        background: #0b0b0f; color: #e8e8ee;
        font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    main { max-width: 26rem; }
    h1 { font-size: 1.2rem; margin: 0 0 1rem; }
    p { margin: 0 0 1rem; }
    .quiet { color: #9a9aa8; font-size: 0.9em; }
    button {
        font: inherit; font-weight: 600; cursor: pointer;
        padding: 0.7rem 1.4rem; border: 0; border-radius: 8px;
        background: #e11d48; color: #fff;
    }
    a { color: #9a9aa8; }
</style>
</head>
<body>
<main>
    <h1>${heading}</h1>
    ${body}
    ${
        form
            ? `<form method="post" action="${escapeHtml(UNSUBSCRIBE_PATH)}">
                   <input type="hidden" name="u" value="${escapeHtml(form.u)}" />
                   <input type="hidden" name="t" value="${escapeHtml(form.t)}" />
                   <button type="submit">Unsubscribe</button>
               </form>`
            : `<p><a href="/">Back to ${escapeHtml(BRAND)}</a></p>`
    }
</main>
</body>
</html>
`;
}

function escapeHtml(str) {
    return String(str).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}
