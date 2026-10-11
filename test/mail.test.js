import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Email, and the marketing opt-in that governs part of it.
 *
 * What is worth testing here is not the wording. It is the split: that the
 * mail an account cannot refuse is sent whatever their preferences say, that
 * the mail they can refuse is not sent unless they asked for it, and that the
 * suppressed attempts are still recorded - because "we never sent it" and "we
 * have no idea whether we sent it" are different answers to a complaint.
 *
 * The observable throughout is `email_messages`, not the transport. The stub
 * transport delivers nothing by design, so asserting on what it "sent" would
 * prove nothing that the delivery log does not prove better.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'avr-mail-'));

process.env.AVR_DB = path.join(TMP, 'test.db');
process.env.AVR_MEDIA_DIR = path.join(TMP, 'media');
process.env.AVR_JWT_SECRET = 'test-secret-value-that-is-long-enough-32';
process.env.AVR_DLNA = '0';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.AVR_DISABLE_RATE_LIMIT = '1';
process.env.AVR_IDENTITY_PROVIDER = 'mock';
process.env.AVR_PUBLIC_URL = 'https://example.test';

const { app } = await import('../server/index.js');
const { TERMS_VERSION, CREATOR_TERMS_VERSION } = await import('../server/auth/agreements.js');
const { getDb, users, emailMessages } = await import('../server/db/index.js');
const { notify, drainMail, unsubscribeToken, unsubscribeUrl } = await import('../server/mail/index.js');
const { TEMPLATES, render } = await import('../server/mail/templates.js');
const { getMailProvider, resetMailProvider } = await import('../server/mail/providers.js');

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;

function makeAgent() {
    const jar = new Map();

    return {
        token: null,
        async fetch(url, options = {}) {
            const headers = { ...(options.headers ?? {}) };

            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
            if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

            const res = await fetch(`${base}${url}`, { ...options, headers, redirect: 'manual' });

            for (const raw of res.headers.getSetCookie?.() ?? []) {
                const [pair] = raw.split(';');
                const idx = pair.indexOf('=');
                jar.set(pair.slice(0, idx), pair.slice(idx + 1));
            }

            const text = await res.text();
            let body = null;
            if (text) {
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text;
                }
            }

            return { status: res.status, body, headers: res.headers };
        },

        async register(overrides = {}) {
            seq += 1;
            this.email = `mail${seq}@example.test`;

            const res = await this.fetch('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    email: this.email,
                    password: 'correcthorsebattery',
                    displayName: `Person ${seq}`,
                    role: 'viewer',
                    acceptedTerms: TERMS_VERSION,
                    ...overrides
                })
            });

            if (res.status === 201) {
                this.token = res.body.accessToken;
                this.id = res.body.user.id;
            }
            return res;
        }
    };
}

/** The first account on a fresh database is promoted to admin. Burn it. */
await makeAgent().register({ displayName: 'Bootstrap admin' });
await drainMail();

/** Every delivery-log row for one account, oldest first. */
function mailFor(userId) {
    return getDb()
        .prepare('SELECT * FROM email_messages WHERE user_id = ? ORDER BY created_at, rowid')
        .all(userId);
}

/* ---------------------------------------------------------- the transport -- */

test('the default transport is the stub, and it says so', () => {
    const provider = getMailProvider();

    assert.equal(provider.name, 'log');
    assert.equal(provider.isStub, true);
});

test('an unrecognised transport is fatal rather than a quiet fall back to the stub', () => {
    const was = process.env.AVR_MAIL_PROVIDER;

    resetMailProvider();
    process.env.AVR_MAIL_PROVIDER = 'sendmial';

    try {
        assert.throws(() => getMailProvider(), /not a transport this server has/);
    } finally {
        if (was === undefined) delete process.env.AVR_MAIL_PROVIDER;
        else process.env.AVR_MAIL_PROVIDER = was;
        resetMailProvider();
    }
});

/* ---------------------------------------------------------------- signing up -- */

test('signing up sends a welcome email and records it', async () => {
    const agent = makeAgent();
    await agent.register();
    await drainMail();

    const sent = mailFor(agent.id);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, 'welcome');
    assert.equal(sent[0].category, 'transactional');
    assert.equal(sent[0].status, 'sent');
    assert.equal(sent[0].recipient, agent.email);
});

test('the welcome email tells a creator about the check they still owe', async () => {
    const agent = makeAgent();
    await agent.register({
        role: 'creator',
        tagline: 'Broadcasting from a shed',
        acceptedCreatorTerms: CREATOR_TERMS_VERSION
    });
    await drainMail();

    const [welcome] = mailFor(agent.id);
    assert.equal(welcome.kind, 'welcome');

    const { text } = render('welcome', { displayName: 'Person', creator: true }, { origin: 'https://example.test' });
    assert.match(text, /identity check/);
});

test('becoming a creator later is its own email', async () => {
    const agent = makeAgent();
    await agent.register();

    await agent.fetch('/api/auth/become-creator', {
        method: 'POST',
        body: JSON.stringify({ acceptedCreatorTerms: CREATOR_TERMS_VERSION })
    });
    await drainMail();

    assert.deepEqual(
        mailFor(agent.id).map((row) => row.kind),
        ['welcome', 'creator-enabled']
    );
});

/* -------------------------------------------------------------- the opt-in -- */

test('marketing is off unless the signup form said otherwise', async () => {
    const off = makeAgent();
    await off.register();
    assert.equal(users.byId(off.id).marketing_emails, 0);

    const on = makeAgent();
    await on.register({ marketingEmails: true });
    assert.equal(users.byId(on.id).marketing_emails, 1);
});

test('only a real boolean is consent', async () => {
    for (const value of ['on', 'true', 1, 'yes']) {
        const agent = makeAgent();
        await agent.register({ marketingEmails: value });
        assert.equal(users.byId(agent.id).marketing_emails, 0, `${JSON.stringify(value)} must not opt anybody in`);
    }
});

test('a marketing email is suppressed for an account that did not opt in, and the attempt is logged', async () => {
    const agent = makeAgent();
    await agent.register();
    await drainMail();

    await notify('news', users.byId(agent.id), { subject: 'Hello', lines: ['Something happened.'] });
    await drainMail();

    const last = mailFor(agent.id).at(-1);

    assert.equal(last.kind, 'news');
    assert.equal(last.category, 'marketing');
    assert.equal(last.status, 'suppressed');
    assert.match(last.detail, /not opted in/);
});

test('a marketing email is sent to an account that did opt in', async () => {
    const agent = makeAgent();
    await agent.register({ marketingEmails: true });
    await drainMail();

    await notify('news', users.byId(agent.id), { subject: 'Hello', lines: ['Something happened.'] });
    await drainMail();

    const last = mailFor(agent.id).at(-1);

    assert.equal(last.kind, 'news');
    assert.equal(last.status, 'sent');
});

test('opting out does not silence receipts or security notices', async () => {
    const agent = makeAgent();
    await agent.register({ marketingEmails: false });
    await drainMail();

    await agent.fetch('/api/auth/logout-all', { method: 'POST' });
    await drainMail();

    const security = mailFor(agent.id).at(-1);

    assert.equal(security.kind, 'sessions-revoked');
    assert.equal(security.category, 'security');
    assert.equal(security.status, 'sent');
});

test('every template declares a category, and only marketing ones are optional', () => {
    const categories = new Set(['transactional', 'security', 'marketing']);

    for (const [kind, template] of Object.entries(TEMPLATES)) {
        assert.ok(categories.has(template.category), `${kind} has an unknown category`);
    }

    // The catalogue is meant to stay readable. If this fails because a
    // category was added, add it above deliberately rather than loosening it.
    assert.equal(Object.values(TEMPLATES).filter((t) => t.category === 'marketing').length, 1);
});

/* ---------------------------------------------------------------- settings -- */

test('the profile page is told where the switch stands, and can move it', async () => {
    const agent = makeAgent();
    await agent.register();

    const before = await agent.fetch('/api/profile');
    assert.equal(before.body.emails.marketing, false);

    const on = await agent.fetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ marketingEmails: true })
    });

    assert.equal(on.status, 200);
    assert.equal(on.body.emails.marketing, true);
    assert.equal(users.byId(agent.id).marketing_emails, 1);

    const off = await agent.fetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ marketingEmails: false })
    });

    assert.equal(off.body.emails.marketing, false);
    assert.equal(users.byId(agent.id).marketing_emails, 0);
});

test('a non-boolean is refused rather than guessed at', async () => {
    const agent = makeAgent();
    await agent.register();

    const res = await agent.fetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ marketingEmails: 'on' })
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /true or false/);
    assert.equal(users.byId(agent.id).marketing_emails, 0);
});

test('a rejected patch changes nothing, including the switch', async () => {
    const agent = makeAgent();
    await agent.register();

    const res = await agent.fetch('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ marketingEmails: true, tagline: 'x'.repeat(200) })
    });

    assert.equal(res.status, 400);
    assert.equal(users.byId(agent.id).marketing_emails, 0);
});

test('what a person has agreed to receive is not in anybody else’s view of them', async () => {
    const creator = makeAgent();
    await creator.register({
        role: 'creator',
        tagline: 'Broadcasting from a shed',
        acceptedCreatorTerms: CREATOR_TERMS_VERSION,
        marketingEmails: true
    });

    const stranger = makeAgent();
    await stranger.register();

    const seen = await stranger.fetch(`/api/creators/${creator.id}`);

    assert.equal(seen.status, 200);
    assert.equal(JSON.stringify(seen.body).includes('marketing'), false);
});

/* ------------------------------------------------------------- unsubscribe -- */

test('the unsubscribe link carries a signature over the account it is for', () => {
    const a = makeAgent();
    const url = unsubscribeUrl('user-one');

    assert.ok(url.startsWith('https://example.test/unsubscribe?'));
    assert.notEqual(unsubscribeToken('user-one'), unsubscribeToken('user-two'));
    assert.ok(a);
});

test('GET shows a confirmation and changes nothing, so a link scanner cannot unsubscribe anybody', async () => {
    const agent = makeAgent();
    await agent.register({ marketingEmails: true });

    const page = await fetch(`${base}/unsubscribe?u=${agent.id}&t=${unsubscribeToken(agent.id)}`);

    assert.equal(page.status, 200);
    assert.match(await page.text(), /<form method="post"/);
    assert.equal(users.byId(agent.id).marketing_emails, 1);
});

test('POST unsubscribes, with no session of any kind', async () => {
    const agent = makeAgent();
    await agent.register({ marketingEmails: true });

    const body = new URLSearchParams({ u: agent.id, t: unsubscribeToken(agent.id) });
    const res = await fetch(`${base}/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    assert.equal(res.status, 200);
    assert.equal(users.byId(agent.id).marketing_emails, 0);
});

test('a forged or truncated token unsubscribes nobody', async () => {
    const agent = makeAgent();
    await agent.register({ marketingEmails: true });

    const real = unsubscribeToken(agent.id);

    for (const token of ['', 'nope', real.slice(0, -1), `${real}x`]) {
        const res = await fetch(`${base}/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ u: agent.id, t: token })
        });

        assert.equal(res.status, 400, `token ${JSON.stringify(token)} must be refused`);
    }

    // One account's token must not work for another's.
    const other = makeAgent();
    await other.register({ marketingEmails: true });

    const crossed = await fetch(`${base}/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ u: other.id, t: real })
    });

    assert.equal(crossed.status, 400);
    assert.equal(users.byId(other.id).marketing_emails, 1);
    assert.equal(users.byId(agent.id).marketing_emails, 1);
});

test('marketing mail carries an unsubscribe link and transactional mail does not', async () => {
    const opted = makeAgent();
    await opted.register({ marketingEmails: true });
    await drainMail();

    const origin = 'https://example.test';

    const news = render('news', { subject: 'Hi', lines: ['x'] }, { origin, unsubscribeUrl: unsubscribeUrl(opted.id) });
    assert.match(news.text, /Unsubscribe from these emails/);
    assert.match(news.html, /\/unsubscribe\?/);

    const receipt = render(
        'credits-purchased',
        { amount: '$10.00', credits: '1,000', balance: '1,000', reference: 'abc' },
        { origin }
    );
    assert.doesNotMatch(receipt.text, /Unsubscribe/);
});

/* ---------------------------------------------------------------- the log -- */

test('an address-less account is suppressed rather than handed to the transport', async () => {
    await notify('welcome', { id: null, email: null, display_name: 'Nobody' }, { displayName: 'Nobody' });
    await drainMail();

    const row = getDb()
        .prepare("SELECT * FROM email_messages WHERE user_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get();

    assert.equal(row.status, 'suppressed');
    assert.match(row.detail, /no address/);
});

test('the log records the subject but never the body', async () => {
    const agent = makeAgent();
    await agent.register();
    await drainMail();

    const [welcome] = mailFor(agent.id);
    const columns = Object.keys(welcome);

    assert.ok(welcome.subject.length > 0);
    assert.equal(
        columns.some((c) => /body|html|text/.test(c)),
        false
    );
});

test('notify never throws, whatever the template does', async () => {
    const row = await notify('no-such-template', { id: 'x', email: 'x@example.test' });
    assert.equal(row, null);
});

test('the delivery log is readable per account', async () => {
    const agent = makeAgent();
    await agent.register();
    await drainMail();

    assert.equal(emailMessages.forUser(agent.id).length, 1);
});
