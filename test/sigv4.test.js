import test from 'node:test';
import assert from 'node:assert/strict';

import { presignUrl } from '../server/storage/sigv4.js';

/**
 * Verified against AWS's documented worked example for presigned URLs
 * ("Example: Signature calculation for a presigned URL", SigV4 reference).
 *
 * These credentials are AWS's published dummy values, not real secrets.
 */

const VECTOR = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    host: 'examplebucket.s3.amazonaws.com',
    key: 'test.txt',
    now: new Date('2013-05-24T00:00:00Z'),
    expiresIn: 86400
};

test('reproduces the AWS presigned-URL reference signature', () => {
    const url = presignUrl({ method: 'GET', ...VECTOR });

    assert.match(
        url,
        /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/,
        `unexpected signature in ${url}`
    );
});

test('presigned URL carries every required query parameter', () => {
    const url = new URL(presignUrl({ method: 'GET', ...VECTOR }));
    const q = url.searchParams;

    assert.equal(q.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(q.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
    assert.equal(q.get('X-Amz-Date'), '20130524T000000Z');
    assert.equal(q.get('X-Amz-Expires'), '86400');
    assert.equal(q.get('X-Amz-SignedHeaders'), 'host');
    assert.ok(q.get('X-Amz-Signature'));
});

test('the signature covers the HTTP method', () => {
    const get = presignUrl({ method: 'GET', ...VECTOR });
    const put = presignUrl({ method: 'PUT', ...VECTOR });

    assert.notEqual(
        new URL(get).searchParams.get('X-Amz-Signature'),
        new URL(put).searchParams.get('X-Amz-Signature')
    );
});

test('keys with spaces and slashes encode per segment', () => {
    const url = presignUrl({ ...VECTOR, key: 'videos/Reef Dive_180x180_3dh_LR.mp4' });

    // Slashes stay literal, spaces become %20 - not '+', which S3 rejects.
    assert.ok(url.includes('/videos/Reef%20Dive_180x180_3dh_LR.mp4?'), url);
    assert.ok(!url.includes('+'), 'space must not be encoded as +');
});

test('session tokens are included and signed', () => {
    const withToken = presignUrl({ ...VECTOR, sessionToken: 'FQoDYXdzEBcaD' });
    const q = new URL(withToken).searchParams;

    assert.equal(q.get('X-Amz-Security-Token'), 'FQoDYXdzEBcaD');
    assert.notEqual(
        q.get('X-Amz-Signature'),
        new URL(presignUrl({ method: 'GET', ...VECTOR })).searchParams.get('X-Amz-Signature')
    );
});

test('expiry is clamped to the 7-day maximum S3 allows', () => {
    const url = presignUrl({ ...VECTOR, expiresIn: 30 * 86400 });
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '604800');
});

test('path-style endpoints put the bucket in the path', () => {
    const url = presignUrl({
        ...VECTOR,
        host: 'minio.internal:9000',
        pathPrefix: '/mybucket',
        protocol: 'http'
    });

    assert.ok(url.startsWith('http://minio.internal:9000/mybucket/test.txt?'), url);
});

test('missing credentials fail loudly rather than signing with undefined', () => {
    assert.throws(() => presignUrl({ host: 'h', key: 'k', region: 'r' }), /requires host, key, region/);
});
