import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Didit adapter, read against decision payloads rather than the network.
 *
 * Every test here is about the same question: what does this code do when the
 * provider's answer is incomplete? A verdict reader that treats "the check did
 * not run" as "the check passed" is how an adult platform approves a minor, or
 * puts somebody on air against a face nobody compared - and both look exactly
 * like success from every other layer, so this is the only place they can be
 * caught.
 *
 * The provider is driven directly with `fetch` stubbed. Going through the HTTP
 * routes as `identity.test.js` does would mean a global fetch stub sitting
 * underneath a suite whose own test client is fetch.
 */

process.env.AVR_DIDIT_API_KEY = 'test-key-not-a-real-one';
process.env.AVR_DIDIT_ENROL_WORKFLOW_ID = '11111111-1111-4111-8111-111111111111';
process.env.AVR_DIDIT_FACEAUTH_WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';

const { diditProvider, diditWorkflowGaps } = await import('../server/identity/didit.js');

const realFetch = globalThis.fetch;
const calls = [];

/** Answer the next request with `body`, recording what was asked. */
function reply(body, status = 200) {
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
}

test.afterEach(() => {
    globalThis.fetch = realFetch;
    calls.length = 0;
});

const provider = diditProvider();

/** An approved KYC decision with every feature present and passing. */
function approvedKyc(overrides = {}) {
    return {
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'Approved',
        vendor_data: 'user-1',
        id_verifications: [
            {
                status: 'Approved',
                date_of_birth: '1990-04-02',
                issuing_state: 'GB',
                document_type: 'Passport'
            }
        ],
        liveness_checks: [{ status: 'Approved' }],
        face_matches: [{ status: 'Approved', score: 94.2 }],
        ...overrides
    };
}

/* ------------------------------------------------------------ enrolment -- */

test('an approved enrolment yields the vendor_data as the subject id', async () => {
    reply(approvedKyc());

    const verdict = await provider.fetchEnrolment('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    assert.equal(verdict.status, 'verified');
    assert.equal(verdict.adultConfirmed, true);
    assert.equal(verdict.documentCountry, 'GB');
    assert.equal(verdict.documentType, 'Passport');

    // The handle later face checks resolve against. It has to come back from
    // the decision rather than be assumed, or a session belonging to somebody
    // else could be collected as this user's enrolment.
    assert.equal(verdict.subjectId, 'user-1');
});

test('an enrolment with no birthdate is refused rather than assumed adult', async () => {
    reply(approvedKyc({ id_verifications: [{ status: 'Approved', issuing_state: 'GB' }] }));

    const verdict = await provider.fetchEnrolment('x');

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.adultConfirmed, false);
    assert.match(verdict.declineReason, /age could not be established/);

    // No subject id on a rejection: its presence is this codebase's evidence
    // that there is a face on file to check against.
    assert.equal(verdict.subjectId, null);
});

test('an enrolment for someone under 18 is refused even though the document passed', async () => {
    const born = new Date();
    born.setFullYear(born.getFullYear() - 17);

    reply(approvedKyc({ id_verifications: [{ status: 'Approved', date_of_birth: born.toISOString().slice(0, 10) }] }));

    const verdict = await provider.fetchEnrolment('x');

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.declineReason, 'under 18');
});

test('an enrolment whose workflow never ran a face match does not enrol a face', async () => {
    // A KYC workflow misconfigured without the selfie step verifies a document
    // and puts no face on file, so every later face check would fail with
    // nothing to compare against. Caught here rather than discovered by the
    // first creator who tries to go on air.
    reply(approvedKyc({ face_matches: [] }));

    const verdict = await provider.fetchEnrolment('x');

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.subjectId, null);
});

test('a decision still with a human reviewer is pending, not approved', async () => {
    reply(approvedKyc({ status: 'In Review' }));

    const verdict = await provider.fetchEnrolment('x');

    assert.equal(verdict.status, 'pending');
    assert.equal(verdict.adultConfirmed, false);
});

test('an expired session says so rather than reporting a failed document', async () => {
    reply(approvedKyc({ status: 'Kyc Expired' }));

    const verdict = await provider.fetchEnrolment('x');

    assert.equal(verdict.status, 'rejected');
    assert.match(verdict.declineReason, /expired/);
});

/* ----------------------------------------------------------- face check -- */

test('a face check passes only when liveness and the match both passed', async () => {
    reply(approvedKyc());
    assert.deepEqual(await provider.fetchFaceCheck('x'), { status: 'passed', reason: null });
});

test('a face check with no face match recorded fails', async () => {
    // The dangerous shape: Didit reports the session Approved while the match
    // underneath it never ran. "We never looked" must not read the same as "we
    // looked and it was fine".
    reply(approvedKyc({ face_matches: [] }));

    const verdict = await provider.fetchFaceCheck('x');
    assert.equal(verdict.status, 'failed');
});

test('a face check with no liveness recorded fails', async () => {
    // Without liveness the match only proves that a photograph of the creator
    // was held up to the camera.
    reply(approvedKyc({ liveness_checks: [] }));

    assert.equal((await provider.fetchFaceCheck('x')).status, 'failed');
});

test('one declined row among several fails the whole check', async () => {
    reply(approvedKyc({ face_matches: [{ status: 'Approved' }, { status: 'Declined' }] }));

    assert.equal((await provider.fetchFaceCheck('x')).status, 'failed');
});

test('a lost reference face is reported as re-enrolment, not as a mismatch', async () => {
    reply(
        approvedKyc({
            status: 'Declined',
            face_matches: [{ status: 'Declined', warnings: [{ risk: 'NO_REFERENCE_IMAGE' }] }]
        })
    );

    const verdict = await provider.fetchFaceCheck('x');

    assert.equal(verdict.status, 'failed');
    assert.match(verdict.reason, /verify your identity again/);
});

test('starting a face check with no enrolled face is tagged as permanent', async () => {
    // Didit refuses at session creation rather than returning a decision. The
    // tag is what stops the caller reporting it as "temporarily unavailable"
    // and parking the creator in a retry loop with no exit.
    reply({ portrait_image: 'No stored face image was found for this user.' }, 400);

    const err = await provider.startFaceCheck({ userId: 'user-1', subjectId: 'user-1' }).then(
        () => null,
        (e) => e
    );

    assert.equal(err.status, 400);
    assert.equal(err.code, 'no_reference_face');
});

test('a face check cannot be aimed at a subject that is not this user', async () => {
    reply(approvedKyc());

    await assert.rejects(
        () => provider.startFaceCheck({ userId: 'user-1', subjectId: 'user-2' }),
        /does not belong to this user/
    );
    await assert.rejects(() => provider.startFaceCheck({ userId: 'user-1', subjectId: null }), /no enrolled subject/);

    assert.equal(calls.length, 0, 'refused before anything was sent to the provider');
});

test('a face check sends no portrait image', async () => {
    reply({ session_id: 's', url: 'https://verify.didit.me/session/abc', session_token: 't' });

    await provider.startFaceCheck({ userId: 'user-1', subjectId: 'user-1' });

    // Sending one would mean this server was holding the enrolment face, which
    // is the arrangement the whole integration exists to avoid. Didit resolves
    // the reference from vendor_data instead.
    assert.equal(calls[0].body.portrait_image, undefined);
    assert.equal(calls[0].body.vendor_data, 'user-1');
    assert.equal(calls[0].body.workflow_id, process.env.AVR_DIDIT_FACEAUTH_WORKFLOW_ID);
});

/* ----------------------------------------------------------------- age -- */

test('the age check refuses to run when no age workflow is configured', async () => {
    // None of Didit's stock workflows can stand in: they all capture a selfie,
    // and this is the check every viewer passes. Borrowing the KYC workflow
    // would turn a document check for the whole user base into biometric
    // collection for the whole user base.
    assert.deepEqual(diditWorkflowGaps('age'), ['AVR_DIDIT_AGE_WORKFLOW_ID']);
    assert.deepEqual(diditWorkflowGaps('enrol'), []);
    assert.deepEqual(diditWorkflowGaps('face'), []);

    await assert.rejects(() => provider.startAgeCheck({ userId: 'user-1' }), /AVR_DIDIT_AGE_WORKFLOW_ID/);
});

test('an age check reads the country without needing a face', async () => {
    reply({
        status: 'Approved',
        vendor_data: 'user-1',
        id_verifications: [{ status: 'Approved', date_of_birth: '1980-01-01', issuing_state: 'FR' }]
    });

    assert.deepEqual(await provider.fetchAgeCheck('x'), {
        status: 'verified',
        adultConfirmed: true,
        documentCountry: 'FR',
        declineReason: null
    });
});

/* ----------------------------------------------------- the selfie estimate -- */

/**
 * The live `POST /v3/age-estimation/` envelope, with the fields this adapter
 * reads. Taken from a real response rather than the documentation: a faceless
 * image was posted to the production endpoint and this is the shape it came
 * back in.
 */
function estimated(overrides = {}) {
    return {
        request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        age_estimation: {
            status: 'Approved',
            method: 'PASSIVE',
            score: 91.4,
            age_estimation: 34.2,
            user_image: { entities: [{ age: 34.2, bbox: [10, 10, 90, 120], confidence: 0.98 }], best_angle: 0 },
            warnings: [],
            ...overrides
        },
        vendor_data: null,
        created_at: '2026-10-18T22:50:10.327154+00:00'
    };
}

/** As `reply`, but the request body is multipart and is not JSON to parse. */
function replyToUpload(body, status = 200) {
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init.method, form: init.body, headers: init.headers });
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
}

test('the selfie estimate needs a key and no workflow at all', () => {
    // The one check with nothing to configure beyond the key: it is a
    // standalone endpoint rather than a hosted flow, so a deployment that can
    // run a document check can always run this one too.
    assert.deepEqual(diditWorkflowGaps('selfie'), []);
});

test('an approved estimate is a verdict, and the request keeps nothing', async () => {
    replyToUpload(estimated());

    const verdict = await provider.estimateAge({ image: Buffer.alloc(32, 3) });

    assert.deepEqual(verdict, {
        status: 'verified',
        adultConfirmed: true,
        estimatedAge: 34.2,
        declineReason: null
    });

    assert.match(calls[0].url, /\/age-estimation\/$/);

    const form = calls[0].form;

    // `save_api_request: false` is the whole reason this endpoint is Florida's
    // anonymous route rather than a second workflow. It is not a retention
    // schedule, it is the image never being written.
    assert.equal(form.get('save_api_request'), 'false');

    // And nothing identifying travels with it. A correlation handle would
    // create the very thing there is otherwise nothing to erase.
    assert.equal(form.get('vendor_data'), null);
    assert.equal(form.get('metadata'), null);

    // Challenge 25, sent to the provider as well as checked on the way back.
    assert.equal(form.get('age_estimation_decline_threshold'), '25');

    // No Content-Type of our own: fetch has to set the multipart boundary.
    assert.equal(calls[0].headers['Content-Type'], undefined);
    assert.equal(calls[0].headers['x-api-key'], 'test-key-not-a-real-one');
});

test('a decline arrives as HTTP 200, so the body is the decision', async () => {
    // Exactly what the live endpoint returned for an image with no face in it.
    replyToUpload(
        estimated({
            status: 'Declined',
            score: null,
            age_estimation: null,
            user_image: { entities: [], best_angle: 0 },
            warnings: [
                { risk: 'NO_FACE_DETECTED', feature: 'LIVENESS' },
                { risk: 'AGE_NOT_DETECTED', feature: 'LIVENESS' }
            ]
        })
    );

    const verdict = await provider.estimateAge({ image: Buffer.alloc(32, 3) });

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.adultConfirmed, false);
    assert.equal(verdict.declineReason, 'no_face_detected');
});

test('an approval with a warning on it is still a decline', async () => {
    // Didit's rule is that approved means the warnings array is empty. A
    // reader that trusted `status` alone would pass a presentation attack
    // that the model had flagged and the envelope had not caught up with.
    replyToUpload(estimated({ warnings: [{ risk: 'LIVENESS_FACE_ATTACK', feature: 'LIVENESS' }] }));

    const verdict = await provider.estimateAge({ image: Buffer.alloc(32, 3) });

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.declineReason, 'liveness_face_attack');
});

test('the age floor is applied here too, not only asked for', async () => {
    // The threshold went out with the request, so a conforming server has
    // already applied it. This is the only place that knows a pass means an
    // adult cookie, and a floor enforced somewhere that is not ours is a floor
    // we cannot prove we applied.
    replyToUpload(estimated({ age_estimation: 19.6 }));

    const verdict = await provider.estimateAge({ image: Buffer.alloc(32, 3) });

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.declineReason, 'age_below_minimum');
    assert.equal(verdict.estimatedAge, 19.6);
});

test('a crowd is refused, because the estimate describes the largest face', async () => {
    // A minor standing behind an adult who is nearer the lens is handed the
    // adult's age, and liveness does not catch it because nothing is being
    // spoofed. Nobody needs a second person in shot to take a selfie.
    replyToUpload(
        estimated({
            user_image: {
                entities: [
                    { age: 34.2, bbox: [10, 10, 90, 120], confidence: 0.98 },
                    { age: 15.1, bbox: [100, 30, 140, 90], confidence: 0.91 }
                ],
                best_angle: 0
            }
        })
    );

    const verdict = await provider.estimateAge({ image: Buffer.alloc(32, 3) });

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.declineReason, 'more_than_one_face');
});

test('an estimate with no age in it is a decline, never a pass', async () => {
    replyToUpload(estimated({ age_estimation: null }));

    const verdict = await provider.estimateAge({ image: Buffer.alloc(32, 3) });

    assert.equal(verdict.status, 'rejected');
    assert.equal(verdict.declineReason, 'age_not_detected');
    assert.equal(verdict.estimatedAge, null);
});

test('an oversized or absent photograph never reaches the provider', async () => {
    replyToUpload(estimated());

    await assert.rejects(() => provider.estimateAge({ image: Buffer.alloc(0) }), /no selfie/);
    await assert.rejects(() => provider.estimateAge({}), /no selfie/);
    await assert.rejects(() => provider.estimateAge({ image: Buffer.alloc(3 * 1024 * 1024) }), /too large/);

    assert.equal(calls.length, 0);
});

/* -------------------------------------------------------------- erasure -- */

test('erasure names one person and never asks for everybody', async () => {
    reply({ deleted: 1 });

    await provider.forget('user-1');

    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/users\/delete\/$/);
    assert.deepEqual(calls[0].body.vendor_data_list, ['user-1']);

    // The endpoint also takes `delete_all`. There is no path through this
    // adapter that sends it.
    assert.equal(calls[0].body.delete_all, undefined);
});

test('erasure with no subject sends nothing at all', async () => {
    reply({ deleted: 0 });

    await provider.forget(null);
    await provider.forget('');

    assert.equal(calls.length, 0);
});
