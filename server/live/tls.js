/**
 * TLS for the contribution socket.
 *
 * The ingest link carries a stream key and then the broadcast itself. On a
 * studio LAN that is a defensible thing to send in the clear; across the public
 * internet it is not, and the app lets an operator configure a public host.
 *
 * The awkward part is that most destinations are bare private addresses -
 * `192.168.1.110:8081` - and no certificate authority will ever issue for those.
 * So there are two trust models here and the address decides which one applies,
 * the same way it decides whether cellular is allowed:
 *
 *   - A **public** host gets ordinary validation against the system trust
 *     store. Nothing special; get a real certificate.
 *   - A **private** host gets a self-signed certificate and a pin. The pin is
 *     the SHA-256 of the whole certificate, published in the pairing URL, and
 *     the phone refuses anything that does not match it.
 *
 * Pinning the certificate rather than its SubjectPublicKeyInfo is the less
 * fashionable choice and the right one here. An SPKI pin survives certificate
 * renewal for the same key, which matters when pins are baked into a binary and
 * live for years - but these pins are not. A pairing URL is minted per
 * broadcast and carries the current pin with it, so the renewal advantage is
 * worth almost nothing, while computing an SPKI hash on the iOS side means
 * rebuilding DER from a `SecKey` with a hand-written algorithm-identifier
 * prefix per key type. That table is the kind of thing that is wrong only for
 * the key type nobody tested, and its failure mode is a connection that refuses
 * a certificate that is actually fine.
 *
 * The cost is that regenerating the certificate invalidates saved destinations
 * until the operator pairs again, which is one visible error and one paste.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const CERT_PATH = process.env.AVR_LIVE_TLS_CERT;
const KEY_PATH = process.env.AVR_LIVE_TLS_KEY;

/** Read once. A certificate that changes under a running process is a restart, not a reload. */
let cached;

/**
 * @returns {{cert: Buffer, key: Buffer, pin: string}|null} null when TLS is not configured.
 */
export function tlsMaterial() {
    if (cached !== undefined) return cached;

    if (!CERT_PATH || !KEY_PATH) {
        cached = null;
        return cached;
    }

    try {
        const cert = fs.readFileSync(CERT_PATH);
        const key = fs.readFileSync(KEY_PATH);

        cached = { cert, key, pin: certificatePin(cert) };
    } catch (err) {
        // Fail loudly and stay cleartext rather than failing to boot. A server
        // that will not start because a certificate moved takes a live service
        // down; a server that logs this and keeps listening does not, and the
        // pairing URL stops advertising TLS so no phone is told to expect it.
        console.error('[live] TLS material could not be read, ingest stays cleartext:', err.message);
        cached = null;
    }

    return cached;
}

/**
 * SHA-256 of the DER form of the certificate, base64.
 *
 * Exactly what the phone computes from `SecCertificateCopyData` on the leaf it
 * is offered, so the two sides can be compared as opaque strings. Parsing the
 * PEM rather than hashing the file means a trailing newline, CRLF line endings
 * or a chain file with the issuer appended all produce the same pin - hashing
 * the bytes on disk would make the pin depend on how the file was written.
 *
 * @param {Buffer|string} certPem
 */
export function certificatePin(certPem) {
    const der = new crypto.X509Certificate(certPem).raw;
    return crypto.createHash('sha256').update(der).digest('base64');
}

/** The pin to advertise, or null when the listener is not speaking TLS. */
export function tlsPinBase64() {
    return tlsMaterial()?.pin ?? null;
}

/** Whether the ingest listener should wrap its socket. */
export function tlsEnabled() {
    return tlsMaterial() !== null;
}
