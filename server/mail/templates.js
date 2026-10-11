import { BRAND } from '../../brand.js';

/**
 * Every email this server sends, in one file.
 *
 * A catalogue rather than template strings scattered through the handlers
 * that trigger them. Two things fall out of that which are worth the
 * indirection:
 *
 *   The category of a message is declared next to its wording, so "is this
 *   one people can turn off?" is answered by the template and not by whoever
 *   is calling it. `server/mail/index.js` reads `category` and nothing else
 *   when deciding to suppress.
 *
 *   The whole list of what an account can receive is readable in one screen,
 *   which is what you need when someone asks why they got an email.
 *
 * ## The three categories
 *
 * **transactional** — the account asked for this, directly or by doing the
 * thing it reports. A receipt, the result of a check they started, the
 * confirmation of a signup. Not optional: turning off the receipt for money
 * you were charged is not a preference anyone benefits from, and the
 * anti-spam regimes that matter (CAN-SPAM, GDPR, PECR) all carve these out
 * from consent requirements precisely because they are part of the
 * transaction rather than promotion of it.
 *
 * **security** — something changed about who can get into the account. The
 * whole value of these is that they arrive even when - especially when - the
 * person who caused the change would rather they did not. Never optional.
 *
 * **marketing** — everything else. Requires an explicit opt-in that defaults
 * to off, carries an unsubscribe link, and is the only category
 * `users.marketing_emails` governs.
 *
 * A template that cannot honestly claim to be one of the first two is the
 * third. "Your favourite creator is live" is marketing; do not file it under
 * transactional because it happens to be timely.
 */

/** @typedef {'transactional'|'security'|'marketing'} MailCategory */

/**
 * @typedef {object} MailBody
 * @property {string} subject
 * @property {string} heading
 * @property {string[]} lines - Paragraphs. Plain text; the renderer escapes.
 * @property {{label: string, path: string}} [action] - One button, app-relative.
 * @property {string} [footnote] - Small print under the button.
 */

/**
 * @typedef {object} MailTemplate
 * @property {MailCategory} category
 * @property {(data: object) => MailBody} build
 */

/** @type {Record<string, MailTemplate>} */
export const TEMPLATES = {
    /* ------------------------------------------------------- the account -- */

    welcome: {
        category: 'transactional',
        build: ({ displayName, creator }) => ({
            subject: `Welcome to ${BRAND}`,
            heading: `Welcome, ${displayName}`,
            lines: [
                `Your ${BRAND} account is ready.`,
                creator
                    ? 'One thing left before you can broadcast: the identity check. It takes a photo of a government ID and a short face scan, and it only happens once.'
                    : 'Before you can watch anything you will be asked to confirm your age with a government-issued document. It happens once.',
                'If you did not create this account, reply to this email and we will remove it.'
            ],
            action: { label: `Open ${BRAND}`, path: '/' }
        })
    },

    'creator-enabled': {
        category: 'transactional',
        build: ({ displayName }) => ({
            subject: `You are now a creator on ${BRAND}`,
            heading: `Your account can broadcast, ${displayName}`,
            lines: [
                'You accepted the creator agreement, so your account now has the creator role: your own per-minute pricing, 1:1 calls, and the studio.',
                'Broadcasting is gated separately on the identity check. Until that passes, the studio will keep asking for it.'
            ],
            action: { label: 'Open the studio', path: '/studio' }
        })
    },

    /* ------------------------------------------------------ identity -- */

    'age-verified': {
        category: 'transactional',
        build: ({ expiresAt }) => ({
            subject: 'Your age check passed',
            heading: 'You are verified',
            lines: [
                'Our identity provider confirmed your date of birth from the document you photographed. The catalogue is open to you now.',
                `We hold the result, the issuing country and the date${expiresAt ? ` — and this check is good until ${shortDate(expiresAt)}` : ''}. We never receive the document itself or your date of birth.`
            ],
            action: { label: `Open ${BRAND}`, path: '/' }
        })
    },

    'age-declined': {
        category: 'transactional',
        build: ({ reason }) => ({
            subject: 'Your age check did not pass',
            heading: 'The check did not pass',
            lines: [
                reason
                    ? `Our identity provider could not confirm your age. They gave this reason: ${reason}`
                    : 'Our identity provider could not confirm your age from the document you submitted.',
                'The most common causes are a blurred photo, a cropped edge or an expired document. You can try again with a clearer scan.'
            ],
            action: { label: 'Try the check again', path: '/' }
        })
    },

    'identity-verified': {
        category: 'transactional',
        build: ({ expiresAt }) => ({
            subject: 'Your creator verification passed',
            heading: 'You are cleared to broadcast',
            lines: [
                'The document and the face scan both matched. Your account can go live.',
                `Each broadcast still starts with a quick face check in the browser${expiresAt ? `, and this enrolment is good until ${shortDate(expiresAt)}` : ''}. That check is what stops a stolen password putting somebody else on your camera.`
            ],
            action: { label: 'Open the studio', path: '/studio' }
        })
    },

    'identity-declined': {
        category: 'transactional',
        build: ({ reason }) => ({
            subject: 'Your creator verification did not pass',
            heading: 'The verification did not pass',
            lines: [
                reason
                    ? `Our identity provider could not complete your enrolment. They gave this reason: ${reason}`
                    : 'Our identity provider could not complete your enrolment.',
                'Your account is unchanged and you can start the check again from the studio.'
            ],
            action: { label: 'Open the studio', path: '/studio' }
        })
    },

    /* -------------------------------------------------------- the money -- */

    'credits-purchased': {
        category: 'transactional',
        build: ({ amount, credits, balance, reference }) => ({
            subject: `Your ${BRAND} receipt`,
            heading: `${amount} paid`,
            lines: [
                `${credits} credits have been added to your account. Your balance is now ${balance}.`,
                `Reference ${reference}. Keep this email if you need to query the charge.`
            ],
            action: { label: 'See your statement', path: '/profile' }
        })
    },

    /* ---------------------------------------------------------- security -- */

    'sessions-revoked': {
        category: 'security',
        build: () => ({
            subject: `You were signed out of ${BRAND} everywhere`,
            heading: 'Every session was ended',
            lines: [
                'Someone used "sign out everywhere" on your account. Every browser, every broadcast credential and every studio unlock is now invalid.',
                'If that was you, there is nothing to do — sign in again as normal.',
                'If it was not you, sign in and change your password now.'
            ],
            action: { label: 'Sign in', path: '/' }
        })
    },

    'identity-forgotten': {
        category: 'security',
        build: () => ({
            subject: 'Your identity records were deleted',
            heading: 'Deleted, as you asked',
            lines: [
                'We have deleted what we held about your identity checks and instructed our provider to delete what they hold.',
                'Your account still exists. You will be asked to verify again the next time you need to.'
            ],
            action: { label: `Open ${BRAND}`, path: '/' }
        })
    },

    /* --------------------------------------------------------- marketing -- */

    /**
     * The only opt-in category, and the only template that takes its wording
     * from the caller. Whoever sends one owns what it says; the catalogue owns
     * that it is marketing, that it is suppressed without consent, and that it
     * carries an unsubscribe link.
     */
    news: {
        category: 'marketing',
        build: ({ subject, heading, lines, action }) => ({
            subject: subject || `News from ${BRAND}`,
            heading: heading || `News from ${BRAND}`,
            lines: Array.isArray(lines) && lines.length ? lines : [],
            ...(action ? { action } : {})
        })
    }
};

/**
 * Render one message.
 *
 * @param {string} kind - a key of {@link TEMPLATES}
 * @param {object} data - whatever that template's `build` needs
 * @param {{origin: string, unsubscribeUrl?: string|null}} context
 * @returns {{category: MailCategory, subject: string, text: string, html: string}}
 */
export function render(kind, data, { origin, unsubscribeUrl = null }) {
    const template = TEMPLATES[kind];
    if (!template) throw new Error(`no email template named ${kind}`);

    const body = template.build(data ?? {});
    const href = body.action ? `${origin}${body.action.path}` : null;

    return {
        category: template.category,
        subject: body.subject,
        text: asText(body, href, unsubscribeUrl),
        html: asHtml(body, href, unsubscribeUrl)
    };
}

/* --------------------------------------------------------------- layout -- */

function asText(body, href, unsubscribeUrl) {
    const parts = [body.heading, '', ...body.lines];

    if (href) parts.push('', `${body.action.label}: ${href}`);
    if (body.footnote) parts.push('', body.footnote);

    parts.push('', '—', BRAND);
    if (unsubscribeUrl) parts.push('', `Unsubscribe from these emails: ${unsubscribeUrl}`);

    return `${parts.join('\n')}\n`;
}

/**
 * Inline styles and no stylesheet, because mail clients strip `<style>` about
 * as often as they honour it, and a layout that degrades to a readable column
 * of text in the ones that strip everything is worth more than one that looks
 * right in Gmail alone.
 */
function asHtml(body, href, unsubscribeUrl) {
    const paragraphs = body.lines
        .map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`)
        .join('\n            ');

    const button = href
        ? `<p style="margin:28px 0">
                <a href="${escapeAttr(href)}"
                   style="display:inline-block;padding:12px 22px;border-radius:8px;
                          background:#e11d48;color:#fff;text-decoration:none;font-weight:600">
                    ${escapeHtml(body.action.label)}
                </a>
            </p>`
        : '';

    const footnote = body.footnote
        ? `<p style="margin:0 0 16px;color:#6b7280;font-size:13px">${escapeHtml(body.footnote)}</p>`
        : '';

    const unsubscribe = unsubscribeUrl
        ? `<p style="margin:12px 0 0">
                <a href="${escapeAttr(unsubscribeUrl)}" style="color:#6b7280">Unsubscribe from these emails</a>
            </p>`
        : '';

    return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f5f5f7;
             font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#18181b">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
        <h1 style="margin:0 0 20px;font-size:21px;line-height:1.3">${escapeHtml(body.heading)}</h1>
            ${paragraphs}
            ${button}
            ${footnote}
        <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0 16px" />
        <p style="margin:0;color:#6b7280;font-size:13px">${escapeHtml(BRAND)}</p>
            ${unsubscribe}
    </div>
</body>
</html>
`;
}

function shortDate(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? String(iso) : at.toISOString().slice(0, 10);
}

function escapeHtml(str) {
    return String(str).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

const escapeAttr = escapeHtml;
