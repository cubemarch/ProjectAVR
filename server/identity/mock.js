/**
 * Deterministic stand-in for a real identity provider.
 *
 * Everything the real flow does - handing off to a hosted page, waiting, coming
 * back with a verdict - happens here without a network call, so the state
 * machine can be tested exhaustively including the paths a real provider makes
 * awkward to reach on demand (a declined document, a face that does not match,
 * a check that never completes).
 *
 * It approves by default. `mockControls()` is the only way to make it do
 * anything else, and nothing outside tests should be calling it.
 */

const DEFAULT_ENROLMENT = {
    status: 'verified',
    documentCountry: 'GB',
    documentType: 'passport',
    adultConfirmed: true,
    declineReason: null
};

const DEFAULT_FACE = { status: 'passed', reason: null };

const DEFAULT_AGE = {
    status: 'verified',
    adultConfirmed: true,
    documentCountry: 'GB',
    declineReason: null
};

const state = {
    counter: 0,
    enrolment: { ...DEFAULT_ENROLMENT },
    face: { ...DEFAULT_FACE },
    age: { ...DEFAULT_AGE },
    /** @type {Map<string, {kind: string, userId: string, subjectId: string|null}>} */
    inquiries: new Map(),
    /** @type {string[]} Subject ids the provider was told to forget. */
    forgotten: []
};

function nextId(prefix) {
    state.counter += 1;
    return `${prefix}_${state.counter}`;
}

/** @returns {import('./providers.js').IdentityProvider} */
export function mockProvider() {
    return {
        name: 'mock',
        isMock: true,

        async startEnrolment({ userId }) {
            const inquiryId = nextId('mock_enrol');
            state.inquiries.set(inquiryId, { kind: 'enrolment', userId, subjectId: null });
            return { inquiryId, clientUrl: `https://example.invalid/mock/${inquiryId}`, clientToken: null };
        },

        async fetchEnrolment(inquiryId) {
            const inquiry = state.inquiries.get(inquiryId);
            if (!inquiry) return { status: 'rejected', subjectId: null, adultConfirmed: false, declineReason: 'unknown inquiry' };

            const verdict = { ...state.enrolment };

            // The subject id is stable per user, the way a real provider's
            // account id is: re-enrolling the same person must not strand the
            // face checks that already reference them.
            return {
                ...verdict,
                subjectId: verdict.status === 'verified' ? `mock_subject_${inquiry.userId}` : null
            };
        },

        async startFaceCheck({ userId, subjectId }) {
            const inquiryId = nextId('mock_face');
            state.inquiries.set(inquiryId, { kind: 'face', userId, subjectId });
            return { inquiryId, clientUrl: `https://example.invalid/mock/${inquiryId}`, clientToken: null };
        },

        async fetchFaceCheck(inquiryId) {
            if (!state.inquiries.has(inquiryId)) return { status: 'failed', reason: 'unknown inquiry' };
            return { ...state.face };
        },

        async startAgeCheck({ userId }) {
            const inquiryId = nextId('mock_age');
            state.inquiries.set(inquiryId, { kind: 'age', userId, subjectId: null });
            return { inquiryId, clientUrl: `https://example.invalid/mock/${inquiryId}`, clientToken: null };
        },

        async fetchAgeCheck(inquiryId) {
            if (!state.inquiries.has(inquiryId)) {
                return { status: 'rejected', adultConfirmed: false, documentCountry: null, declineReason: 'unknown inquiry' };
            }
            return { ...state.age };
        },

        async forget(subjectId) {
            state.forgotten.push(subjectId);
        }
    };
}

/** Test-only steering. */
export function mockControls() {
    return {
        setEnrolment(verdict) {
            state.enrolment = { ...DEFAULT_ENROLMENT, ...verdict };
        },
        setFaceCheck(verdict) {
            state.face = { ...DEFAULT_FACE, ...verdict };
        },
        setAgeCheck(verdict) {
            state.age = { ...DEFAULT_AGE, ...verdict };
        },
        forgotten() {
            return [...state.forgotten];
        },
        reset() {
            state.enrolment = { ...DEFAULT_ENROLMENT };
            state.face = { ...DEFAULT_FACE };
            state.age = { ...DEFAULT_AGE };
            state.inquiries.clear();
            state.forgotten.length = 0;
        }
    };
}
