import { BRAND } from '../../brand.js';
import { api } from '../api/client.js';
import { sleepUntilReturn } from '../api/identity-return.js';
import { brandLockup } from './brand-mark.js';
import { icons } from './icons.js';
import {
    cameraAvailable,
    cameraProblem,
    declineText,
    frameFrom,
    openSelfieCamera,
    stopSelfieCamera
} from './selfie-capture.js';
import './auth-modal.css';

/**
 * Florida's statutory name for the route that keeps nothing, and the only
 * method here that is not a document handed to a popup.
 */
const SELFIE_METHOD = 'anonymous';

/**
 * Sign in, sign up, and the identity step that follows signing up.
 *
 * One dialog rather than a set of pages: the app stays usable while signed
 * out, so authentication is an overlay on what you were already doing rather
 * than a wall in front of it. It is mounted from every page, including the
 * live monitor, which is why it brings its own stylesheet instead of relying
 * on the home page's.
 *
 * Six steps, which are really two questions and four answers:
 *
 *   login         who are you
 *   register      who are you going to be - as a user, or as a creator
 *   creator       the publisher agreement on its own, for Become a creator
 *   attest        a button, for a viewer in a state with no statute
 *   age           a document check, for a viewer in one of the twenty-seven,
 *                 or in Florida alone a photograph instead, if they pick it
 *   enrol         a document *and* a face, for a creator, once, here at signup
 *
 * The split between the last three is the whole design.
 *
 * `attest` and `age` are the same question asked at two strengths, and which
 * one a viewer gets is the server's decision from the address the request came
 * from - never this file's, and never a preference. `_afterAuth` reads
 * `api.ageOwes` and does what it is told. Twenty-seven states require a real
 * check; asking everyone else for a government document would be collecting
 * one because we could rather than because we had to.
 *
 * `enrol` is a different thing again: a user is never asked for a face. A
 * creator is asked for one exactly once at registration, and the enrolment
 * reads their birthdate off the same document, so they are never sent through
 * either age step afterwards - see `adultConfirmed` on the server. The face
 * check that happens *per broadcast* belongs to the Go live panel in Studio.
 */
export class AuthModal {
    constructor() {
        this.el = null;
        this.mode = 'login';
        this.role = 'viewer';
        this.reason = '';
        this.checkState = null;
        /** The server's reading of where this request came from. @type {object|null} */
        this.jurisdiction = null;
        this._resolve = null;
        this._terms = null;
        /** Live only during the camera step; see {@link _stopCamera}. @type {MediaStream|null} */
        this._stream = null;
    }

    /**
     * @param {'login'|'register'} [mode]
     * @param {string} [reason] - Why the user is being asked, e.g. "to upload".
     * @param {{role?: 'viewer'|'creator'}} [options]
     * @returns {Promise<object|null>} The signed-in user, or null if dismissed.
     */
    open(mode = 'login', reason = '', options = {}) {
        this.mode = mode;
        this.reason = reason;
        this.role = options.role ?? 'viewer';

        this._show();
        if (mode === 'register') this._loadAgreements();

        return this._promise();
    }

    /**
     * The upgrade path for an account that already exists.
     *
     * A user was never shown the publisher agreement, so this asks for it
     * before the role changes, and goes straight on to the enrolment - which
     * is the same sequence a creator signup runs, minus the account creation.
     */
    openBecomeCreator() {
        this.mode = 'creator';
        this.reason = '';
        this.role = 'creator';

        this._show();
        this._loadAgreements();

        return this._promise();
    }

    _show() {
        if (!this.el) this._build();
        this._render();

        this.el.classList.add('open');
        document.body.style.overflow = 'hidden';
        setTimeout(() => this.el.querySelector('.auth-form input[type="text"], .auth-form input[type="email"]')?.focus(), 60);
    }

    _promise() {
        return new Promise((resolve) => {
            this._resolve = resolve;
        });
    }

    close(user = null) {
        // Before anything else: a dialog dismissed with the camera open would
        // otherwise leave the light on behind it. Escape reaches this too.
        this._stopCamera();

        this.el?.classList.remove('open');
        document.body.style.overflow = '';
        this._resolve?.(user);
        this._resolve = null;
    }

    /**
     * The agreement wording, fetched rather than written into this file.
     *
     * The version that comes back is submitted with the form, so the server
     * can refuse a page that has been open across a change to the text. A
     * failure here leaves the form rendered with nothing to agree to, which is
     * the correct outcome: an account should not be created against wording
     * the browser could not load.
     */
    async _loadAgreements() {
        try {
            this._terms = await api.agreements();
        } catch (err) {
            this._terms = { error: err.message };
        }
        if (this.mode === 'register' || this.mode === 'creator') this._render();
    }

    _build() {
        const el = document.createElement('div');
        // Not `.modal-backdrop`: the dialog opens over pages that do not load
        // the home page's stylesheet, so it carries only classes its own sheet
        // defines.
        el.className = 'auth-backdrop';
        document.body.appendChild(el);
        this.el = el;

        el.addEventListener('click', (e) => {
            if (e.target === el || e.target.closest('[data-close]')) this.close(null);
        });

        el.addEventListener('submit', (e) => {
            e.preventDefault();
            this._submit();
        });

        el.addEventListener('change', (e) => {
            // Picking a route swaps which disclosure is on screen, by hand
            // rather than through `_render`: a re-render would rebuild the
            // consent checkbox and silently untick it, so somebody who agreed
            // and then changed their mind about the method would press a
            // button that told them to agree first.
            if (e.target.closest('input[name="checkMethod"]')) {
                this._showDisclosure();
                return;
            }

            // The role toggle re-renders the form, so anything already typed
            // has to survive it.
            const role = e.target.closest('input[name="signupRole"]');
            if (!role) return;
            this.role = role.value === 'creator' ? 'creator' : 'viewer';
            this._render(this._formValues());
        });

        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-attest="confirm"]')) {
                this._runAttestation();
                return;
            }
            if (e.target.closest('[data-attest="retry"]')) {
                this._enterCheckStep('attest');
                return;
            }
            if (e.target.closest('[data-attest="leave"]')) {
                // Not a dismissal. Somebody who says they are under 18 must not
                // be left looking at the page behind the dialog, and the only
                // place this app can send them that is certainly not an adult
                // platform is off it.
                window.location.href = 'https://www.google.com/';
                return;
            }
            if (e.target.closest('[data-age="start"]')) {
                this._runAgeCheck();
                return;
            }
            if (e.target.closest('[data-age="capture"]')) {
                this._captureSelfie();
                return;
            }
            if (e.target.closest('[data-age="cancel"]')) {
                // Back to the choice with the camera off, not out of the
                // dialog: somebody who thought better of being photographed
                // still owes this state a check, and the document route is
                // the other half of the offer.
                this._stopCamera();
                this.checkState = { ...this.checkState, step: 'consent' };
                this._render();
                return;
            }
            if (e.target.closest('[data-enrol="start"]')) {
                this._runEnrolment();
                return;
            }
            if (e.target.closest('[data-skip]')) {
                this.close(api.user);
                return;
            }

            const toggle = e.target.closest('[data-toggle-mode]');
            if (!toggle) return;
            this.mode = this.mode === 'login' ? 'register' : 'login';
            if (this.mode === 'register' && !this._terms) this._loadAgreements();
            this._render();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && el.classList.contains('open')) this.close(null);
        });
    }

    /** What is currently typed, so a re-render does not empty the form. */
    _formValues() {
        const form = this.el?.querySelector('form');
        if (!form) return {};
        return Object.fromEntries(new FormData(form));
    }

    /* -------------------------------------------------------------- render -- */

    _render(values = {}) {
        if (this.mode === 'attest') {
            this.el.innerHTML = this._attestHtml();
            return;
        }
        if (this.mode === 'age') {
            this.el.innerHTML = this._checkHtml('age');
            return;
        }
        if (this.mode === 'enrol') {
            this.el.innerHTML = this._checkHtml('enrol');
            return;
        }
        if (this.mode === 'creator') {
            this.el.innerHTML = this._creatorHtml();
            return;
        }

        const isLogin = this.mode === 'login';
        this.el.innerHTML = isLogin ? this._loginHtml() : this._registerHtml(values);
    }

    _shell({ title, body, alt = '' }) {
        return `
            <div class="auth-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                <button class="modal-close" data-close aria-label="Close">${icons.close({ size: 18 })}</button>

                <div class="auth-head">
                    <div class="brand">${brandLockup({ symbolHeight: 56, wordmarkHeight: 36 })}</div>
                    <h2>${escapeHtml(title)}</h2>
                    ${this.reason ? `<p class="auth-reason">${escapeHtml(this.reason)}</p>` : ''}
                </div>

                ${body}
                ${alt ? `<div class="auth-alt">${alt}</div>` : ''}
            </div>
        `;
    }

    _loginHtml() {
        return this._shell({
            title: 'Sign in',
            body: `
                <form class="auth-form" novalidate>
                    <div class="field-error" data-error hidden></div>

                    <label>
                        <span>Email</span>
                        <input name="email" type="email" autocomplete="email" required placeholder="you@example.com" />
                    </label>

                    <label>
                        <span>Password</span>
                        <input name="password" type="password" required minlength="10" autocomplete="current-password" />
                    </label>

                    <button type="submit" class="btn btn-primary auth-submit">Sign in</button>
                </form>`,
            alt: `New here? <button data-toggle-mode>Create an account</button>`
        });
    }

    /**
     * The signup form, in two shapes.
     *
     * Everything above the toggle is the same for both, because it is the same
     * account either way. What differs below it is not decoration: a creator
     * is publishing, so they name themselves for a card on the home page, and
     * they agree to a second set of obligations that a user has no business
     * being shown.
     */
    _registerHtml(values = {}) {
        const creator = this.role === 'creator';
        const value = (name) => escapeHtml(values[name] ?? '');

        return this._shell({
            title: 'Create your account',
            body: `
                <form class="auth-form" novalidate>
                    <div class="field-error" data-error hidden></div>

                    <div class="role-toggle" role="radiogroup" aria-label="Account type">
                        <label class="${creator ? '' : 'on'}">
                            <input type="radio" name="signupRole" value="viewer" ${creator ? '' : 'checked'} />
                            <span class="role-name">User</span>
                            <span class="role-note">Watch live streams</span>
                        </label>
                        <label class="${creator ? 'on' : ''}">
                            <input type="radio" name="signupRole" value="creator" ${creator ? 'checked' : ''} />
                            <span class="role-name">Creator</span>
                            <span class="role-note">Broadcast and get paid</span>
                        </label>
                    </div>

                    <label>
                        <span>Display name</span>
                        <input name="displayName" type="text" autocomplete="name" required minlength="2" maxlength="60"
                               value="${value('displayName')}"
                               placeholder="${creator ? 'The name viewers will see' : 'Ada Lovelace'}" />
                    </label>

                    <label>
                        <span>Email</span>
                        <input name="email" type="email" autocomplete="email" required
                               value="${value('email')}" placeholder="you@example.com" />
                    </label>

                    <label>
                        <span>Password</span>
                        <input name="password" type="password" required minlength="10" autocomplete="new-password"
                               placeholder="At least 10 characters" />
                    </label>

                    ${
                        creator
                            ? `<label>
                                   <span>Tagline</span>
                                   <input name="tagline" type="text" required minlength="2" maxlength="120"
                                          value="${value('tagline')}"
                                          placeholder="One line under your name on the home page" />
                               </label>

                               <label>
                                   <span>About you <em>optional</em></span>
                                   <textarea name="bio" rows="3" maxlength="2000"
                                             placeholder="Shown on your profile.">${value('bio')}</textarea>
                               </label>`
                            : ''
                    }

                    ${this._agreementsHtml(creator)}

                    ${
                        creator
                            ? `<p class="auth-note">
                                   Next: a one-time ID check. You will photograph a government ID and take a
                                   short face scan with our identity provider. We keep their reference and the
                                   result — never your face, your document, or a biometric template.
                               </p>`
                            : ''
                    }

                    <button type="submit" class="btn btn-primary auth-submit">
                        ${creator ? 'Create creator account' : 'Create account'}
                    </button>
                </form>`,
            alt: `Already have an account? <button data-toggle-mode>Sign in</button>`
        });
    }

    /** The agreement checkboxes, with the wording behind each one. */
    _agreementsHtml(creator) {
        if (!this._terms) return '<p class="auth-reason">Loading the terms…</p>';
        if (this._terms.error) {
            return `<div class="field-error">The terms could not be loaded: ${escapeHtml(this._terms.error)}</div>`;
        }

        return `
            <label class="checkbox">
                <input name="acceptTerms" type="checkbox" />
                <span>I have read and accept the terms of use, and I am over 18.</span>
            </label>
            ${clausesHtml('Terms of use', this._terms.terms)}

            ${
                creator
                    ? `<label class="checkbox">
                           <input name="acceptCreatorTerms" type="checkbox" />
                           <span>I accept the creator agreement.</span>
                       </label>
                       ${clausesHtml('Creator agreement', this._terms.creator)}`
                    : ''
            }

            <label class="checkbox">
                <input name="marketingEmails" type="checkbox" />
                <span>Email me news and offers. Optional, and you can turn it off at any time.</span>
            </label>
        `;
    }

    /** Become a creator: the publisher agreement, alone. */
    _creatorHtml() {
        const body = this._terms?.error
            ? `<div class="field-error">The agreement could not be loaded: ${escapeHtml(this._terms.error)}</div>`
            : !this._terms
              ? '<p class="auth-reason">Loading the agreement…</p>'
              : `<form class="auth-form" novalidate>
                     <div class="field-error" data-error hidden></div>

                     <p class="auth-reason">
                         Creator accounts can broadcast, set their own per-minute prices, and take 1:1 calls.
                     </p>

                     ${clausesHtml('Creator agreement', this._terms.creator, true)}

                     <label class="checkbox">
                         <input name="acceptCreatorTerms" type="checkbox" />
                         <span>I accept the creator agreement.</span>
                     </label>

                     <p class="auth-note">
                         Next: a one-time ID check. You will photograph a government ID and take a short face
                         scan with our identity provider. We keep their reference and the result — never your
                         face, your document, or a biometric template.
                     </p>

                     <button type="submit" class="btn btn-primary auth-submit">Become a creator</button>
                 </form>`;

        return this._shell({ title: 'Become a creator', body });
    }

    /* ------------------------------------------------------ identity steps -- */

    /**
     * The button, for a viewer whose state asks for nothing more.
     *
     * Deliberately not dressed up as a check. It records that a person was
     * asked and answered, which is all it is, and the second button is a real
     * exit rather than a dismissal - a dialog whose only negative answer closes
     * it and reveals the catalogue underneath would make the whole screen
     * decorative.
     *
     * The wording and its version both come from the server, on the same
     * reasoning as the other two disclosures: this page cannot record agreement
     * to text nobody has seen.
     */
    _attestHtml() {
        const state = this.checkState ?? {};
        const attestation = this.jurisdiction?.attestation;

        // Retry re-enters the step rather than re-pressing the button, because
        // the failure may have been the policy not loading at all - in which
        // case there is no wording on screen and nothing to confirm agreement
        // to, and pressing again would post a version we never showed.
        const body = state.step === 'error'
            ? `<div class="field-error">${escapeHtml(state.message ?? '')}</div>
               <button type="button" class="btn btn-primary auth-submit" data-attest="retry">Try again</button>`
            : `<div class="consent-text"><p>${escapeHtml(attestation?.text ?? '')
                  .replace(/\n\n/g, '</p><p>')}</p></div>
               <button type="button" class="btn btn-primary auth-submit" data-attest="confirm">I am 18 or over</button>
               <button type="button" class="btn auth-submit" data-attest="leave">I am under 18</button>`;

        return this._shell({ title: 'Confirm your age', body: `<div class="auth-form">${body}</div>` });
    }

    /**
     * The age check and the enrolment, which are the same three screens.
     *
     * The disclosure text comes from the server and consent is recorded
     * against the version the server served, so this page cannot record
     * agreement to wording nobody has seen.
     *
     * @param {'age'|'enrol'} kind
     */
    _checkHtml(kind) {
        const state = this.checkState ?? {};
        const enrolling = kind === 'enrol';
        const where = this.jurisdiction;

        // Named, because "we need to see your ID" with no reason reads as a
        // choice this platform made and it is not one. A viewer who wants to
        // check gets the citation and a link to the statute itself.
        const because =
            !enrolling && where?.state
                ? ` ${escapeHtml(where.state)} law requires us to verify your age before showing you
                    anything${where.statuteUrl ? ` (<a href="${escapeHtml(where.statuteUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(where.citation ?? 'the statute')}</a>)` : ''}.`
                : '';

        const intro = enrolling
            ? `Before you can go on air we need to know who you are. One ID check and a short face
               scan, once — the face is matched by our provider and never stored here.`
            : `${BRAND} is an adult platform.${because} One document check and you are in — it takes
               about a minute.`;

        // The choice comes before the wording, not after, because in Florida
        // the two routes have different disclosures and only the one that
        // matches the choice is shown. Everywhere else there is no choice and
        // `_methodsHtml` renders nothing, so this is the usual single block.
        const body = {
            consent: `
                <p class="auth-reason">${intro}</p>
                ${enrolling ? '' : this._methodsHtml()}
                ${
                    enrolling
                        ? `<div class="consent-text">${escapeHtml(state.text ?? '').replace(/\n\n/g, '</p><p>')}</div>`
                        : this._disclosuresHtml(state)
                }
                <label class="checkbox">
                    <input name="checkConsent" type="checkbox" />
                    <span>${enrolling ? 'I agree to the check described above.' : 'I agree, and I am over 18.'}</span>
                </label>
                <button type="button" class="btn btn-primary auth-submit" data-${kind}="start">${
                    this._selfiePicked() ? 'Start the camera' : 'Start the check'
                }</button>`,

            starting: '<p class="auth-reason">Opening the check…</p>',

            // The one step that must not be re-rendered while it is on screen:
            // rebuilding `innerHTML` would replace the `<video>` and drop the
            // stream with it. Every path out of here stops the camera first.
            camera: `
                <p class="auth-reason">${escapeHtml(state.message ?? 'When your face fills the frame, take the photo.')}</p>
                <div class="age-gate-camera"><video class="age-gate-cam" data-cam playsinline muted></video></div>
                <button type="button" class="btn btn-primary auth-submit" data-age="capture">Take the photo</button>
                <button type="button" class="btn auth-submit" data-age="cancel">Use a document instead</button>`,

            waiting: `
                <p class="auth-reason">Follow the steps in the window that just opened.</p>
                ${state.blocked ? '<div class="field-error">Your browser blocked the window.</div>' : ''}
                ${
                    state.clientUrl
                        ? `<p class="auth-reason"><a href="${escapeHtml(state.clientUrl)}" target="_blank" rel="noopener">Open it here</a></p>`
                        : ''
                }`,

            rejected: `
                <p class="auth-reason">${escapeHtml(state.message ?? 'The check did not pass.')}</p>
                <button type="button" class="btn btn-primary auth-submit" data-${kind}="start">Try again</button>
                ${enrolling ? '<button type="button" class="btn auth-submit" data-skip>Finish later</button>' : ''}`,

            error: `
                <div class="field-error">${escapeHtml(state.message ?? '')}</div>
                <button type="button" class="btn btn-primary auth-submit" data-${kind}="start">Try again</button>
                ${enrolling ? '<button type="button" class="btn auth-submit" data-skip>Finish later</button>' : ''}`
        }[state.step ?? 'consent'];

        // The enrolment can be postponed and the age check cannot. A creator
        // who walks away has an account that can do everything a user's can;
        // a user who walks away has one that can see nothing, so offering
        // "later" there would be offering a dead end.
        return this._shell({ title: enrolling ? 'Verify your identity' : 'Confirm your age', body: `<div class="auth-form">${body}</div>` });
    }

    /**
     * The choice of verification route, where the viewer is owed one.
     *
     * Florida is the only state that requires this, and it requires it as an
     * *offer*: both a standard and an anonymous route have to be available and
     * the viewer picks. Nothing is pre-selected, which is the point - the
     * server refuses a start with no method rather than defaulting one, so a
     * viewer who ignores this cannot be quietly given the route we preferred.
     *
     * Everywhere else there is one route and this renders nothing.
     */
    _methodsHtml() {
        const where = this.jurisdiction;
        if (!where?.requiresChoice) return '';

        const options = (where.methods ?? [])
            .map((m) => {
                // The anonymous route needs an endpoint this deployment may
                // not have. Shown and disabled rather than dropped, because
                // the statute is about what was *offered*: a viewer who was
                // told two routes exist and finds one of them greyed out
                // knows the offer was real and that this server cannot run
                // it, where a silently shorter list reads as a choice nobody
                // was given.
                const off = m.id === SELFIE_METHOD && !where.selfieReady;
                const on = m.id === this.checkState?.method;

                return `
                <label class="checkbox${off ? ' is-unavailable' : ''}">
                    <input name="checkMethod" type="radio" value="${escapeHtml(m.id)}"${off ? ' disabled' : ''}${
                        on ? ' checked' : ''
                    } />
                    <span>${escapeHtml(m.label)}<small>${escapeHtml(m.describe)}${
                        off ? ' <em>Not available on this server.</em>' : ''
                    }</small></span>
                </label>`;
            })
            .join('');

        return `<p class="auth-reason">Choose how you would like to be verified.</p>
                <div class="method-choice">${options}</div>`;
    }

    /**
     * The disclosure, or both of them where there are two routes to pick from.
     *
     * Reusing the document wording over a camera capture would be a consent
     * record naming a check that did not happen - it promises a document is
     * what is read and that a viewer is never asked for their face, and on the
     * anonymous route neither is true. So each route carries its own text and
     * its own version, and only the one matching the current choice is
     * visible. Until something is picked, neither is.
     */
    _disclosuresHtml(state) {
        const asBlock = (kind, text) =>
            `<div class="consent-text" data-consent-for="${kind}"${
                this._disclosureKind() === kind ? '' : ' hidden'
            }>${escapeHtml(text ?? '').replace(/\n\n/g, '</p><p>')}</div>`;

        if (!this.jurisdiction?.requiresChoice) return asBlock('document', state.text);

        return asBlock('document', state.text) + asBlock(SELFIE_METHOD, state.selfieText);
    }

    /**
     * Which route is picked right now, or null before anything is.
     *
     * The radios only exist on the consent step, so the remembered choice is
     * the answer on the camera and decline steps - where it is what decides
     * whether "try again" means the camera or a document. On the consent step
     * the remembered choice is rendered as a checked radio, so the DOM
     * answers first and the fallback never contradicts it.
     */
    _pickedMethod() {
        return (
            this.el?.querySelector('input[name="checkMethod"]:checked')?.value ??
            this.checkState?.method ??
            null
        );
    }

    _selfiePicked() {
        return this._pickedMethod() === SELFIE_METHOD;
    }

    /** Which disclosure belongs with the current choice; null until one is made. */
    _disclosureKind() {
        const picked = this._pickedMethod();
        if (picked) return picked === SELFIE_METHOD ? SELFIE_METHOD : 'document';

        return this.jurisdiction?.requiresChoice ? null : 'document';
    }

    /** Switch into an identity step, loading the disclosure it needs. */
    async _enterCheckStep(kind) {
        this.mode = kind;
        this.reason = '';
        this.checkState = { step: 'starting' };
        this._render();

        try {
            // Both age steps name the statute and the attest step *is* the
            // statute's absence, so the policy is loaded before either paints.
            // The enrolment does not depend on it and does not wait for it.
            if (kind !== 'enrol') this.jurisdiction = await api.identity.jurisdiction();

            if (kind === 'attest') {
                this.checkState = { step: 'consent', version: this.jurisdiction?.attestation?.version };
                this._render();
                return;
            }

            const consent = await api.identity.consent();
            this.checkState =
                kind === 'enrol'
                    ? { step: 'consent', text: consent.text, version: consent.version }
                    : {
                          step: 'consent',
                          text: consent.age.text,
                          version: consent.age.version,
                          // Both disclosures are loaded even where only one is
                          // offered, for the same reason they are rendered
                          // together: a Florida viewer picks between them on
                          // this screen, so both have to be readable before
                          // the choice, not fetched after it.
                          selfieText: consent.selfie?.text,
                          selfieVersion: consent.selfie?.version
                      };
        } catch (err) {
            this.checkState = { step: 'error', message: err.message };
        }

        this._render();
    }

    /**
     * The button press.
     *
     * One round trip and no polling: there is no provider in this path and
     * nothing to wait for. The session is re-read afterwards for the same
     * reason the document flow re-reads it - the page behind the dialog is
     * still holding the answer from before the press.
     */
    async _runAttestation() {
        const version = this.jurisdiction?.attestation?.version;

        try {
            await api.identity.attest(version);
            await api.restore();
            this.close(api.user);
        } catch (err) {
            this.checkState = { step: 'error', version, message: err.message };
            this._render();
        }
    }

    _runAgeCheck() {
        const picked = this._pickedMethod();

        // Not a variant of the document flow and not routed through it. The
        // server refuses `method: 'anonymous'` on `/age` outright, because
        // that route used to accept it and quietly run a document check
        // instead - which is the failure this branch exists to make
        // impossible from the client side as well.
        // Remembered before either branch: the radios live on the consent
        // step alone, and both of the screens past it need to know which way
        // "try again" goes.
        this.checkState = { ...this.checkState, method: picked };

        if (picked === SELFIE_METHOD) return this._openCamera();

        return this._runCheck({
            start: (version) => api.identity.startAge(version, picked),
            poll: () => api.identity.completeAge(),
            windowName: 'avr-age-check',
            flow: 'age'
        });
    }

    /** Show the disclosure for the chosen route, and name the button for it. */
    _showDisclosure() {
        const kind = this._disclosureKind();

        for (const block of this.el.querySelectorAll('[data-consent-for]')) {
            block.hidden = block.dataset.consentFor !== kind;
        }

        const button = this.el.querySelector('[data-age="start"]');
        if (button) button.textContent = kind === SELFIE_METHOD ? 'Start the camera' : 'Start the check';
    }

    /**
     * Open the camera for the anonymous route.
     *
     * The consent check is the same one `_runCheck` makes, repeated rather
     * than shared because this path never reaches it - and skipping it here
     * would mean a photograph taken before anybody agreed to the wording that
     * describes what happens to it.
     */
    async _openCamera() {
        const agreed = this.el.querySelector('input[name="checkConsent"]');
        if (agreed && !agreed.checked) {
            this.checkState = { ...this.checkState, step: 'error', message: 'You have to agree before the check can start.' };
            this._render();
            return;
        }

        if (!cameraAvailable()) {
            this.checkState = {
                ...this.checkState,
                step: 'error',
                message: 'This browser will not let the page use a camera. Choose the document route instead.'
            };
            this._render();
            return;
        }

        // Rendered first so the `<video>` exists to attach to, and not
        // re-rendered again until the camera is stopped.
        this.checkState = { ...this.checkState, step: 'camera', message: 'Starting the camera…' };
        this._render();

        try {
            this._stream = await openSelfieCamera(this.el.querySelector('[data-cam]'));
        } catch (err) {
            this._stream = null;
            this.checkState = { ...this.checkState, step: 'error', message: cameraProblem(err) };
            this._render();
            return;
        }

        const hint = this.el.querySelector('.auth-reason');
        if (hint) hint.textContent = 'When your face fills the frame, take the photo.';
    }

    /**
     * One frame, one request, one answer.
     *
     * No polling and no popup: the estimate is synchronous, so unlike every
     * other check in this dialog there is nothing to come back for. The
     * camera is stopped before the request rather than after - the frame is
     * already in hand, and nobody should be watching themselves on camera
     * while the answer arrives.
     */
    async _captureSelfie() {
        const button = this.el.querySelector('[data-age="capture"]');
        if (button) button.disabled = true;

        const photo = await frameFrom(this.el.querySelector('[data-cam]'));
        this._stopCamera();

        if (!photo) {
            this.checkState = { ...this.checkState, step: 'rejected', message: 'The photo could not be taken. Try again.' };
            this._render();
            return;
        }

        const version = this.checkState?.selfieVersion;
        this.checkState = { ...this.checkState, step: 'starting' };
        this._render();

        try {
            const result = await api.identity.submitSelfie(photo, version);

            if (result.status === 'verified') {
                await api.restore();
                this.close(api.user);
                return;
            }

            this.checkState = { ...this.checkState, step: 'rejected', message: declineText(result) };
        } catch (err) {
            // A decline arrives as a 200 and lands above; anything thrown
            // here is the request failing, which is not the viewer's doing
            // and should not be reported as a verdict on their face.
            this.checkState = { ...this.checkState, step: 'error', message: err.message };
        }

        this._render();
    }

    /** Idempotent, and called from every path out of the camera step. */
    _stopCamera() {
        if (!this._stream) return;
        stopSelfieCamera(this._stream, this.el?.querySelector('[data-cam]'));
        this._stream = null;
    }

    _runEnrolment() {
        return this._runCheck({
            start: (version) => api.identity.startEnrolment(version),
            poll: () => api.identity.completeEnrolment(),
            windowName: 'avr-enrolment',
            flow: 'enrol'
        });
    }

    /**
     * Consent, hand off, poll.
     *
     * Every poll is a prompt for the server to go and ask the provider. The
     * page never reports its own verdict, and there is no branch here in which
     * it could. The return page can cut a wait short (`sleepUntilReturn`), but
     * that only changes *when* the question below is asked, never its answer.
     */
    async _runCheck({ start, poll, windowName, flow: flowName }) {
        const agreed = this.el.querySelector('input[name="checkConsent"]');
        if (agreed && !agreed.checked) {
            this.checkState = { ...this.checkState, step: 'error', message: 'You have to agree before the check can start.' };
            this._render();
            return;
        }

        const version = this.checkState.version;
        this.checkState = { step: 'starting', version };
        this._render();

        try {
            const started = await start(version);

            if (started.status === 'verified') {
                await api.restore();
                this.close(api.user);
                return;
            }

            const flow = started.clientUrl ? window.open(started.clientUrl, windowName, 'width=480,height=720') : null;
            this.checkState = { step: 'waiting', version, clientUrl: started.clientUrl, blocked: !flow };
            this._render();

            for (;;) {
                if (!this.el.classList.contains('open')) return;

                await sleepUntilReturn(3000, flowName);

                const result = await poll();
                if (result.status === 'pending') continue;

                flow?.close();

                if (result.status === 'verified') {
                    // The session payload carries the age and verification
                    // blocks, and both just changed. Re-reading them here is
                    // what stops the page behind the dialog still believing
                    // this account has passed nothing.
                    await api.restore();
                    this.close(api.user);
                    return;
                }

                this.checkState = { step: 'rejected', version, message: result.declineReason };
                this._render();
                return;
            }
        } catch (err) {
            this.checkState = { step: 'error', version, message: err.message };
            this._render();
        }
    }

    /* -------------------------------------------------------------- submit -- */

    async _submit() {
        const form = this.el.querySelector('form');
        const errorEl = this.el.querySelector('[data-error]');
        const submit = this.el.querySelector('.auth-submit');
        const data = Object.fromEntries(new FormData(form));

        const label = submit.textContent.trim();
        errorEl.hidden = true;
        submit.disabled = true;
        submit.textContent = this.mode === 'login' ? 'Signing in…' : 'Working…';

        try {
            if (this.mode === 'creator') {
                await this._submitBecomeCreator(data);
                return;
            }

            const registering = this.mode === 'register';
            const creator = registering && this.role === 'creator';

            if (registering && !data.acceptTerms) throw new Error('The terms of use have to be accepted.');
            if (creator && !data.acceptCreatorTerms) throw new Error('The creator agreement has to be accepted.');

            const user = registering
                ? await api.register({
                      email: data.email,
                      password: data.password,
                      displayName: data.displayName,
                      role: creator ? 'creator' : 'viewer',
                      tagline: data.tagline ?? '',
                      bio: data.bio ?? '',
                      // A real boolean, because the server counts nothing else
                      // as consent - an unticked box is absent from FormData.
                      marketingEmails: Boolean(data.marketingEmails),
                      acceptedTerms: this._terms?.terms?.version,
                      acceptedCreatorTerms: creator ? this._terms?.creator?.version : undefined
                  })
                : await api.login({ email: data.email, password: data.password });

            await this._afterAuth(user);
        } catch (err) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
        } finally {
            if (this.el.contains(submit)) {
                submit.disabled = false;
                submit.textContent = label;
            }
        }
    }

    async _submitBecomeCreator(data) {
        if (!data.acceptCreatorTerms) throw new Error('The creator agreement has to be accepted.');

        await api.becomeCreator(this._terms?.creator?.version);
        await this._enterCheckStep('enrol');
    }

    /**
     * Where an account goes next, which depends only on what it still owes.
     *
     * A creator owes an enrolment; passing it establishes their age too, so
     * they are never sent to the age check afterwards. Everyone else owes
     * whatever the server says they owe, which is a document check in the
     * twenty-seven states with a statute and a button everywhere else. An
     * account that owes neither is simply signed in - somebody who verified
     * last year is not asked again on every visit.
     *
     * The branch is on `api.ageOwes` rather than on a flag of our own because
     * only the server knows where the request came from, and the answer
     * changes when the viewer travels.
     */
    async _afterAuth(user) {
        if (api.isCreator && !api.enrolled) {
            await this._enterCheckStep('enrol');
            return;
        }

        const owes = api.ageOwes;
        if (owes) {
            await this._enterCheckStep(owes === 'attestation' ? 'attest' : 'age');
            return;
        }

        this.close(user);
    }
}

/** An agreement, as a heading and the clauses under it. */
function clausesHtml(title, agreement, open = false) {
    const items = (agreement?.clauses ?? []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    return `
        <details class="agreement"${open ? ' open' : ''}>
            <summary>${escapeHtml(title)}</summary>
            <ul>${items}</ul>
        </details>`;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const authModal = new AuthModal();
