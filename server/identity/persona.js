import crypto from 'node:crypto';

/**
 * Persona adapter.
 *
 * Persona was chosen because one vendor covers both halves of this: an Inquiry
 * runs the document forensics and the enrolment selfie, and a later selfie-only
 * inquiry against the same Account is a face check against what they already
 * hold. That matters because the alternative - document vendor plus a separate
 * face vendor - means somebody has to hold the enrolment face to bridge them,
 * and the only candidate for "somebody" is us.
 *
 * Three template ids must be configured in the Persona dashboard:
 *
 *   AVR_PERSONA_ENROL_TEMPLATE_ID     government ID + selfie + liveness
 *   AVR_PERSONA_FACEAUTH_TEMPLATE_ID  selfie only, run against an existing account
 *   AVR_PERSONA_AGE_TEMPLATE_ID       government ID only, no selfie, no account
 *
 * The age template is separate rather than a reuse of the enrolment one because
 * the difference between them is the point: it must not capture a selfie. Every
 * account holder passes through it, and enrolling a face template for a viewer
 * who will never be face-checked is collection without a purpose - which is the
 * thing BIPA and GDPR Article 9 are actually about.
 *
 * Field names in a Persona inquiry follow the template, so the readers below
 * are deliberately defensive: an absent field yields null rather than throwing,
 * except for age, which fails closed.
 */

const API_BASE = process.env.AVR_PERSONA_API_BASE || 'https://api.withpersona.com/api/v1';

/** Pinned so a Persona-side schema change cannot alter responses under us. */
const API_VERSION = process.env.AVR_PERSONA_API_VERSION || '2023-01-05';

const REQUEST_TIMEOUT_MS = 10_000;

function config() {
    const apiKey = process.env.AVR_PERSONA_API_KEY;
    if (!apiKey) throw new Error('AVR_PERSONA_API_KEY is not set');

    return {
        apiKey,
        enrolTemplate: process.env.AVR_PERSONA_ENROL_TEMPLATE_ID || null,
        faceTemplate: process.env.AVR_PERSONA_FACEAUTH_TEMPLATE_ID || null,
        ageTemplate: process.env.AVR_PERSONA_AGE_TEMPLATE_ID || null
    };
}

/**
 * Which templates are not configured, for one check or for all three.
 *
 * An API key on its own is enough to select this provider over the stub, and
 * that is a trap: the provider name reads "persona", nothing warns, and the
 * first creator to reach the portal gets a 404 from a hosted flow that was
 * never given a template to run. Reported at startup and refused outright
 * under enforcement, so the gap is visible before a person hits it.
 *
 * Asked per check rather than globally, because the checks are independent: a
 * missing age template must not stop a creator enrolling.
 *
 * @param {'enrol'|'face'|'age'} [check] one check, or every check if omitted
 * @returns {string[]} the unset environment variable names, most important first
 */
export function personaTemplateGaps(check) {
    const { enrolTemplate, faceTemplate, ageTemplate } = config();

    const byCheck = {
        age: ageTemplate ? null : 'AVR_PERSONA_AGE_TEMPLATE_ID',
        enrol: enrolTemplate ? null : 'AVR_PERSONA_ENROL_TEMPLATE_ID',
        face: faceTemplate ? null : 'AVR_PERSONA_FACEAUTH_TEMPLATE_ID'
    };

    const wanted = check ? [byCheck[check]] : [byCheck.age, byCheck.enrol, byCheck.face];
    return wanted.filter(Boolean);
}

async function call(method, path, body) {
    const { apiKey } = config();

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Persona-Version': API_VERSION,
            // Ask for camelCase keys so the readers below match the property
            // names in this file rather than Persona's default kebab-case.
            'Key-Inflection': 'camel',
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const text = await res.text();
    const json = text ? safeJson(text) : null;

    if (!res.ok) {
        // Persona's errors carry a title and detail; surface both to the log
        // and neither to the creator - a verification failure reason can be
        // sensitive, and a transport failure is not their problem.
        const detail = json?.errors?.map((e) => e.title ?? e.detail).join('; ') || text.slice(0, 200);
        const err = new Error(`persona ${method} ${path} failed (${res.status}): ${detail}`);
        err.status = res.status;
        throw err;
    }

    return json;
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

const fieldValue = (fields, name) => fields?.[name]?.value ?? null;

/**
 * Was this person over 18 when they were verified?
 *
 * Fails closed. An inquiry that passed every document check but did not yield a
 * birthdate has not answered the one question an adult platform has to be able
 * to answer, and treating "unknown" as "adult" is how a platform ends up having
 * verified a minor with a clean audit trail saying otherwise.
 *
 * The birthdate itself is read here and discarded; only the boolean is stored.
 */
function adultFrom(fields) {
    const raw = fieldValue(fields, 'birthdate');
    if (!raw) return null;

    const born = new Date(raw);
    if (Number.isNaN(born.getTime())) return null;

    const eighteen = new Date(born.getFullYear() + 18, born.getMonth(), born.getDate());
    return eighteen.getTime() <= Date.now();
}

function handoffFrom(inquiry, oneTimeLink) {
    return {
        inquiryId: inquiry.data.id,
        clientUrl: oneTimeLink ?? null,
        // Present when the template is embedded rather than hosted; the browser
        // passes it to Persona's client SDK.
        clientToken: inquiry.data.attributes?.sessionToken ?? null
    };
}

async function oneTimeLinkFor(inquiryId) {
    try {
        const res = await call('POST', `/inquiries/${encodeURIComponent(inquiryId)}/generate-one-time-link`);
        return res?.meta?.oneTimeLink ?? res?.data?.attributes?.oneTimeLink ?? null;
    } catch (err) {
        // A missing link is recoverable - the embedded flow can still run from
        // the session token - so this must not fail the whole enrolment.
        console.warn('[identity] persona one-time link unavailable:', err.message);
        return null;
    }
}

/** @returns {import('./providers.js').IdentityProvider} */
export function personaProvider() {
    return {
        name: 'persona',
        isMock: false,

        async startEnrolment({ userId, redirectUrl = null }) {
            const { enrolTemplate } = config();
            if (!enrolTemplate) throw new Error('AVR_PERSONA_ENROL_TEMPLATE_ID is not set');

            const inquiry = await call('POST', '/inquiries', {
                data: {
                    attributes: {
                        inquiryTemplateId: enrolTemplate,
                        // Our user id, so a Persona-side investigation can be
                        // tied back to an account without us sending a name or
                        // an email to do it.
                        referenceId: userId,
                        ...(redirectUrl ? { redirectUri: redirectUrl } : {})
                    }
                }
            });

            return handoffFrom(inquiry, await oneTimeLinkFor(inquiry.data.id));
        },

        async fetchEnrolment(inquiryId) {
            const res = await call('GET', `/inquiries/${encodeURIComponent(inquiryId)}`);

            const attributes = res?.data?.attributes ?? {};
            const status = String(attributes.status ?? '').toLowerCase();
            const fields = attributes.fields ?? {};
            const subjectId = res?.data?.relationships?.account?.data?.id ?? null;

            const documentCountry = fieldValue(fields, 'selectedCountryCode') ?? fieldValue(fields, 'addressCountryCode');
            const documentType = fieldValue(fields, 'selectedIdClass') ?? fieldValue(fields, 'identificationClass');

            if (status === 'approved' || status === 'completed') {
                const adult = adultFrom(fields);

                if (adult !== true) {
                    return {
                        status: 'rejected',
                        subjectId,
                        documentCountry,
                        documentType,
                        adultConfirmed: false,
                        declineReason: adult === false ? 'under 18' : 'age could not be established from the document'
                    };
                }

                return {
                    status: 'verified',
                    subjectId,
                    documentCountry,
                    documentType,
                    adultConfirmed: true,
                    declineReason: null
                };
            }

            if (status === 'declined' || status === 'failed' || status === 'expired') {
                return {
                    status: 'rejected',
                    subjectId,
                    documentCountry,
                    documentType,
                    adultConfirmed: false,
                    declineReason: status === 'expired' ? 'the verification session expired' : 'the document check did not pass'
                };
            }

            // created | pending | needs_review - still Persona's to decide.
            return { status: 'pending', subjectId, documentCountry, documentType, adultConfirmed: false, declineReason: null };
        },

        async startFaceCheck({ userId, subjectId }) {
            const { faceTemplate } = config();
            if (!faceTemplate) throw new Error('AVR_PERSONA_FACEAUTH_TEMPLATE_ID is not set');
            if (!subjectId) throw new Error('no enrolled subject to check against');

            // Binding the inquiry to the account is the whole mechanism: the
            // selfie is compared against the one captured at enrolment, which
            // is the face that was matched to the document. Without accountId
            // this would only prove that a live human took a photo.
            const inquiry = await call('POST', '/inquiries', {
                data: {
                    attributes: {
                        inquiryTemplateId: faceTemplate,
                        accountId: subjectId,
                        referenceId: userId
                    }
                }
            });

            return handoffFrom(inquiry, await oneTimeLinkFor(inquiry.data.id));
        },

        async fetchFaceCheck(inquiryId) {
            const res = await call('GET', `/inquiries/${encodeURIComponent(inquiryId)}`);
            const status = String(res?.data?.attributes?.status ?? '').toLowerCase();

            if (status === 'approved' || status === 'completed') return { status: 'passed', reason: null };
            if (status === 'declined' || status === 'failed') return { status: 'failed', reason: 'the face did not match your enrolled identity' };
            if (status === 'expired') return { status: 'failed', reason: 'the check expired before it finished' };

            return { status: 'pending', reason: null };
        },

        /**
         * Age assurance for any account holder, creator or not.
         *
         * No `accountId` and no selfie: this inquiry exists to read a birthdate
         * off a document and then be forgotten. It is not an enrolment and
         * cannot be used as one - there is nothing here to face-check against
         * later, by construction.
         */
        async startAgeCheck({ userId, redirectUrl = null }) {
            const { ageTemplate } = config();
            if (!ageTemplate) throw new Error('AVR_PERSONA_AGE_TEMPLATE_ID is not set');

            const inquiry = await call('POST', '/inquiries', {
                data: {
                    attributes: {
                        inquiryTemplateId: ageTemplate,
                        referenceId: userId,
                        ...(redirectUrl ? { redirectUri: redirectUrl } : {})
                    }
                }
            });

            return handoffFrom(inquiry, await oneTimeLinkFor(inquiry.data.id));
        },

        async fetchAgeCheck(inquiryId) {
            const res = await call('GET', `/inquiries/${encodeURIComponent(inquiryId)}`);

            const attributes = res?.data?.attributes ?? {};
            const status = String(attributes.status ?? '').toLowerCase();
            const fields = attributes.fields ?? {};
            const documentCountry = fieldValue(fields, 'selectedCountryCode') ?? fieldValue(fields, 'addressCountryCode');

            if (status === 'approved' || status === 'completed') {
                const adult = adultFrom(fields);

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

            if (status === 'declined' || status === 'failed' || status === 'expired') {
                return {
                    status: 'rejected',
                    adultConfirmed: false,
                    documentCountry,
                    declineReason: status === 'expired' ? 'the check expired before it finished' : 'the document check did not pass'
                };
            }

            return { status: 'pending', adultConfirmed: false, documentCountry, declineReason: null };
        },

        /**
         * Redaction, not deletion of a row.
         *
         * This is the request that actually removes the biometric, because the
         * biometric is theirs and not ours. Dropping our reference without it
         * would leave a face template in their system that nobody can find any
         * more - the worst of both outcomes.
         */
        async forget(subjectId) {
            if (!subjectId) return;
            await call('DELETE', `/accounts/${encodeURIComponent(subjectId)}`);
        }
    };
}

/**
 * Verify a Persona webhook signature.
 *
 * The header is `t=<unix>,v1=<hex>` over `${t}.${rawBody}`. Timestamp checked
 * as well as signature: a replayed-but-valid webhook could otherwise re-apply
 * an old verdict - for instance re-approving a verification that has since
 * been revoked.
 *
 * @param {string|undefined} header - The `Persona-Signature` header.
 * @param {string|Buffer} rawBody
 * @param {string} secret
 * @param {number} [toleranceSeconds]
 */
export function verifyPersonaSignature(header, rawBody, secret, toleranceSeconds = 300) {
    if (!header || !secret) return false;

    const parts = Object.fromEntries(
        String(header)
            .split(',')
            .map((piece) => piece.trim().split('='))
            .filter((pair) => pair.length === 2)
    );

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) return false;
    if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const presented = String(parts.v1 ?? '');

    // Hash both sides to a fixed width: timingSafeEqual throws on a length
    // mismatch, and throwing is itself an observable difference.
    const a = crypto.createHash('sha256').update(expected).digest();
    const b = crypto.createHash('sha256').update(presented).digest();

    return crypto.timingSafeEqual(a, b);
}
