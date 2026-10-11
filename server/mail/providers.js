import { BRAND } from '../../brand.js';
import { bareAddress, buildMessage, sendSmtp } from './smtp.js';

/**
 * Mail transports.
 *
 * Same arrangement as identity and payments: one interface, a stub selected by
 * default, and a name this server does not recognise is fatal rather than a
 * quiet fallback. The reason is the same in all three places - a typo in
 * `AVR_MAIL_PROVIDER` that silently resolved to the stub would mean every
 * password-adjacent notice and every receipt stopped being delivered while the
 * logs, the API and the delivery table all continued to say the send
 * succeeded. Refusing to boot is a much cheaper failure.
 *
 * Two of the three real transports are plain JSON over HTTPS and are called
 * with the global `fetch`. That is deliberate: mail is the classic place a
 * project acquires an SMTP library, a MIME builder and their dependency
 * trees, and none of that is needed to POST a small object to an HTTP API.
 *
 * The third speaks SMTP to a mail server we run, because no hosted transport
 * will carry this platform's mail: most prohibit the content by name, and the
 * one that does not refused the account. `docs/EMAIL.md` has the detail. It
 * keeps to the same rule - `./smtp.js` is written out, not installed.
 *
 * @typedef {object} OutboundMail
 * @property {string} to
 * @property {string} subject
 * @property {string} text
 * @property {string} html
 * @property {Record<string, string>} [headers] - e.g. List-Unsubscribe.
 * @property {boolean} [bulk] - Marketing. Transports that separate bulk from
 *   transactional reputation need to be told which this is; the ones that do
 *   not may ignore it.
 *
 * @typedef {object} MailProvider
 * @property {string} name
 * @property {boolean} isStub
 * @property {(mail: OutboundMail) => Promise<{providerRef: string|null}>} send
 */

/** How long to wait on the transport's API before giving up on one message. */
const TIMEOUT_MS = Number(process.env.AVR_MAIL_TIMEOUT_MS || 10_000);

/**
 * The From address.
 *
 * No default that looks plausible. A real transport rejects an unverified
 * sender anyway, and a fabricated `noreply@localhost` would turn that clear
 * rejection into a puzzle.
 */
export function mailFrom() {
    return process.env.AVR_MAIL_FROM || `${BRAND} <noreply@localhost>`;
}

export function mailReplyTo() {
    return process.env.AVR_MAIL_REPLY_TO || null;
}

/**
 * The origin to build links against.
 *
 * Email is the one place the server has to name itself without a request to
 * read it off, so this cannot be derived the way `server/deovr.js` derives its
 * base URL. Unset, links come out pointing at localhost - wrong, but wrong in
 * a way that is obvious in a test inbox rather than silently half-working.
 */
export function publicOrigin() {
    return (process.env.AVR_PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/+$/, '');
}

/* ------------------------------------------------------------------- log -- */

let warned = false;

/**
 * A transport that delivers nothing and says so.
 *
 * It prints the recipient, the subject and the first line to the console, so a
 * developer can see that the welcome mail fired and what it said without
 * standing up a mail account. It announces itself the first time it is used,
 * for the same reason the payments stub does: a mailer that reports success
 * while sending nothing must be impossible to leave switched on by accident.
 */
export function logProvider() {
    let counter = 0;

    return {
        name: 'log',
        isStub: true,

        async send({ to, subject, text }) {
            if (!warned) {
                warned = true;
                console.warn(
                    '[mail] AVR_MAIL_PROVIDER=log - no email is being delivered to anyone. ' +
                        'Set a real transport before this server has real users.'
                );
            }

            counter += 1;
            const firstLine = String(text).trim().split('\n')[0] ?? '';
            console.log(`[mail] to=${to} subject=${JSON.stringify(subject)} :: ${firstLine.slice(0, 120)}`);

            return { providerRef: `log_${counter}` };
        }
    };
}

/* ---------------------------------------------------------------- resend -- */

export function resendProvider() {
    const key = process.env.AVR_RESEND_API_KEY;
    if (!key) throw new Error('AVR_RESEND_API_KEY is not set');

    return {
        name: 'resend',
        isStub: false,

        async send({ to, subject, text, html, headers }) {
            const body = {
                from: mailFrom(),
                to: [to],
                subject,
                text,
                html,
                ...(mailReplyTo() ? { reply_to: mailReplyTo() } : {}),
                ...(headers && Object.keys(headers).length ? { headers } : {})
            };

            const data = await postJson('https://api.resend.com/emails', body, {
                Authorization: `Bearer ${key}`
            });

            return { providerRef: data?.id ?? null };
        }
    };
}

/* -------------------------------------------------------------- postmark -- */

export function postmarkProvider() {
    const token = process.env.AVR_POSTMARK_TOKEN;
    if (!token) throw new Error('AVR_POSTMARK_TOKEN is not set');

    // Postmark separates transactional and broadcast traffic onto different
    // message streams, and sending bulk mail down the transactional one is how
    // an account gets its reputation suspended. The caller picks; this is only
    // the name of the stream the caller asked for.
    const transactionalStream = process.env.AVR_POSTMARK_STREAM || 'outbound';
    const broadcastStream = process.env.AVR_POSTMARK_BROADCAST_STREAM || 'broadcast';

    return {
        name: 'postmark',
        isStub: false,

        async send({ to, subject, text, html, headers, bulk = false }) {
            const body = {
                From: mailFrom(),
                To: to,
                Subject: subject,
                TextBody: text,
                HtmlBody: html,
                MessageStream: bulk ? broadcastStream : transactionalStream,
                ...(mailReplyTo() ? { ReplyTo: mailReplyTo() } : {}),
                ...(headers && Object.keys(headers).length
                    ? { Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) }
                    : {})
            };

            const data = await postJson('https://api.postmarkapp.com/email', body, {
                'X-Postmark-Server-Token': token
            });

            return { providerRef: data?.MessageID ?? null };
        }
    };
}

/* ------------------------------------------------------------------ smtp -- */

/**
 * A mail server, rather than somebody's API.
 *
 * This is the transport this platform actually runs on, and not by
 * preference: Resend's acceptable use policy and Postmark's terms of service
 * both prohibit sexually explicit content by name, as do Mailgun's,
 * SendGrid's and Mailchimp's. `docs/EMAIL.md` records the reasoning so the
 * obvious suggestion does not keep coming back.
 *
 * User and password are optional, for a relay on loopback that authorises by
 * source address instead. Encryption is not optional unless it is asked for
 * by name.
 */
export function smtpProvider() {
    const host = process.env.AVR_SMTP_HOST;
    if (!host) throw new Error('AVR_SMTP_HOST is not set');

    const port = Number(process.env.AVR_SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`AVR_SMTP_PORT=${process.env.AVR_SMTP_PORT} is not a port number`);
    }

    // 465 is implicit TLS and 587 is STARTTLS, by long convention. Naming the
    // mode explicitly overrides that. `none` is the only way to send in
    // clear, and it has to be typed out rather than arrived at.
    const encryption = process.env.AVR_SMTP_TLS || (port === 465 ? 'implicit' : 'starttls');
    if (!['implicit', 'starttls', 'none'].includes(encryption)) {
        throw new Error(`AVR_SMTP_TLS=${encryption} is not one of: implicit, starttls, none`);
    }

    const user = process.env.AVR_SMTP_USER || null;
    const pass = process.env.AVR_SMTP_PASS || null;
    if (user && !pass) throw new Error('AVR_SMTP_USER is set but AVR_SMTP_PASS is not');

    // A submission server commonly binds the envelope sender to the login, so
    // the two have to agree. They are separate settings because they are
    // allowed to differ - a server may let one account send as an alias of
    // itself, which is exactly how the platform's own From address works.
    const envelopeFrom = bareAddress(process.env.AVR_SMTP_ENVELOPE_FROM || mailFrom());

    // What EHLO announces. Some servers check that it resolves, and none of
    // them want to hear a container's hostname.
    const clientName = process.env.AVR_SMTP_EHLO_NAME || envelopeFrom.split('@')[1] || 'localhost';

    return {
        name: 'smtp',
        isStub: false,

        async send({ to, subject, text, html, headers }) {
            // `bulk` is ignored deliberately. Separate streams are a hosted
            // provider's reputation feature; one mail server has one queue on
            // one IP, and claiming otherwise would put a distinction in the
            // delivery log that does not exist on the wire.
            const message = buildMessage({
                from: mailFrom(),
                to,
                subject,
                text,
                html,
                replyTo: mailReplyTo(),
                headers
            });

            return sendSmtp({
                host,
                port,
                encryption,
                user,
                pass,
                envelopeFrom,
                to,
                message,
                timeoutMs: TIMEOUT_MS,
                clientName
            });
        }
    };
}

/* --------------------------------------------------------------- plumbing -- */

async function postJson(url, body, headers) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        /* Not JSON. `text` below is what gets reported. */
    }

    if (!res.ok) {
        // The message itself is never in the error, only the transport's
        // complaint about it. An error path that logs the body puts the
        // contents of a receipt into the application log.
        const detail = data?.message ?? data?.Message ?? text.slice(0, 200);
        const err = new Error(`mail transport refused the message (${res.status}): ${detail}`);
        err.status = res.status;
        throw err;
    }

    return data;
}

/* -------------------------------------------------------------- selection -- */

const PROVIDERS = {
    log: logProvider,
    resend: resendProvider,
    postmark: postmarkProvider,
    smtp: smtpProvider
};

let cached = null;

/**
 * The configured transport.
 *
 * @returns {MailProvider}
 */
export function getMailProvider() {
    if (cached) return cached;

    const wanted = process.env.AVR_MAIL_PROVIDER || defaultProviderName();

    const make = PROVIDERS[wanted];
    if (!make) {
        throw new Error(
            `AVR_MAIL_PROVIDER=${wanted} is not a transport this server has. ` +
                `Known: ${Object.keys(PROVIDERS).join(', ')}.`
        );
    }

    cached = make();
    return cached;
}

/** Tests and `.env` reloads; nothing in a request path should call this. */
export function resetMailProvider() {
    cached = null;
    warned = false;
}

/**
 * A key on its own selects its transport, so one variable is enough to leave
 * the stub behind. Two keys is ambiguous and is not guessed at.
 */
function defaultProviderName() {
    const keyed = [
        process.env.AVR_RESEND_API_KEY ? 'resend' : null,
        process.env.AVR_POSTMARK_TOKEN ? 'postmark' : null,
        process.env.AVR_SMTP_HOST ? 'smtp' : null
    ].filter(Boolean);

    if (keyed.length > 1) {
        throw new Error(
            `Keys for more than one mail transport are set (${keyed.join(', ')}). ` +
                'Set AVR_MAIL_PROVIDER to say which one to use.'
        );
    }

    return keyed[0] ?? 'log';
}

/** One line for the boot banner, in the same column as the identity and payments ones. */
export function mailBanner() {
    const provider = getMailProvider();

    if (provider.isStub) {
        return `Email        ${provider.name}  ⚠ STUB — nothing is delivered to anyone`;
    }

    if (!process.env.AVR_MAIL_FROM) {
        return `Email        ${provider.name}  ⚠ no AVR_MAIL_FROM — the transport will refuse every message`;
    }

    return `Email        ${provider.name} as ${mailFrom()}`;
}
