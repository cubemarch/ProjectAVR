import { BRAND } from '../../brand.js';
import { api } from '../api/client.js';
import { icons } from './icons.js';
import './auth-modal.css';

/**
 * Sign in, sign up, and the identity step that follows signing up.
 *
 * One dialog rather than a set of pages: the app stays usable while signed
 * out, so authentication is an overlay on what you were already doing rather
 * than a wall in front of it. It is mounted from every page, including the
 * live monitor, which is why it brings its own stylesheet instead of relying
 * on the home page's.
 *
 * Five steps, which are really two questions and three answers:
 *
 *   login         who are you
 *   register      who are you going to be - as a user, or as a creator
 *   creator       the publisher agreement on its own, for Become a creator
 *   age           a document check, for a user: a birthdate and a boolean
 *   enrol         a document *and* a face, for a creator, once, here at signup
 *
 * The split between the last two is the whole design. A user is never asked
 * for a face. A creator is asked for one exactly once at registration, and the
 * enrolment reads their birthdate off the same document, so they are never
 * sent through the age check as well - see `adultConfirmed` on the server.
 * The face check that happens *per broadcast* is a different thing again and
 * does not live here; it belongs to the Go live panel in Studio.
 */
export class AuthModal {
    constructor() {
        this.el = null;
        this.mode = 'login';
        this.role = 'viewer';
        this.reason = '';
        this._resolve = null;
        this._terms = null;
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
            // The role toggle re-renders the form, so anything already typed
            // has to survive it.
            const role = e.target.closest('input[name="signupRole"]');
            if (!role) return;
            this.role = role.value === 'creator' ? 'creator' : 'viewer';
            this._render(this._formValues());
        });

        el.addEventListener('click', (e) => {
            if (e.target.closest('[data-age="start"]')) {
                this._runAgeCheck();
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
                    <div class="brand">A<span>VR</span></div>
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

        const intro = enrolling
            ? `Before you can go on air we need to know who you are. One ID check and a short face
               scan, once — the face is matched by our provider and never stored here.`
            : `${BRAND} is an adult platform. One document check and you are in — it takes about a
               minute and you will not be asked again.`;

        const body = {
            consent: `
                <p class="auth-reason">${intro}</p>
                <div class="consent-text">${escapeHtml(state.text ?? '').replace(/\n\n/g, '</p><p>')}</div>
                <label class="checkbox">
                    <input name="checkConsent" type="checkbox" />
                    <span>${enrolling ? 'I agree to the check described above.' : 'I agree, and I am over 18.'}</span>
                </label>
                <button type="button" class="btn btn-primary auth-submit" data-${kind}="start">Start the check</button>`,

            starting: '<p class="auth-reason">Opening the check…</p>',

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

    /** Switch into an identity step, loading the disclosure it needs. */
    async _enterCheckStep(kind) {
        this.mode = kind;
        this.reason = '';
        this.checkState = { step: 'starting' };
        this._render();

        try {
            const consent = await api.identity.consent();
            this.checkState =
                kind === 'enrol'
                    ? { step: 'consent', text: consent.text, version: consent.version }
                    : { step: 'consent', text: consent.age.text, version: consent.age.version };
        } catch (err) {
            this.checkState = { step: 'error', message: err.message };
        }

        this._render();
    }

    _runAgeCheck() {
        return this._runCheck({
            start: (version) => api.identity.startAge(version),
            poll: () => api.identity.completeAge(),
            windowName: 'avr-age-check'
        });
    }

    _runEnrolment() {
        return this._runCheck({
            start: (version) => api.identity.startEnrolment(version),
            poll: () => api.identity.completeEnrolment(),
            windowName: 'avr-enrolment'
        });
    }

    /**
     * Consent, hand off, poll.
     *
     * Every poll is a prompt for the server to go and ask the provider. The
     * page never reports its own verdict, and there is no branch here in which
     * it could.
     */
    async _runCheck({ start, poll, windowName }) {
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

                await new Promise((r) => setTimeout(r, 3000));

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
     * they are never sent to the age check afterwards. Anyone else owes the
     * age check. An account that owes neither is simply signed in - somebody
     * who verified last year is not asked again on every visit.
     */
    async _afterAuth(user) {
        if (api.isCreator && !api.enrolled) {
            await this._enterCheckStep('enrol');
            return;
        }

        if (!api.ageVerified) {
            await this._enterCheckStep('age');
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
