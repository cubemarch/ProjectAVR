/**
 * What an account is asked to agree to, and which wording it was asked with.
 *
 * Two agreements, because two different things are being promised. Everybody
 * accepts the terms of use. An account that will point a camera at itself and
 * charge for it accepts a second, stricter one, and it is kept separate so a
 * viewer is never shown publisher obligations that do not apply to them - and
 * so an account that becomes a creator later is asked the creator question at
 * that moment rather than being deemed to have answered it at signup.
 *
 * The version strings are the load-bearing part. Editing the text below
 * without bumping the version leaves existing accounts recorded as having
 * accepted wording they never saw; that is the one change that must not be
 * made silently.
 */

export const TERMS_VERSION = '2026-09-23';
export const CREATOR_TERMS_VERSION = '2026-09-23';

export const TERMS_TEXT = [
    'You are creating an account on a live video service. You confirm that you are at least 18 years old and that you will complete the age check this service runs on every account.',
    'One account per person. Keep your password to yourself; anything done with your account is treated as done by you.',
    'Do not record, screenshot, re-upload or redistribute anything you watch here. Do not harass another account, and do not ask a creator for anything illegal.',
    'Credits buy viewing time. They are not money, are not refundable once spent, and expire only if your account is closed.',
    'We can suspend an account that breaks these terms, and we will tell you why.'
];

export const CREATOR_TERMS_TEXT = [
    'You are asking to broadcast on this service. Before you can go on air you will verify your identity with a government-issued document and a face check, run by our identity provider. We keep the provider\'s reference for you and the result. We do not keep your face, your document, or any biometric template.',
    'Everyone who appears on your broadcast must be 18 or over and must have agreed to appear. You are responsible for that, for every person, every time.',
    'You set your own per-minute prices, and you may change them. A viewer is charged the price shown when they joined.',
    'Your broadcasts are yours. Recording of a 1:1 is governed by the policy you set in your profile, and that policy is shown to the viewer before they join.',
    'You will be asked to pass a face check each time you start a broadcast. It exists so that a stolen password cannot put somebody else on your camera.',
    'Do not broadcast anything illegal, anything involving a minor, or anything you do not have the right to show. We can end a broadcast and close an account for this without notice.'
];

/** The shape the signup form renders. */
export function agreementsView() {
    return {
        terms: { version: TERMS_VERSION, clauses: TERMS_TEXT },
        creator: { version: CREATOR_TERMS_VERSION, clauses: CREATOR_TERMS_TEXT }
    };
}

/**
 * Whether a submitted acceptance is the wording currently on offer.
 *
 * A stale version is refused rather than upgraded: the point of the version is
 * that somebody read *that* text, and a page left open across a deployment did
 * not read the new one.
 */
export function isCurrentTerms(version) {
    return version === TERMS_VERSION;
}

export function isCurrentCreatorTerms(version) {
    return version === CREATOR_TERMS_VERSION;
}
