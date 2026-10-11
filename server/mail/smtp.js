import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

/**
 * A small SMTP client, and just enough MIME to carry one message.
 *
 * `providers.js` says plainly why the other two transports are HTTP: mail is
 * where a project picks up an SMTP library, a MIME builder and their
 * dependency trees. That reasoning still holds, so this is written out rather
 * than installed. What is needed is genuinely small - one envelope, one
 * recipient, two body parts, no attachments, no connection pool, no queue.
 * Postfix is the thing on the other end that has a queue.
 *
 * It exists because no hosted transport will carry this platform's mail -
 * most refuse the content in their acceptable use policy, and the one that
 * does not refused the account - so the only route left is a mail server we
 * run. See `docs/EMAIL.md`.
 */

/** Longest a single line of base64 may be, per RFC 2045. */
const B64_LINE = 76;

/**
 * An encoded-word is capped at 75 characters including its delimiters, and
 * base64 turns 3 bytes into 4 characters. `=?UTF-8?B?` and `?=` cost 12, so
 * 45 bytes in is 60 characters out and the whole word lands at 72.
 */
const ENCODED_WORD_BYTES = 45;

/* ------------------------------------------------------------------ mime -- */

/** Whether a header value can go out as-is, or has to be encoded first. */
function isAscii(value) {
    // eslint-disable-next-line no-control-regex
    return !/[^\x20-\x7e]/.test(value);
}

/**
 * A header value as RFC 2047 encoded-words.
 *
 * Split by code point rather than by byte: cutting a multi-byte character in
 * half produces a header that decodes to mojibake, and a subject line is the
 * one part of a message every recipient sees.
 */
function encodeHeaderValue(value) {
    if (isAscii(value)) return value;

    const words = [];
    let chunk = '';
    let bytes = 0;

    for (const ch of value) {
        const size = Buffer.byteLength(ch, 'utf8');
        if (bytes + size > ENCODED_WORD_BYTES) {
            words.push(chunk);
            chunk = '';
            bytes = 0;
        }
        chunk += ch;
        bytes += size;
    }
    if (chunk) words.push(chunk);

    // Folded onto continuation lines. A decoder joins adjacent encoded-words
    // and drops the whitespace between them.
    return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function base64Body(text) {
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    const lines = [];
    for (let i = 0; i < encoded.length; i += B64_LINE) lines.push(encoded.slice(i, i + B64_LINE));
    return lines.join('\r\n');
}

/**
 * The bare address out of a From header that may be a display-name form.
 *
 * The envelope sender has to be the address alone - `MAIL FROM:<LustXR
 * <hello@lustxr.com>>` is a syntax error, and a submission server that binds
 * senders to logins will reject it rather than guess.
 */
export function bareAddress(value) {
    const angled = /<([^>]+)>/.exec(value);
    return (angled ? angled[1] : value).trim();
}

/**
 * One RFC 5322 message, text and HTML, as multipart/alternative.
 *
 * Both parts are base64. Quoted-printable would be more readable on the wire,
 * but base64 cannot produce a line that begins with a period, cannot run past
 * the line-length limit, and cannot be mangled by trailing whitespace - three
 * separate classes of bug traded for one unreadable blob.
 *
 * @returns {string} The message, CRLF-delimited, with no trailing dot.
 */
export function buildMessage({ from, to, subject, text, html, replyTo = null, headers = {}, messageId = null }) {
    const boundary = `--=_${randomUUID()}`;
    const domain = bareAddress(from).split('@')[1] || 'localhost';

    const lines = [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${encodeHeaderValue(subject)}`,
        `Message-ID: ${messageId ?? `<${randomUUID()}@${domain}>`}`,
        `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
        'MIME-Version: 1.0'
    ];

    if (replyTo) lines.push(`Reply-To: ${replyTo}`);

    for (const [name, value] of Object.entries(headers ?? {})) {
        if (value == null) continue;
        lines.push(`${name}: ${encodeHeaderValue(String(value))}`);
    }

    lines.push(
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        // Read only by a client too old to understand multipart, which in
        // practice is none of them.
        'This is a message in MIME format.',
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Body(text ?? ''),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64Body(html ?? ''),
        '',
        `--${boundary}--`
    );

    return lines.join('\r\n');
}

/* ------------------------------------------------------------------ wire -- */

/** A reply is complete at the first line whose code is followed by a space. */
const REPLY_END = /^(?:\d{3}-[^\n]*\n)*(\d{3})(?: [^\n]*)?\n/;

/**
 * A line-oriented wrapper over one socket.
 *
 * SMTP is strictly turn-taking, so this only ever has one read outstanding.
 */
function session(socket, timeoutMs) {
    let buffer = '';
    let pending = null;
    let failure = null;

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);

    const fail = (err) => {
        failure ??= err;
        if (pending) {
            const { reject } = pending;
            pending = null;
            reject(err);
        }
    };

    socket.on('data', (chunk) => {
        buffer += chunk;
        settle();
    });
    socket.on('error', (err) => fail(err));
    socket.on('timeout', () => {
        socket.destroy();
        fail(new Error(`SMTP server did not answer within ${timeoutMs}ms`));
    });
    socket.on('close', () => fail(new Error('SMTP server closed the connection')));

    function settle() {
        if (!pending) return;
        const match = REPLY_END.exec(buffer);
        if (!match) return;

        const raw = buffer.slice(0, match[0].length);
        buffer = buffer.slice(match[0].length);

        const { resolve } = pending;
        pending = null;
        resolve({ code: Number(match[1]), text: raw.trim() });
    }

    return {
        socket,

        read() {
            if (failure) return Promise.reject(failure);
            return new Promise((resolve, reject) => {
                pending = { resolve, reject };
                settle();
            });
        },

        write(line) {
            socket.write(`${line}\r\n`);
        },

        /** Send a command and insist on the code it is supposed to answer with. */
        async command(line, expected, { redact = false } = {}) {
            this.write(line);
            const reply = await this.read();
            if (!expected.includes(reply.code)) {
                // The command is in the error so a failure is diagnosable, but
                // never when it carried a credential, and never the message
                // body - the same rule `postJson` follows in providers.js.
                const what = redact ? '(credential)' : line.split(':')[0];
                throw new Error(`SMTP ${what} refused (${reply.code}): ${reply.text}`);
            }
            return reply;
        },

        /** Capabilities from an EHLO reply, upper-cased, one per line. */
        capabilities(reply) {
            return reply.text
                .split('\n')
                .slice(1)
                .map((l) => l.replace(/^\d{3}[- ]/, '').trim().toUpperCase());
        }
    };
}

function connect(options) {
    return new Promise((resolve, reject) => {
        const socket = options.secure ? tls.connect(options) : net.connect(options);
        const onReady = () => {
            socket.removeListener('error', onError);
            resolve(socket);
        };
        const onError = (err) => {
            socket.removeListener(options.secure ? 'secureConnect' : 'connect', onReady);
            reject(err);
        };
        socket.once(options.secure ? 'secureConnect' : 'connect', onReady);
        socket.once('error', onError);
    });
}

function upgrade(socket, host) {
    return new Promise((resolve, reject) => {
        const secured = tls.connect({ socket, servername: host }, () => {
            secured.removeListener('error', reject);
            resolve(secured);
        });
        secured.once('error', reject);
    });
}

/**
 * Hand one message to an SMTP server.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {'implicit'|'starttls'|'none'} options.encryption
 * @param {string|null} options.user
 * @param {string|null} options.pass
 * @param {string} options.envelopeFrom
 * @param {string} options.to
 * @param {string} options.message - As built by {@link buildMessage}.
 * @param {number} options.timeoutMs
 * @param {string} options.clientName - What to put in EHLO.
 * @returns {Promise<{providerRef: string|null}>}
 */
export async function sendSmtp({
    host,
    port,
    encryption,
    user,
    pass,
    envelopeFrom,
    to,
    message,
    timeoutMs,
    clientName
}) {
    const socket = await connect({ host, port, secure: encryption === 'implicit', servername: host });
    let wire = session(socket, timeoutMs);

    try {
        const greeting = await wire.read();
        if (greeting.code !== 220) throw new Error(`SMTP server refused the connection (${greeting.code}): ${greeting.text}`);

        let hello = await wire.command(`EHLO ${clientName}`, [250]);

        if (encryption === 'starttls') {
            if (!wire.capabilities(hello).some((c) => c === 'STARTTLS')) {
                // Refuse rather than carry on in clear. A transport that
                // quietly downgrades sends credentials and password-reset
                // links across the network in plain text.
                throw new Error(`SMTP server at ${host}:${port} does not offer STARTTLS`);
            }
            await wire.command('STARTTLS', [220]);
            wire = session(await upgrade(socket, host), timeoutMs);
            // Capabilities advertised before TLS cannot be trusted and are
            // re-read afterwards; AUTH usually only appears at this point.
            hello = await wire.command(`EHLO ${clientName}`, [250]);
        }

        if (user && pass) {
            const offered = wire.capabilities(hello).find((c) => c.startsWith('AUTH')) ?? '';
            if (!offered.includes('PLAIN') && !offered.includes('LOGIN')) {
                throw new Error(`SMTP server at ${host}:${port} offers no password authentication (${offered || 'no AUTH'})`);
            }

            if (offered.includes('PLAIN')) {
                const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
                await wire.command(`AUTH PLAIN ${token}`, [235], { redact: true });
            } else {
                await wire.command('AUTH LOGIN', [334], { redact: true });
                await wire.command(Buffer.from(user, 'utf8').toString('base64'), [334], { redact: true });
                await wire.command(Buffer.from(pass, 'utf8').toString('base64'), [235], { redact: true });
            }
        }

        await wire.command(`MAIL FROM:<${envelopeFrom}>`, [250]);
        await wire.command(`RCPT TO:<${to}>`, [250, 251]);
        await wire.command('DATA', [354]);

        // Dot-stuffing. A body line of a single period ends the message, so
        // any line already starting with one gets a second. Base64 bodies
        // cannot produce such a line, but headers are not base64.
        const body = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        wire.write(`${body}\r\n.`);

        const accepted = await wire.read();
        if (accepted.code !== 250) throw new Error(`SMTP server rejected the message (${accepted.code}): ${accepted.text}`);

        try {
            await wire.command('QUIT', [221]);
        } catch {
            /* The message is already accepted. How the server says goodbye is not interesting. */
        }

        // Postfix answers "250 2.0.0 Ok: queued as 4cJ8xz2Qmsz1". That id is
        // what makes a message findable in the mail log later, so it is worth
        // more as the provider reference than the whole sentence.
        const queued = /queued as (\S+)/i.exec(accepted.text);
        return { providerRef: queued ? queued[1] : accepted.text.slice(0, 100) || null };
    } finally {
        wire.socket.destroy();
        socket.destroy();
    }
}
