import crypto from 'node:crypto';

/**
 * AWS Signature Version 4 query-string signing for S3-compatible storage.
 *
 * Presigned URLs are the mechanism that keeps video bytes out of the app
 * process entirely: the server signs a URL, the client fetches it straight from
 * the bucket or its CDN edge, and Node never touches the payload. That is the
 * difference between an origin that saturates at a few hundred concurrent
 * streams and one whose concurrency ceiling is the CDN's.
 *
 * Implemented directly rather than via the AWS SDK - this is ~100 lines against
 * a published, stable spec, versus a very large dependency for one function.
 * Verified against AWS's own documented test vector in
 * test/sigv4.test.js.
 *
 * Works with S3, Cloudflare R2, Backblaze B2, MinIO and Google Cloud Storage's
 * S3-compatible endpoint.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone, but AWS expects them encoded, and
 * a single mismatched character invalidates the whole signature.
 */
function uriEncode(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Object keys are path segments: encode each part, but keep the separators. */
function encodeKey(key) {
    return String(key)
        .split('/')
        .map(uriEncode)
        .join('/');
}

/** `20130524T000000Z` and `20130524`. */
function formatDate(date) {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secretKey, dateStamp, region, service) {
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

/**
 * Build a presigned URL.
 *
 * @param {object} opts
 * @param {string} opts.method - 'GET' or 'PUT'.
 * @param {string} opts.host - Endpoint host, e.g. `examplebucket.s3.amazonaws.com`.
 * @param {string} opts.key - Object key, without a leading slash.
 * @param {string} opts.region
 * @param {string} opts.accessKeyId
 * @param {string} opts.secretAccessKey
 * @param {number} [opts.expiresIn] - Seconds, max 604800 (7 days).
 * @param {string} [opts.service]
 * @param {string} [opts.protocol]
 * @param {string} [opts.sessionToken] - For temporary STS credentials.
 * @param {Date} [opts.now] - Injectable for deterministic tests.
 * @param {string} [opts.pathPrefix] - For path-style endpoints, e.g. `/bucket`.
 * @param {Record<string,string>} [opts.extraQuery] - Additional signed params.
 * @returns {string}
 */
export function presignUrl({
    method = 'GET',
    host,
    key,
    region,
    accessKeyId,
    secretAccessKey,
    expiresIn = 3600,
    service = 's3',
    protocol = 'https',
    sessionToken,
    now = new Date(),
    pathPrefix = '',
    extraQuery = {}
}) {
    if (!host || !key || !accessKeyId || !secretAccessKey || !region) {
        throw new Error('presignUrl requires host, key, region, accessKeyId and secretAccessKey');
    }

    const expires = Math.min(Math.max(Math.floor(expiresIn), 1), 604800);
    const { amzDate, dateStamp } = formatDate(now);

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const canonicalUri = `${pathPrefix}/${encodeKey(key)}`;

    const query = {
        'X-Amz-Algorithm': ALGORITHM,
        'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expires),
        'X-Amz-SignedHeaders': 'host',
        ...extraQuery
    };

    if (sessionToken) query['X-Amz-Security-Token'] = sessionToken;

    // Canonical query strings must be sorted by encoded key.
    const canonicalQuery = Object.keys(query)
        .sort()
        .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
        .join('&');

    const canonicalRequest = [
        method.toUpperCase(),
        canonicalUri,
        canonicalQuery,
        `host:${host}\n`,
        'host',
        UNSIGNED_PAYLOAD
    ].join('\n');

    const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

    const signature = crypto
        .createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
        .update(stringToSign)
        .digest('hex');

    return `${protocol}://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const __testing = { uriEncode, encodeKey, sha256Hex };
