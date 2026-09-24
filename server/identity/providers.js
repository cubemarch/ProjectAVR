import { diditProvider, diditWorkflowGaps } from './didit.js';
import { personaProvider, personaTemplateGaps } from './persona.js';
import { mockProvider } from './mock.js';

/**
 * Identity verification providers.
 *
 * Two things have to be true of anyone who broadcasts here: they proved who
 * they are with a government document once, and the person starting *this*
 * broadcast is still that person. A document check answers the first. A face
 * check against the enrolled document answers the second.
 *
 * Both run at the provider. Nothing biometric crosses back into this process -
 * a provider returns a decision and an opaque subject id, never an image, a
 * template or an embedding. See the header in `db/schema.sql` for why that
 * boundary is drawn where it is, and why moving it is not a small change.
 *
 * @typedef {object} EnrolmentHandoff
 * @property {string} inquiryId - The provider's reference for this attempt.
 * @property {string|null} clientUrl - Hosted flow to send the browser to.
 * @property {string|null} clientToken - Session token for an embedded flow.
 *
 * @typedef {object} EnrolmentVerdict
 * @property {'pending'|'verified'|'rejected'} status
 * @property {string|null} subjectId - Opaque, stable, the handle for later face checks.
 * @property {string|null} documentCountry
 * @property {string|null} documentType
 * @property {boolean} adultConfirmed
 * @property {string|null} declineReason
 * @property {string|null} [expiresAt]
 *
 * @typedef {object} FaceVerdict
 * @property {'pending'|'passed'|'failed'} status
 * @property {string|null} reason
 *
 * @typedef {object} AgeVerdict
 * @property {'pending'|'verified'|'rejected'} status
 * @property {boolean} adultConfirmed
 * @property {string|null} documentCountry
 * @property {string|null} declineReason
 *
 * @typedef {object} IdentityProvider
 * @property {string} name
 * @property {boolean} isMock
 * @property {(input: {userId: string, redirectUrl?: string|null}) => Promise<EnrolmentHandoff>} startEnrolment
 * @property {(inquiryId: string) => Promise<EnrolmentVerdict>} fetchEnrolment
 * @property {(input: {userId: string, subjectId: string}) => Promise<EnrolmentHandoff>} startFaceCheck
 * @property {(inquiryId: string) => Promise<FaceVerdict>} fetchFaceCheck
 * @property {(input: {userId: string, redirectUrl?: string|null}) => Promise<EnrolmentHandoff>} startAgeCheck
 * @property {(inquiryId: string) => Promise<AgeVerdict>} fetchAgeCheck
 * @property {(subjectId: string) => Promise<void>} forget
 */

/**
 * The disclosure a creator agrees to before anything is collected.
 *
 * Served to the client rather than duplicated in it, and recorded by version
 * against the row, so that rewriting this text later cannot silently re-label
 * what somebody agreed to years ago. Bump the version whenever the text
 * changes in substance; existing creators are then re-prompted.
 */
export const CONSENT_VERSION = '2026-09-21.1';

export const CONSENT_TEXT = [
    'To broadcast on ProjectAVR you must confirm your identity with a government-issued document and a photo of your face.',
    'The check is carried out by our verification provider, not by ProjectAVR. Your document images and the biometric data derived from your face are collected, stored and processed by that provider under their retention schedule.',
    'ProjectAVR never receives or stores your face image, a face template, or a scan of your document. We store only the provider’s decision, an opaque reference that lets us ask them to re-check your face, the issuing country and type of document, and whether you were confirmed to be over 18.',
    'Each time you start a broadcast you will be asked to confirm your face again, in this browser, so that a stolen password alone cannot put someone else on air as you.',
    'You may withdraw consent at any time. Withdrawing deletes our reference and instructs the provider to delete what they hold; you will not be able to broadcast until you enrol again.'
].join('\n\n');

/**
 * The disclosure every account holder agrees to before the age check runs.
 *
 * Deliberately shorter and weaker than {@link CONSENT_TEXT}, because it covers
 * a weaker thing: a document is read to establish a date of birth, and nothing
 * about the person's face is enrolled or kept for later comparison. Promising
 * the stronger disclosure here would be inaccurate in the other direction -
 * it would describe an ongoing biometric relationship that a viewer does not
 * have.
 */
export const AGE_CONSENT_VERSION = '2026-09-21.1';

export const AGE_CONSENT_TEXT = [
    'ProjectAVR is an adult platform. Before you can watch anything you must confirm you are over 18 with a government-issued document.',
    'The check is carried out by our verification provider, not by ProjectAVR. Your document images are collected, stored and processed by that provider under their retention schedule.',
    'ProjectAVR never receives or stores a scan of your document or your date of birth. We store only whether the provider confirmed you are over 18, the issuing country, and when the check was done.',
    'This is a one-off check. Unlike creators, viewers do not enrol a photo of their face and are never asked to confirm their face again.',
    'You may ask us to delete your account at any time, which deletes our record of the check and instructs the provider to delete what they hold.'
].join('\n\n');

/** How long a completed verification is good for before re-enrolment. */
export const VERIFICATION_DAYS = Number(process.env.AVR_VERIFICATION_DAYS || 365);

/**
 * How long an age check is good for.
 *
 * Longer than a creator verification because it answers a question whose answer
 * only gets more true with time. It is not infinite, so that an account taken
 * over years later cannot ride a check nobody has looked at since.
 */
export const AGE_ASSURANCE_DAYS = Number(process.env.AVR_AGE_ASSURANCE_DAYS || 730);

/**
 * How long a face check unlocks the creator portal for.
 *
 * The user asked for once per browser session, so the token is held in
 * `sessionStorage` and dies with the tab regardless of this value; this is the
 * server-side ceiling for a tab left open overnight. Two hours is long enough
 * to plan, schedule and run a broadcast without a second selfie, and short
 * enough that an unattended machine is not a standing authorisation.
 */
export const PORTAL_UNLOCK_SECONDS = Number(process.env.AVR_PORTAL_UNLOCK_TTL || 7200);

/**
 * How long the phone's sign-in waits for a face check in the browser.
 *
 * Long enough to walk to a laptop, short enough that an approval prompt left
 * on screen is not still live an hour later.
 */
export const CHALLENGE_TTL_SECONDS = Number(process.env.AVR_CHALLENGE_TTL || 300);

/**
 * How long a minted grant stays usable before the creator must check again.
 *
 * Five minutes is the window between "I pressed the button in the browser" and
 * "the camera is rolling". Long enough to walk from a laptop to a rig and scan
 * a QR code; short enough that a screen left showing one is not still a working
 * credential when the room empties.
 */
export const GRANT_TTL_SECONDS = Number(process.env.AVR_GRANT_TTL || 300);

/**
 * How long after first use a grant may still be presented, to resume a
 * broadcast that dropped.
 *
 * A grant is consumed at HELLO, before the session exists, so without this a
 * single lost Wi-Fi frame permanently ends a broadcast and the creator has to
 * walk back to a browser and verify their face again. Ninety seconds covers the
 * phone's whole reconnection ladder (six attempts, capped backoff, about a
 * minute) with room for the operator to notice, and is short enough that a
 * grant lifted off the wire is stale before it is useful.
 *
 * Measured from first use and never refreshed, so this bounds the total life of
 * a spent grant rather than extending it once per reconnection.
 */
export const GRANT_RESUME_SECONDS = Number(process.env.AVR_GRANT_RESUME || 90);

/** Resolved challenges are audit material; the events table keeps the summary. */
export const CHALLENGE_RETENTION_DAYS = Number(process.env.AVR_CHALLENGE_RETENTION_DAYS || 30);

/**
 * Whether the live ingest refuses anything but a per-creator grant.
 *
 * Off by default: a fresh checkout, and every existing test, pairs the phone
 * with the shared `AVR_LIVE_KEY`. Turning this on is what replaces that key
 * with per-creator, face-checked, single-use grants.
 */
export function identityEnforced() {
    return process.env.AVR_IDENTITY_ENFORCE === '1';
}

const PROVIDERS = {
    didit: diditProvider,
    persona: personaProvider,
    mock: mockProvider
};

let cached = null;

/**
 * The configured provider.
 *
 * An unrecognised name is fatal rather than a fallback. Falling back to the
 * stub would mean a typo in `AVR_IDENTITY_PROVIDER` - `didit` misspelt, a
 * provider deleted from this map - turns every document and every face into an
 * approval, reports itself as working, and gives no indication anywhere that
 * the name was not understood. That is the single worst failure this subsystem
 * has, and it is not worth the convenience of a default.
 *
 * @returns {IdentityProvider}
 */
export function getProvider() {
    if (cached) return cached;

    const wanted = process.env.AVR_IDENTITY_PROVIDER || defaultProviderName();

    const make = PROVIDERS[wanted];
    if (!make) {
        throw new Error(
            `AVR_IDENTITY_PROVIDER=${wanted} is not a provider this server has. ` +
                `Known: ${Object.keys(PROVIDERS).join(', ')}.`
        );
    }

    cached = make();
    return cached;
}

/**
 * A key on its own selects its provider, so that setting one variable is enough
 * to leave the stub behind. Both keys present is ambiguous and is not guessed
 * at - naming the provider resolves it.
 */
function defaultProviderName() {
    const keyed = [
        process.env.AVR_DIDIT_API_KEY ? 'didit' : null,
        process.env.AVR_PERSONA_API_KEY ? 'persona' : null
    ].filter(Boolean);

    if (keyed.length > 1) {
        throw new Error(
            `Both ${keyed.join(' and ')} API keys are set. Set AVR_IDENTITY_PROVIDER to say which one to use.`
        );
    }

    return keyed[0] ?? 'mock';
}

/** Tests and the config surface both need to re-resolve after changing env. */
export function resetProvider() {
    cached = null;
}

const GAPS = {
    didit: diditWorkflowGaps,
    persona: personaTemplateGaps,
    mock: () => []
};

/**
 * Configuration missing from the selected provider, as env var names.
 *
 * Empty for the stub: it needs nothing, which is exactly why it is the
 * dangerous one. Both real providers need three hosted flows on top of a key -
 * Didit calls them workflows, Persona calls them templates - and a key with no
 * flows is a provider that reports itself as configured and cannot run a single
 * check.
 *
 * @param {'enrol'|'face'|'age'} [check] one check, or every check if omitted
 * @returns {string[]}
 */
export function identityGaps(check) {
    return (GAPS[getProvider().name] ?? (() => []))(check);
}

/**
 * Refuse to start an enforcing deployment that cannot actually check anybody.
 *
 * Two ways to be in that state. The mock approves everyone, and enforcement on
 * top of it looks exactly like a working identity gate from the outside - the
 * worst possible failure, an adult platform that believes it is checking
 * documents and is not. A real key with no hosted flows behind it is the same
 * failure wearing a better name: the provider reports "didit" and every check
 * fails at the point a person tries to use it.
 */
export function assertIdentityConfigured() {
    if (!identityEnforced()) return;

    const provider = getProvider();

    if (provider.isMock) {
        throw new Error(
            'AVR_IDENTITY_ENFORCE=1 with the mock identity provider. ' +
                'Set AVR_DIDIT_API_KEY (and the workflow ids) or unset enforcement - ' +
                'the mock approves every face and every document.'
        );
    }

    const gaps = identityGaps();
    if (gaps.length) {
        throw new Error(
            `AVR_IDENTITY_ENFORCE=1 with ${provider.name}, but ${gaps.join(', ')} ` +
                `${gaps.length === 1 ? 'is' : 'are'} not set. ` +
                'Every hosted flow needs an id; without one the check cannot run at all.'
        );
    }
}
