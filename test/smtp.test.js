import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

/**
 * The SMTP transport.
 *
 * Tested against a real socket rather than a stubbed one. Nearly everything
 * that goes wrong with SMTP goes wrong in the conversation - a reply read as
 * one line when it was three, a body that ends early because a line began
 * with a period, a password offered to a server that never advertised
 * authentication - and none of those are visible to a test that replaces the
 * socket with an object that agrees with it.
 *
 * What is not covered here is the STARTTLS upgrade itself, which needs a
 * certificate the client would have to be told to distrust its way around.
 * The refusal path is covered, which is the one with teeth: a transport that
 * silently continues in clear is the actual hazard.
 */

const { buildMessage, sendSmtp, bareAddress } = await import('../server/mail/smtp.js');
const { getMailProvider, resetMailProvider } = await import('../server/mail/providers.js');

/**
 * A mail server that does only enough to be talked to, and records what it
 * was told.
 */
async function fakeSmtp({ capabilities = ['PIPELINING', 'STARTTLS', 'AUTH PLAIN LOGIN'], failAt = null } = {}) {
    const seen = { commands: [], data: null };

    const server = net.createServer((socket) => {
        let pending = '';
        let inData = false;
        let body = '';

        socket.setEncoding('utf8');
        socket.write('220 fake.test ESMTP\r\n');

        socket.on('error', () => {
            /* The client destroys the socket after QUIT; that is not a failure. */
        });

        socket.on('data', (chunk) => {
            pending += chunk;

            for (let i = pending.indexOf('\r\n'); i !== -1; i = pending.indexOf('\r\n')) {
                const line = pending.slice(0, i);
                pending = pending.slice(i + 2);

                if (inData) {
                    if (line === '.') {
                        inData = false;
                        seen.data = body;
                        socket.write('250 2.0.0 Ok: queued as 4cJ8xz2Qmsz1\r\n');
                    } else {
                        // Undo dot-stuffing, so `seen.data` is what was meant.
                        body += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
                    }
                    continue;
                }

                seen.commands.push(line);
                const verb = line.split(' ')[0].toUpperCase();

                if (failAt && verb === failAt.verb) {
                    socket.write(`${failAt.reply}\r\n`);
                    continue;
                }

                switch (verb) {
                    case 'EHLO':
                        if (!capabilities.length) {
                            socket.write('250 fake.test\r\n');
                            break;
                        }
                        socket.write('250-fake.test\r\n');
                        capabilities.forEach((cap, n) => {
                            socket.write(`250${n === capabilities.length - 1 ? ' ' : '-'}${cap}\r\n`);
                        });
                        break;
                    case 'AUTH':
                        socket.write('235 2.7.0 Authentication successful\r\n');
                        break;
                    case 'DATA':
                        inData = true;
                        body = '';
                        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
                        break;
                    case 'QUIT':
                        socket.write('221 2.0.0 Bye\r\n');
                        socket.end();
                        break;
                    default:
                        socket.write('250 2.1.0 Ok\r\n');
                }
            }
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        seen,
        port: server.address().port,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

/** The settings every test shares, so each one only states what it varies. */
function dial(port, overrides = {}) {
    return {
        host: '127.0.0.1',
        port,
        encryption: 'none',
        user: null,
        pass: null,
        envelopeFrom: 'hello@lustxr.test',
        to: 'someone@example.test',
        message: buildMessage({
            from: 'Test <hello@lustxr.test>',
            to: 'someone@example.test',
            subject: 'A subject',
            text: 'plain words',
            html: '<p>plain words</p>'
        }),
        timeoutMs: 5000,
        clientName: 'lustxr.test',
        ...overrides
    };
}

test('a message is handed over with its envelope, headers and both body parts', async () => {
    const mta = await fakeSmtp();
    try {
        const { providerRef } = await sendSmtp(dial(mta.port));

        // The queue id, not the whole sentence: it is what finds the message
        // in the mail log afterwards.
        assert.equal(providerRef, '4cJ8xz2Qmsz1');

        assert.ok(mta.seen.commands.includes('MAIL FROM:<hello@lustxr.test>'));
        assert.ok(mta.seen.commands.includes('RCPT TO:<someone@example.test>'));
        assert.ok(mta.seen.commands.includes('EHLO lustxr.test'));

        assert.match(mta.seen.data, /^From: Test <hello@lustxr\.test>\r$/m);
        assert.match(mta.seen.data, /^To: someone@example\.test\r$/m);
        assert.match(mta.seen.data, /^Subject: A subject\r$/m);
        assert.match(mta.seen.data, /^Message-ID: <[^>]+@lustxr\.test>\r$/m);
        assert.match(mta.seen.data, /multipart\/alternative; boundary="/);

        // Both alternatives present, and both decode back to what went in.
        const parts = mta.seen.data.split(/\r\n--.*\r\n/);
        const decoded = parts
            .filter((p) => p.includes('Content-Transfer-Encoding: base64'))
            .map((p) => Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
        assert.deepEqual(decoded, ['plain words', '<p>plain words</p>']);
    } finally {
        await mta.close();
    }
});

test('a subject that is not ASCII is encoded, and survives the trip', async () => {
    const mta = await fakeSmtp();
    const subject = 'Überraschung — 你的收据 is ready';
    try {
        await sendSmtp(
            dial(mta.port, {
                message: buildMessage({
                    from: 'Test <hello@lustxr.test>',
                    to: 'someone@example.test',
                    subject,
                    text: 'x',
                    html: '<p>x</p>'
                })
            })
        );

        const header = /^Subject: ((?:.|\r\n )*?)\r$/m.exec(mta.seen.data)[1];
        assert.ok(header.startsWith('=?UTF-8?B?'), `not an encoded-word: ${header}`);

        // No encoded-word may exceed 75 characters, or strict clients show
        // the raw header instead of the text.
        for (const word of header.split('\r\n ')) {
            assert.ok(word.length <= 75, `encoded-word too long (${word.length}): ${word}`);
        }

        const rebuilt = header
            .split('\r\n ')
            .map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)[1], 'base64').toString('utf8'))
            .join('');
        assert.equal(rebuilt, subject);
    } finally {
        await mta.close();
    }
});

test('a line that begins with a period does not end the message early', async () => {
    const mta = await fakeSmtp();
    try {
        // `buildMessage` cannot currently emit such a line, because the bodies
        // are base64. `sendSmtp` still has to handle one: it takes a message
        // as a string and must not let its contents terminate the DATA phase.
        const message = ['X-Odd: first', '.hidden', '..also hidden', 'X-Last: yes'].join('\r\n');
        await sendSmtp(dial(mta.port, { message }));

        assert.equal(mta.seen.data, `${message}\r\n`);
        assert.ok(mta.seen.data.includes('X-Last: yes'), 'the message was cut short at the period');
    } finally {
        await mta.close();
    }
});

test('the transport refuses to continue in clear when it was told to use STARTTLS', async () => {
    const mta = await fakeSmtp({ capabilities: ['PIPELINING'] });
    try {
        await assert.rejects(
            () => sendSmtp(dial(mta.port, { encryption: 'starttls' })),
            /does not offer STARTTLS/
        );
        // It must not have got as far as handing over an envelope.
        assert.ok(!mta.seen.commands.some((c) => c.startsWith('MAIL FROM')));
    } finally {
        await mta.close();
    }
});

test('credentials are offered only when the server advertises authentication', async () => {
    const withAuth = await fakeSmtp({ capabilities: ['AUTH PLAIN LOGIN'] });
    try {
        await sendSmtp(dial(withAuth.port, { user: 'contact@lustxr.test', pass: 'hunter2' }));
        const auth = withAuth.seen.commands.find((c) => c.startsWith('AUTH'));
        assert.ok(auth, 'never authenticated');
        assert.equal(
            Buffer.from(auth.split(' ')[2], 'base64').toString('utf8'),
            '\0contact@lustxr.test\0hunter2'
        );
    } finally {
        await withAuth.close();
    }

    const withoutAuth = await fakeSmtp({ capabilities: ['PIPELINING'] });
    try {
        await assert.rejects(
            () => sendSmtp(dial(withoutAuth.port, { user: 'contact@lustxr.test', pass: 'hunter2' })),
            /offers no password authentication/
        );
    } finally {
        await withoutAuth.close();
    }
});

test('a rejection is reported with the server reason, and never with the password', async () => {
    const mta = await fakeSmtp({
        capabilities: ['AUTH PLAIN LOGIN'],
        failAt: { verb: 'RCPT', reply: '550 5.1.1 <someone@example.test>: Recipient address rejected' }
    });

    try {
        await assert.rejects(
            () => sendSmtp(dial(mta.port, { user: 'contact@lustxr.test', pass: 'hunter2' })),
            (err) => {
                assert.match(err.message, /550/);
                assert.match(err.message, /Recipient address rejected/);
                assert.doesNotMatch(err.message, /hunter2/);
                return true;
            }
        );
    } finally {
        await mta.close();
    }
});

test('a failed login reports the refusal without quoting the credential back', async () => {
    const mta = await fakeSmtp({
        capabilities: ['AUTH PLAIN LOGIN'],
        failAt: { verb: 'AUTH', reply: '535 5.7.8 Error: authentication failed' }
    });

    try {
        await assert.rejects(
            () => sendSmtp(dial(mta.port, { user: 'contact@lustxr.test', pass: 'hunter2' })),
            (err) => {
                assert.match(err.message, /535/);
                assert.doesNotMatch(err.message, /hunter2/);
                // The base64 of the credential must not leak either.
                assert.doesNotMatch(err.message, /aHVudGVyMg/);
                return true;
            }
        );
    } finally {
        await mta.close();
    }
});

test('an address is reduced to the part an envelope can carry', () => {
    assert.equal(bareAddress('LustXR <hello@lustxr.test>'), 'hello@lustxr.test');
    assert.equal(bareAddress('hello@lustxr.test'), 'hello@lustxr.test');
    assert.equal(bareAddress('  hello@lustxr.test  '), 'hello@lustxr.test');
});

/* ------------------------------------------------------------ selection -- */

const SMTP_VARS = [
    'AVR_SMTP_HOST',
    'AVR_SMTP_PORT',
    'AVR_SMTP_TLS',
    'AVR_SMTP_USER',
    'AVR_SMTP_PASS',
    'AVR_MAIL_PROVIDER',
    'AVR_RESEND_API_KEY',
    'AVR_POSTMARK_TOKEN'
];

function withEnv(vars, fn) {
    const saved = Object.fromEntries(SMTP_VARS.map((k) => [k, process.env[k]]));
    for (const k of SMTP_VARS) delete process.env[k];
    Object.assign(process.env, vars);
    resetMailProvider();
    try {
        return fn();
    } finally {
        for (const k of SMTP_VARS) delete process.env[k];
        for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
        resetMailProvider();
    }
}

test('a host on its own is enough to select the transport', () => {
    withEnv({ AVR_SMTP_HOST: 'mail.lustxr.test' }, () => {
        const provider = getMailProvider();
        assert.equal(provider.name, 'smtp');
        assert.equal(provider.isStub, false);
    });
});

test('encryption is only skipped when it is asked for by name', () => {
    // 587 means STARTTLS and 465 means implicit TLS, neither of which the
    // caller has to say. Anything else is a typo and is refused.
    withEnv({ AVR_SMTP_HOST: 'mail.lustxr.test', AVR_SMTP_TLS: 'maybe' }, () => {
        assert.throws(() => getMailProvider(), /AVR_SMTP_TLS=maybe is not one of/);
    });
});

test('half a credential is refused rather than half-used', () => {
    withEnv({ AVR_SMTP_HOST: 'mail.lustxr.test', AVR_SMTP_USER: 'contact@lustxr.test' }, () => {
        assert.throws(() => getMailProvider(), /AVR_SMTP_USER is set but AVR_SMTP_PASS is not/);
    });
});

test('a port that is not a port is refused at boot, not at the first send', () => {
    withEnv({ AVR_SMTP_HOST: 'mail.lustxr.test', AVR_SMTP_PORT: 'submission' }, () => {
        assert.throws(() => getMailProvider(), /is not a port number/);
    });
});

test('two transports configured at once is ambiguous and is not guessed at', () => {
    withEnv({ AVR_SMTP_HOST: 'mail.lustxr.test', AVR_RESEND_API_KEY: 'x' }, () => {
        assert.throws(() => getMailProvider(), /more than one mail transport/);
    });
});
