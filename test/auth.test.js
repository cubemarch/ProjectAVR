import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword, needsRehash, getDummyHash } from '../server/auth/passwords.js';

/**
 * Password hashing.
 *
 * These are the properties an attacker with a stolen database would try to
 * break, so they are asserted rather than assumed.
 */

test('a password verifies against its own hash', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    assert.equal(await verifyPassword('correcthorsebatterystaple', hash), true);
});

test('a wrong password does not verify', async () => {
    const hash = await hashPassword('correcthorsebatterystaple');
    assert.equal(await verifyPassword('correcthorsebatterystapl', hash), false);
    assert.equal(await verifyPassword('', hash), false);
});

test('the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('correcthorsebattery'), hashPassword('correcthorsebattery')]);

    // Distinct salts, so a rainbow table cannot cover two accounts at once.
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('correcthorsebattery', a), true);
    assert.equal(await verifyPassword('correcthorsebattery', b), true);
});

test('hashes record their own cost parameters', async () => {
    const hash = await hashPassword('correcthorsebattery');
    const [scheme, N, r, p] = hash.split('$');

    assert.equal(scheme, 'scrypt');
    assert.ok(Number(N) >= 16384, `N too low: ${N}`);
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
});

test('short passwords are rejected before hashing', async () => {
    await assert.rejects(() => hashPassword('short'), /at least 10/);
});

test('absurdly long passwords are rejected rather than burning CPU', async () => {
    await assert.rejects(() => hashPassword('x'.repeat(5000)), /at most 256/);
});

test('malformed stored hashes fail closed', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$16384$8$1$aa$bb', 'scrypt$16384$8$1$$', null, undefined]) {
        assert.equal(await verifyPassword('correcthorsebattery', bad), false, `accepted: ${bad}`);
    }
});

test('tampered cost parameters are rejected, not honoured', async () => {
    // An attacker with write access might lower N to make cracking cheap, or
    // raise it absurdly to exhaust memory. Both must be refused.
    const hash = await hashPassword('correcthorsebattery');
    const parts = hash.split('$');

    const weakened = ['scrypt', '2', parts[2], parts[3], parts[4], parts[5]].join('$');
    assert.equal(await verifyPassword('correcthorsebattery', weakened), false);

    const inflated = ['scrypt', String(1 << 25), parts[2], parts[3], parts[4], parts[5]].join('$');
    assert.equal(await verifyPassword('correcthorsebattery', inflated), false);
});

test('unicode passwords normalise so the same input always verifies', async () => {
    // U+00E9 vs e + U+0301 look identical and can differ by keyboard or OS.
    const composed = 'café-passphrase';
    const decomposed = 'café-passphrase';

    const hash = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, hash), true);
});

test('needsRehash flags weaker-than-current hashes', async () => {
    const current = await hashPassword('correcthorsebattery');
    assert.equal(needsRehash(current), false);

    const parts = current.split('$');
    const old = ['scrypt', '8192', parts[2], parts[3], parts[4], parts[5]].join('$');
    assert.equal(needsRehash(old), true);
    assert.equal(needsRehash('not-a-hash'), true);
});

test('the dummy hash is a real hash that nothing verifies against', async () => {
    const dummy = await getDummyHash();

    assert.match(dummy, /^scrypt\$/);
    assert.equal(await verifyPassword('correcthorsebattery', dummy), false);
    // Stable across calls, so the unknown-account path has consistent cost.
    assert.equal(await getDummyHash(), dummy);
});
