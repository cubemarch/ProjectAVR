/**
 * Didit adapter.
 *
 * Same shape of problem as the Persona adapter it replaces, solved a different
 * way. One vendor still has to cover both halves - the document forensics at
 * enrolment, and "is the person at the keyboard right now the person who
 * enrolled" before every broadcast - because the moment those are two vendors,
 * somebody has to hold the enrolment face to bridge them, and the only
 * candidate for "somebody" is us.
 *
 * Didit bridges them with `vendor_data`. We send our user id as `vendor_data`
 * on every session; a Biometric Authentication session with no `portrait_image`
 * resolves its reference face by looking up the face already on file for that
 * same string (approved liveness capture, then ePassport chip photo, then the
 * ID document portrait). So the reference face is held by Didit and addressed
 * by an id that is meaningless outside our database. Nothing biometric crosses
 * back into this process - see the header in `db/schema.sql` for why that line
 * is drawn where it is.
 *
 * That also makes `vendor_data` the subject id in the sense the provider
 * interface means: the provider's stable handle for this person. It is our user
 * id, not an opaque id minted by Didit, because with Didit there is no other
 * handle that the face lookup and the erasure endpoint both accept.
 *
 * Three workflows must exist in the Didit console:
 *
 *   AVR_DIDIT_ENROL_WORKFLOW_ID     KYC: document OCR + selfie + liveness + face match
 *   AVR_DIDIT_FACEAUTH_WORKFLOW_ID  Biometric Authentication: liveness + face match
 *   AVR_DIDIT_AGE_WORKFLOW_ID       document OCR only - no liveness, no face match
 *
 * Florida's anonymous route is not a fourth workflow. Fla. Stat. § 501.1737
 * requires it be performed by an independent third party that retains nothing,
 * and a workflow cannot be that whatever its retention schedule, because a
 * workflow opens a session and a session is a thing that exists afterwards.
 * {@link estimateAge} calls the standalone Age Estimation endpoint instead,
 * with `save_api_request: false`: no stored image, no face template, no
 * session to go looking for. "Never written" rather than "deleted promptly" is
 * a promise about a mechanism instead of a schedule, which is the promise the
 * statute asks for, and it needs no console configuration beyond the API key.
 *
 * This replaced an `AVR_DIDIT_AGE_ANON_WORKFLOW_ID` that, unset, silently fell
 * back to the ordinary age workflow - so a viewer who picked "anonymous" got
 * an ordinary document session and was told otherwise. There is now no such
 * fallback: where the estimate cannot run, the route is not offered.
 *
 * The age workflow is separate rather than a reuse of the enrolment one because
 * the difference between them is the point: it must not capture a selfie. Every
 * account holder passes through it, and enrolling a face for a viewer who will
 * never be face-checked is collection without a purpose - which is the thing
 * BIPA and GDPR Article 9 are actually about. None of Didit's stock workflows
 * qualifies; they all bundle liveness and face match. If that variable is unset
 * the age check refuses to run rather than quietly borrowing the KYC workflow.
 */

const API_BASE = process.env.AVR_DIDIT_API_BASE || 'https://verification.didit.me/v3';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The age the selfie estimate has to clear, which is deliberately not 18.
 *
 * Didit's own documentation says the model's error grows for faces near the
 * limit, and the limit is exactly where this check is used. Asking for 18 means
 * every seventeen-year-old who reads a little old gets in, because the estimate
 * that let them through was inside its own margin. Asking for twenty-five
 * spends that margin on the right side: an adult who reads young is declined
 * and offered the document route, which costs them a minute. The reverse error
 * costs a minor access and us the statute.
 *
 * This is the long-standing "Challenge 25" convention from off-licence retail,
 * and it is the number the UK regulator's own age-estimation guidance is
 * written around.
 */
const ESTIMATE_FLOOR = Number(process.env.AVR_AGE_ESTIMATION_MIN || 25);

/** Didit auto-compresses to ~0.3 MB, so anything past this is wasted upload. */
const MAX_SELFIE_BYTES = 2 * 1024 * 1024;

/**
 * Longer than the JSON calls because this one carries an image and waits on a
 * model. Ten seconds would occasionally fire on a slow run and send somebody
 * back to the camera for a photo that was about to be accepted.
 */
const ESTIMATE_TIMEOUT_MS = 20_000;

function config() {
    const apiKey = process.env.AVR_DIDIT_API_KEY;
    if (!apiKey) throw new Error('AVR_DIDIT_API_KEY is not set');

    return {
        apiKey,
        enrolWorkflow: process.env.AVR_DIDIT_ENROL_WORKFLOW_ID || null,
        faceWorkflow: process.env.AVR_DIDIT_FACEAUTH_WORKFLOW_ID || null,
        ageWorkflow: process.env.AVR_DIDIT_AGE_WORKFLOW_ID || null
    };
}

/**
 * Which workflows are not configured, for one check or for all three.
 *
 * An API key on its own is enough to select this provider over the stub, and
 * that is a trap: the provider name reads "didit", nothing warns, and the first
 * creator to reach the portal gets a 400 from a session that was never given a
 * workflow to run. Reported at startup and refused outright under enforcement,
 * so the gap is visible before a person hits it.
 *
 * Asked per check rather than globally, because the checks are independent: a
 * missing age workflow must not stop a creator enrolling.
 *
 * @param {'enrol'|'face'|'age'|'selfie'} [check] one check, or every workflow if omitted
 * @returns {string[]} the unset environment variable names, most important first
 */
export function diditWorkflowGaps(check) {
    // The selfie estimate is the one check with no workflow behind it. It is a
    // standalone endpoint rather than a hosted flow, so a key is the whole of
    // its configuration - and it is answered before `config()` is called,
    // because `config()` throws on a missing key and the honest answer here is
    // to name that key as the gap rather than to fail asking.
    if (check === 'selfie') {
        return process.env.AVR_DIDIT_API_KEY ? [] : ['AVR_DIDIT_API_KEY'];
    }

    const { enrolWorkflow, faceWorkflow, ageWorkflow } = config();

    const byCheck = {
        age: ageWorkflow ? null : 'AVR_DIDIT_AGE_WORKFLOW_ID',
        enrol: enrolWorkflow ? null : 'AVR_DIDIT_ENROL_WORKFLOW_ID',
        face: faceWorkflow ? null : 'AVR_DIDIT_FACEAUTH_WORKFLOW_ID'
    };

    const wanted = check ? [byCheck[check]] : [byCheck.age, byCheck.enrol, byCheck.face];
    return wanted.filter(Boolean);
}

async function call(method, path, body) {
    const { apiKey } = config();

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            // Raw key, not a Bearer token. Didit rejects `Authorization`.
            'x-api-key': apiKey,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const text = await res.text();
    const json = text ? safeJson(text) : null;

    if (!res.ok) {
        // Surface the detail to the log and none of it to the user: a
        // verification failure reason can be sensitive, and a transport failure
        // is not their problem. A bad workflow id comes back as a field error
        // rather than a message, hence both shapes.
        const err = new Error(`didit ${method} ${path} failed (${res.status}): ${errorDetail(json, text)}`);
        err.status = res.status;
        throw err;
    }

    return json;
}

function errorDetail(json, text) {
    if (!json) return text.slice(0, 200);
    if (typeof json.detail === 'string') return json.detail;
    if (typeof json.message === 'string') return json.message;

    // Field errors, delivered either as {"workflow_id": ["required"]} or as
    // {"portrait_image": "no stored face..."} depending on the endpoint.
    const fields = Object.entries(json)
        .map(([key, value]) => {
            if (Array.isArray(value)) return `${key}: ${value.join(' ')}`;
            if (typeof value === 'string') return `${key}: ${value}`;
            return null;
        })
        .filter(Boolean)
        .join('; ');

    return fields || JSON.stringify(json).slice(0, 200);
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Create a hosted verification session.
 *
 * `vendor_data` carries our user id on every call, which is doing three jobs at
 * once: it ties a Didit-side investigation back to an account without us
 * sending a name or an email to do it, it is how a face check finds the face
 * enrolled earlier, and it is the key the erasure endpoint accepts.
 */
async function createSession({ workflowId, userId, redirectUrl }) {
    const session = await call('POST', '/session/', {
        workflow_id: workflowId,
        vendor_data: userId,
        ...(redirectUrl ? { callback: redirectUrl } : {})
    });

    return {
        inquiryId: session.session_id,
        // Didit calls this `url`. There is a `verification_url` in some of the
        // older documentation; it is not in the v3 response.
        clientUrl: session.url ?? null,
        clientToken: session.session_token ?? null
    };
}

/** `GET /v3/session/{id}/decision/` - 404 with a JSON body means unknown session. */
function decisionPath(inquiryId) {
    return `/session/${encodeURIComponent(inquiryId)}/decision/`;
}

/**
 * Didit reports status in title case with spaces ("In Review", "Kyc Expired").
 * Normalised here so a casing change on their side cannot silently reclassify a
 * decline as a pending.
 */
function normalise(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '_');
}

const TERMINAL_REJECT = new Set(['declined', 'expired', 'kyc_expired', 'abandoned']);

/**
 * Coarse verdict from the session status alone.
 *
 * `in_review` is pending on purpose: Didit has taken the case to a human, and
 * an adult platform treating "a reviewer has not looked yet" as a pass is the
 * failure this whole subsystem exists to prevent.
 *
 * @returns {'pending'|'approved'|'rejected'}
 */
function outcomeOf(decision) {
    const status = normalise(decision?.status);
    if (status === 'approved') return 'approved';
    if (TERMINAL_REJECT.has(status)) return 'rejected';
    return 'pending';
}

/**
 * The rows for one feature of a decision.
 *
 * Read defensively from the root and from a nested `decision` object: the
 * documented v3 shape is flat, but the same payload is delivered nested by the
 * webhook, and a reader that only understands one of them fails by returning
 * "no evidence" - which, for a face check, reads as a pass if the caller is not
 * careful. Everything below requires positive evidence instead.
 */
function featureRows(decision, name) {
    const rows = decision?.[name] ?? decision?.decision?.[name];
    return Array.isArray(rows) ? rows : [];
}

function firstIdVerification(decision) {
    return featureRows(decision, 'id_verifications')[0] ?? {};
}

/**
 * Was this person over 18 when they were verified?
 *
 * Fails closed, returning null for "could not tell". A session that passed
 * every document check but did not yield a birthdate has not answered the one
 * question an adult platform has to be able to answer, and treating "unknown"
 * as "adult" is how a platform ends up having verified a minor with a clean
 * audit trail saying otherwise.
 *
 * The birthdate itself is read here and discarded; only the boolean is stored.
 * Didit also reports a computed `age`, used only when there is no date of birth
 * to check for ourselves - it is their arithmetic rather than ours, and it was
 * done whenever the session ran rather than now.
 */
function adultFrom(idVerification) {
    const raw = idVerification?.date_of_birth;

    if (raw) {
        const born = new Date(raw);
        if (!Number.isNaN(born.getTime())) {
            const eighteen = new Date(born.getFullYear() + 18, born.getMonth(), born.getDate());
            return eighteen.getTime() <= Date.now();
        }
    }

    const age = Number(idVerification?.age);
    if (Number.isFinite(age) && age > 0) return age >= 18;

    return null;
}

/**
 * Read an age-estimation response into a verdict.
 *
 * Didit returns HTTP 200 for a refusal as well as a pass, so the body is the
 * decision and the status line says nothing. Their rule is that a result counts
 * as approved only when `warnings` is empty; this keeps that and adds two
 * conditions of its own, both in the direction of declining:
 *
 *   - **The age is re-checked here.** The threshold was sent with the request,
 *     so a conforming server has already applied it, but this is the only place
 *     that knows a pass means an adult cookie. A floor enforced in one place
 *     that is not ours is a floor we cannot prove we applied.
 *   - **Exactly one face.** The estimate describes the *largest* face in the
 *     frame, so a minor standing beside an adult who is nearer the lens is
 *     handed the adult's age. Liveness does not catch that — nothing is being
 *     spoofed. Nobody needs a second person in shot to take a selfie, so the
 *     cost of refusing is a retake.
 */
function readEstimate(json) {
    const estimate = json?.age_estimation ?? {};
    const warnings = Array.isArray(estimate.warnings) ? estimate.warnings : [];
    const faces = Array.isArray(estimate.user_image?.entities) ? estimate.user_image.entities : [];

    const ageRaw = Number(estimate.age_estimation);
    const age = Number.isFinite(ageRaw) && ageRaw > 0 ? ageRaw : null;

    const reject = (declineReason) => ({
        status: 'rejected',
        adultConfirmed: false,
        estimatedAge: age,
        declineReason
    });

    if (warnings.length) return reject(normalise(warnings[0]?.risk) || 'declined');
    if (normalise(estimate.status) !== 'approved') return reject('declined');
    if (age === null) return reject('age_not_detected');
    if (faces.length > 1) return reject('more_than_one_face');
    if (age < ESTIMATE_FLOOR) return reject('age_below_minimum');

    return { status: 'verified', adultConfirmed: true, estimatedAge: age, declineReason: null };
}

function documentCountryOf(idVerification) {
    return idVerification?.issuing_state ?? idVerification?.issuing_state_name ?? null;
}

function documentTypeOf(idVerification) {
    return idVerification?.document_type ?? idVerification?.document_subtype ?? null;
}

/** Risk codes Didit attaches to a feature, flattened across every row. */
function warningsOf(decision, name) {
    return featureRows(decision, name)
        .flatMap((row) => (Array.isArray(row?.warnings) ? row.warnings : []))
        .map((warning) => normalise(warning?.risk ?? warning?.code ?? warning));
}

/**
 * Did every row of this feature come back approved?
 *
 * Requires at least one row. An empty array means the workflow did not run the
 * check at all, and "we never looked" must not read the same as "we looked and
 * it was fine" - that is the difference between a face check and a formality.
 */
function featurePassed(decision, name) {
    const rows = featureRows(decision, name);
    return rows.length > 0 && rows.every((row) => normalise(row?.status) === 'approved');
}

/** @returns {import('./providers.js').IdentityProvider} */
export function diditProvider() {
    return {
        name: 'didit',
        isMock: false,

        async startEnrolment({ userId, redirectUrl = null }) {
            const { enrolWorkflow } = config();
            if (!enrolWorkflow) throw new Error('AVR_DIDIT_ENROL_WORKFLOW_ID is not set');

            return createSession({ workflowId: enrolWorkflow, userId, redirectUrl });
        },

        async fetchEnrolment(inquiryId) {
            const decision = await call('GET', decisionPath(inquiryId));

            const idVerification = firstIdVerification(decision);
            const documentCountry = documentCountryOf(idVerification);
            const documentType = documentTypeOf(idVerification);

            // The handle later face checks resolve against. Read back from the
            // decision rather than assumed, so that a session created against
            // some other vendor_data can never be mistaken for this user's
            // enrolment. Only surfaced on a pass: a declined session enrols
            // nothing, and a subject id is this codebase's evidence that there
            // is a face on file to check against.
            const subjectId = decision?.vendor_data ?? null;

            const outcome = outcomeOf(decision);

            if (outcome === 'approved') {
                // A KYC workflow that skipped the selfie would verify a
                // document and enrol no face, leaving every later face check to
                // fail with nothing to match. Checked here rather than trusted
                // to the console, because the console is where it would be
                // misconfigured.
                if (!featurePassed(decision, 'face_matches')) {
                    return {
                        status: 'rejected',
                        subjectId: null,
                        documentCountry,
                        documentType,
                        adultConfirmed: false,
                        declineReason: 'the photo of your face did not match your document'
                    };
                }

                const adult = adultFrom(idVerification);

                if (adult !== true) {
                    return {
                        status: 'rejected',
                        subjectId: null,
                        documentCountry,
                        documentType,
                        adultConfirmed: false,
                        declineReason: adult === false ? 'under 18' : 'age could not be established from the document'
                    };
                }

                return { status: 'verified', subjectId, documentCountry, documentType, adultConfirmed: true, declineReason: null };
            }

            if (outcome === 'rejected') {
                const expired = normalise(decision?.status).endsWith('expired');
                return {
                    status: 'rejected',
                    subjectId: null,
                    documentCountry,
                    documentType,
                    adultConfirmed: false,
                    declineReason: expired ? 'the verification session expired' : 'the document check did not pass'
                };
            }

            return { status: 'pending', subjectId: null, documentCountry, documentType, adultConfirmed: false, declineReason: null };
        },

        /**
         * Face check against the face enrolled earlier.
         *
         * No `portrait_image`: sending one would mean we were holding the
         * enrolment face, which is the arrangement this integration exists to
         * avoid. With it omitted, Didit resolves the reference from the face
         * already on file for this `vendor_data`. `subjectId` is that same
         * string, and is required here because its presence is what proves an
         * enrolment happened - without that guard this would silently become a
         * liveness check against nothing, which only proves that a live human
         * took a photo.
         */
        async startFaceCheck({ userId, subjectId }) {
            const { faceWorkflow } = config();
            if (!faceWorkflow) throw new Error('AVR_DIDIT_FACEAUTH_WORKFLOW_ID is not set');
            if (!subjectId) throw new Error('no enrolled subject to check against');

            if (subjectId !== userId) {
                throw new Error('enrolled subject does not belong to this user');
            }

            try {
                return await createSession({ workflowId: faceWorkflow, userId, redirectUrl: null });
            } catch (err) {
                // Didit refuses to create the session at all when it has no
                // face on file for this vendor_data, rather than creating one
                // that later reports NO_REFERENCE_IMAGE. Both paths exist and
                // both are handled; this is the one that actually fires.
                //
                // Tagged rather than left as a bare 400 because the caller has
                // to tell it apart from a provider outage: it is permanent,
                // retrying cannot fix it, and the only way out is to enrol
                // again. Reporting it as "temporarily unavailable" would put a
                // creator in a retry loop with no exit.
                if (err.status === 400 && /portrait_image|stored face/i.test(err.message)) {
                    err.code = 'no_reference_face';
                }
                throw err;
            }
        },

        async fetchFaceCheck(inquiryId) {
            const decision = await call('GET', decisionPath(inquiryId));
            const outcome = outcomeOf(decision);

            if (outcome === 'pending') return { status: 'pending', reason: null };

            // Didit's overall status can read Approved while the face match
            // underneath it did not run or did not match, so the session status
            // alone is not the answer. Both halves are required: liveness says
            // a real person was present, the face match says it was this
            // person, and either one on its own is not an authentication.
            const live = featurePassed(decision, 'liveness_checks');
            const matched = featurePassed(decision, 'face_matches');

            if (outcome === 'approved' && live && matched) return { status: 'passed', reason: null };

            const warnings = [...warningsOf(decision, 'face_matches'), ...warningsOf(decision, 'liveness_checks')];

            // The reference face could not be resolved - nothing on file for
            // this vendor_data. Not a failed match, and saying "your face did
            // not match" would send the creator round a loop that cannot
            // succeed; they have to enrol again.
            if (warnings.includes('no_reference_image')) {
                return { status: 'failed', reason: 'your enrolled identity is no longer on file - please verify your identity again' };
            }

            if (warnings.includes('liveness_face_attack')) {
                return { status: 'failed', reason: 'the camera did not see a live person' };
            }

            if (normalise(decision?.status).endsWith('expired')) {
                return { status: 'failed', reason: 'the check expired before it finished' };
            }

            return { status: 'failed', reason: 'the face did not match your enrolled identity' };
        },

        /**
         * Age assurance for any account holder, creator or not.
         *
         * This session exists to read a birthdate off a document and then be
         * forgotten. It runs a workflow with no liveness and no face match, so
         * it is not an enrolment and cannot be used as one - there is nothing
         * here to face-check against later, by construction.
         *
         * It still carries `vendor_data`, which is worth being clear about: a
         * viewer becomes a Didit entity, so that asking Didit to erase them
         * later has something to name. It does not put a face on file, because
         * the workflow never captures one.
         */
        async startAgeCheck({ userId, redirectUrl = null }) {
            const { ageWorkflow } = config();
            if (!ageWorkflow) throw new Error('AVR_DIDIT_AGE_WORKFLOW_ID is not set');

            return createSession({ workflowId: ageWorkflow, userId, redirectUrl });
        },

        async fetchAgeCheck(inquiryId) {
            const decision = await call('GET', decisionPath(inquiryId));

            const idVerification = firstIdVerification(decision);
            const documentCountry = documentCountryOf(idVerification);
            const outcome = outcomeOf(decision);

            if (outcome === 'approved') {
                const adult = adultFrom(idVerification);

                if (adult !== true) {
                    return {
                        status: 'rejected',
                        adultConfirmed: false,
                        documentCountry,
                        declineReason: adult === false ? 'under 18' : 'age could not be established from the document'
                    };
                }

                return { status: 'verified', adultConfirmed: true, documentCountry, declineReason: null };
            }

            if (outcome === 'rejected') {
                const expired = normalise(decision?.status).endsWith('expired');
                return {
                    status: 'rejected',
                    adultConfirmed: false,
                    documentCountry,
                    declineReason: expired ? 'the check expired before it finished' : 'the document check did not pass'
                };
            }

            return { status: 'pending', adultConfirmed: false, documentCountry, declineReason: null };
        },

        /**
         * Estimate an age from a selfie, store nothing, and answer at once.
         *
         * This is Florida's anonymous route. § 501.1737 asks for a method
         * performed by an independent third party that retains nothing, and
         * `save_api_request: false` is literally that: Didit's documentation
         * for this endpoint says nothing is stored, the returned `request_id`
         * is a throwaway correlation value that cannot be looked up again, no
         * session appears in their console, and no face embedding joins the
         * application's face index. There is nothing afterwards to ask them to
         * delete, which is a stronger promise than deleting it would be.
         *
         * It is also why this is a *different endpoint* from the document
         * check rather than a second workflow. A workflow would have produced a
         * stored session; the anonymity here is a property of the call.
         *
         * Nothing about the image is kept at this end either. It arrives as a
         * request body, is forwarded in memory, and is never written to disk or
         * to a log — see the route in `visitor-gate.js`.
         *
         * No `vendor_data` is sent. The account flow passes a subject so that
         * erasure has something to name later; here there is nothing to erase
         * and a correlation handle would only create one.
         *
         * @param {{image: Buffer, mimeType?: string}} input
         */
        async estimateAge({ image, mimeType = 'image/jpeg' }) {
            const { apiKey } = config();

            if (!image?.length) throw new Error('no selfie was supplied');
            if (image.length > MAX_SELFIE_BYTES) throw new Error('the selfie is too large');

            const form = new FormData();
            form.append('user_image', new Blob([image], { type: mimeType }), 'selfie.jpg');
            form.append('save_api_request', 'false');
            form.append('age_estimation_decline_threshold', String(ESTIMATE_FLOOR));

            const res = await fetch(`${API_BASE}/age-estimation/`, {
                method: 'POST',
                // No Content-Type: fetch sets the multipart boundary itself.
                headers: { 'x-api-key': apiKey },
                body: form,
                signal: AbortSignal.timeout(ESTIMATE_TIMEOUT_MS)
            });

            const text = await res.text();
            const json = text ? safeJson(text) : null;

            if (!res.ok) {
                const err = new Error(
                    `didit POST /age-estimation/ failed (${res.status}): ${errorDetail(json, text)}`
                );
                err.status = res.status;
                throw err;
            }

            return readEstimate(json);
        },

        /**
         * Erasure, not deletion of a row.
         *
         * This is the request that actually removes the biometric, because the
         * biometric is theirs and not ours. Dropping our reference without it
         * would leave a face on file in their system that nobody can find any
         * more - the worst of both outcomes.
         *
         * `delete_all` is a field on this endpoint and is never sent. An empty
         * or missing subject id returns early for the same reason: there is no
         * version of this function that is allowed to widen.
         */
        async forget(subjectId) {
            if (!subjectId) return;
            await call('POST', '/users/delete/', { vendor_data_list: [subjectId] });
        }
    };
}
