import { api } from '../api/client.js';
import { icons } from './icons.js';
import { CheckPreview } from '../live/check-preview.js';

/**
 * The profile page, for both roles.
 *
 * A viewer gets a picture, a line about themselves, a credit balance and a way
 * to top it up. A creator gets all of that plus what they charge, whether they
 * are willing to send 3D, and the setup checks that stand between them and
 * going on air.
 *
 * One panel rather than two pages: the halves share a layout, a save button and
 * a set of errors, and the difference between them is one extra section.
 *
 * Prices are in credits per minute and a credit is one US cent, so every number
 * that reaches this file is an integer. `dollars()` is the only place that
 * divides, and nothing multiplies back.
 */

const TIER_LABELS = new Map([
    [1000, '$10'],
    [2500, '$25'],
    [5000, '$50'],
    [10000, '$100']
]);

/** Credits as money, for a label. Never fed back into a request. */
function dollars(credits) {
    return `$${(Math.round(credits ?? 0) / 100).toFixed(2)}`;
}

const REASON_LABELS = {
    purchase: 'Credits purchased',
    watch: 'Watching',
    earn: 'Earned',
    recording_sale: 'Recording sold',
    recording_purchase: 'Recording bought',
    refund: 'Refund',
    adjustment: 'Adjustment'
};

export class ProfilePage {
    /** @param {HTMLElement} mount */
    constructor(mount) {
        this.mount = mount;
        this.visible = false;

        this.data = null;
        this.entries = [];
        this.error = null;
        this.busy = false;

        /**
         * Which check the creator is being walked through, if any.
         *
         * Set when they try to turn 3D on without having confirmed it, which is
         * the "forced" part of forcing the 3D setup: the switch does not quietly
         * fail, the step appears.
         */
        this.runningCheck = null;

        /**
         * The live picture the running check is about.
         *
         * Held across renders rather than rebuilt with the rest of the panel:
         * it owns a WebGL context, two hardware decoders and a socket, and
         * throwing those away because a balance refreshed would restart the
         * broadcast the creator is in the middle of judging.
         *
         * @type {CheckPreview|null}
         */
        this.preview = null;

        /** What to re-apply once the check it was blocked on passes. */
        this.pendingCreatorPatch = null;
    }

    async open() {
        this.visible = true;
        this.mount.hidden = false;
        document.body.classList.add('is-profile');

        this.error = null;
        this._render();
        await this.refresh();
    }

    close() {
        this.visible = false;
        this.mount.hidden = true;
        document.body.classList.remove('is-profile');

        // A balance and a statement are nobody else's business, and this panel
        // is hidden rather than destroyed.
        this.data = null;
        this.entries = [];
        this._endCheck();
        this.mount.innerHTML = '';
    }

    async refresh() {
        try {
            this.data = await api.profile.mine();
            this.entries = await api.credits.ledger().catch(() => []);
            this.error = null;
        } catch (err) {
            this.error = err.message;
        }

        this._render();
    }

    /* ------------------------------------------------------------ rendering -- */

    _render() {
        if (!this.visible) return;

        this.mount.innerHTML = `
            <div class="profile-shell">
                <header class="profile-bar">
                    <button class="btn ghost sm" data-act="back">${icons.chevronLeft({ size: 16 })} Back</button>
                    <h1>Profile</h1>
                </header>

                ${this.error ? `<p class="profile-error">${escapeHtml(this.error)}</p>` : ''}
                ${this.data ? this._bodyHtml() : '<p class="muted">Loading…</p>'}
            </div>
        `;

        // The markup above leaves a placeholder where the live picture goes;
        // the element itself is moved in rather than recreated.
        const slot = this.mount.querySelector('#check-preview-slot');
        if (slot && this.preview) slot.replaceWith(this.preview.el);

        this._bind();
    }

    _bodyHtml() {
        const { profile } = this.data;
        const isCreator = profile.role === 'creator' || profile.role === 'admin';

        return `
            ${this._identityHtml(profile)}
            ${this._creditsHtml()}
            ${isCreator ? this._checksHtml() : ''}
            ${isCreator ? this._pricingHtml() : ''}
        `;
    }

    _identityHtml(profile) {
        const initials = (profile.name ?? '?')
            .split(/\s+/)
            .slice(0, 2)
            .map((p) => p[0]?.toUpperCase() ?? '')
            .join('');

        return `
            <section class="profile-card">
                <div class="profile-identity">
                    <div class="profile-avatar">
                        ${
                            profile.avatarUrl
                                ? `<img src="${escapeAttr(profile.avatarUrl)}" alt="" />`
                                : `<span>${escapeHtml(initials)}</span>`
                        }
                    </div>
                    <div class="profile-who">
                        <h2>${escapeHtml(profile.name ?? 'Unnamed')}</h2>
                        <span class="badge vr">${escapeHtml(profile.role)}</span>
                        <div class="profile-avatar-actions">
                            <input type="file" id="avatar-file" accept="image/jpeg,image/png,image/webp" hidden />
                            <button class="btn sm" data-act="pick-avatar">Change picture</button>
                            ${profile.avatarUrl ? `<button class="btn ghost sm" data-act="clear-avatar">Remove</button>` : ''}
                        </div>
                    </div>
                </div>

                <label class="field">
                    <span>Tagline</span>
                    <input type="text" id="tagline" maxlength="120" value="${escapeAttr(profile.tagline ?? '')}"
                        placeholder="One line under your name" />
                </label>

                <label class="field">
                    <span>About</span>
                    <textarea id="bio" rows="4" maxlength="2000"
                        placeholder="Anything you want people to know">${escapeHtml(profile.bio ?? '')}</textarea>
                </label>

                <button class="btn btn-primary" data-act="save-profile" ${this.busy ? 'disabled' : ''}>Save profile</button>
            </section>
        `;
    }

    _creditsHtml() {
        const { credits } = this.data;
        const tiers = [...TIER_LABELS]
            .map(([cents, label]) => `<button class="btn tier" data-act="buy" data-cents="${cents}">${label}</button>`)
            .join('');

        return `
            <section class="profile-card">
                <h2>Credits</h2>
                <p class="balance">${dollars(credits.balance)}<small>${credits.balance} credits</small></p>
                <p class="muted">
                    Spent ${dollars(credits.spent)} · Bought ${dollars(credits.purchased)}
                    ${credits.earned ? ` · Earned ${dollars(credits.earned)}` : ''}
                </p>

                <div class="tier-row">
                    ${tiers}
                    <span class="tier-other">
                        <input type="number" id="other-amount" min="5" max="500" step="1" placeholder="Other" />
                        <button class="btn" data-act="buy-other">Buy</button>
                    </span>
                </div>

                ${this._statementHtml()}
            </section>
        `;
    }

    _statementHtml() {
        if (!this.entries.length) return '<p class="muted">No credit activity yet.</p>';

        return `
            <table class="statement">
                <tbody>
                    ${this.entries
                        .slice(0, 12)
                        .map(
                            (entry) => `
                        <tr>
                            <td>${escapeHtml(REASON_LABELS[entry.reason] ?? entry.reason)}</td>
                            <td class="${entry.delta < 0 ? 'out' : 'in'}">
                                ${entry.delta < 0 ? '−' : '+'}${dollars(Math.abs(entry.delta))}
                            </td>
                            <td class="muted">${dollars(entry.balanceAfter)}</td>
                        </tr>`
                        )
                        .join('')}
                </tbody>
            </table>
        `;
    }

    _checksHtml() {
        const checks = this.data.streamChecks ?? { standard: false, spatial: false };

        const row = (kind, title, blurb) => {
            const done = checks[kind];
            return `
                <div class="check-row ${done ? 'done' : ''}">
                    <div>
                        <strong>${title}</strong>
                        <p class="muted">${blurb}</p>
                    </div>
                    <button class="btn ${done ? 'ghost' : 'btn-primary'} sm" data-act="check" data-kind="${kind}">
                        ${done ? 'Check again' : 'Run check'}
                    </button>
                </div>
            `;
        };

        return `
            <section class="profile-card">
                <h2>Stream setup</h2>
                <p class="muted">
                    Confirmed once each time you sign in. The 3D check is separate because a stereo pair
                    can be the wrong way round while the picture itself looks perfect.
                </p>

                ${row('standard', 'Standard stream', 'Confirms picture and sound are arriving from your camera.')}
                ${row('spatial', 'Spatial (3D) stream', 'Confirms the left and right eyes are the right way round.')}

                ${this.runningCheck ? this._checkPromptHtml() : ''}
            </section>
        `;
    }

    /**
     * The running check: the creator's own picture, and the button under it.
     *
     * The instruction names what to look at and what would be wrong with it,
     * because "confirm if it looks right" is not a question anybody can answer
     * about a stereo pair without being told what wrong looks like. The button
     * is disabled until frames are on the screen - the preview decides that,
     * and the server applies the same rule to the request, so an enabled button
     * is not the only thing standing between a dead rig and a passed check.
     */
    _checkPromptHtml() {
        const spatial = this.runningCheck === 'spatial';
        const ready = this.preview?.confirmable ?? false;

        return `
            <div class="check-prompt">
                <p>
                    ${
                        spatial
                            ? `Start a broadcast in <strong>Stereo Side-by-Side</strong> from the capture app.
                               Your own stereo pair appears below. Confirm only if the two eyes are the right
                               way round and level with each other &mdash; the layout buttons under the picture
                               are how you tell.`
                            : `Start a broadcast from the capture app. Your own outgoing picture appears below.
                               Confirm only if it is the right camera, the right way up, and sound is arriving.`
                    }
                </p>
                <div id="check-preview-slot"></div>
                <div class="check-actions">
                    <button class="btn btn-primary sm" data-act="confirm-check" ${ready ? '' : 'disabled'}>
                        ${spatial ? 'Yes, the 3D is right' : 'Yes, it looks right'}
                    </button>
                    <button class="btn ghost sm" data-act="cancel-check">Cancel</button>
                    ${
                        ready
                            ? ''
                            : `<span class="muted">Nothing to confirm until a picture is on the screen.</span>`
                    }
                </div>
            </div>
        `;
    }

    _pricingHtml() {
        const c = this.data.creator;

        const price = (key, label) => `
            <label class="field">
                <span>${label}</span>
                <span class="price-input">
                    <input type="number" id="${key}" min="0" max="10000" step="1" value="${Number(c[key] ?? 0)}" />
                    <small>${dollars(c[key] ?? 0)} / min</small>
                </span>
            </label>
        `;

        return `
            <section class="profile-card">
                <h2>Pricing</h2>
                <p class="muted">Credits per minute. A credit is one cent, so 250 is ${dollars(250)} a minute.</p>

                <div class="price-grid">
                    ${price('public2dPerMin', 'Public · 2D')}
                    ${price('public3dPerMin', 'Public · 3D')}
                    ${price('private2dPerMin', 'Private 1:1 · 2D')}
                    ${price('private3dPerMin', 'Private 1:1 · 3D')}
                </div>

                <label class="check">
                    <input type="checkbox" id="public3dEnabled" ${c.public3dEnabled ? 'checked' : ''} />
                    Offer 3D on public streams
                </label>
                <label class="check">
                    <input type="checkbox" id="private3dEnabled" ${c.private3dEnabled ? 'checked' : ''} />
                    Offer 3D in private 1:1 streams
                </label>

                <label class="field">
                    <span>When a viewer wants to record a 1:1</span>
                    <select id="recordingPolicy">
                        <option value="ask" ${c.recordingPolicy === 'ask' ? 'selected' : ''}>Ask me each time</option>
                        <option value="always" ${c.recordingPolicy === 'always' ? 'selected' : ''}>Always allow</option>
                        <option value="never" ${c.recordingPolicy === 'never' ? 'selected' : ''}>Never allow</option>
                    </select>
                </label>

                <button class="btn btn-primary" data-act="save-creator" ${this.busy ? 'disabled' : ''}>Save pricing</button>
            </section>
        `;
    }

    /* --------------------------------------------------------------- events -- */

    _bind() {
        this.mount.onclick = async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn || this.busy) return;

            try {
                switch (btn.dataset.act) {
                    case 'back':
                        window.dispatchEvent(new CustomEvent('avr:exit-profile'));
                        break;
                    case 'pick-avatar':
                        this.mount.querySelector('#avatar-file')?.click();
                        break;
                    case 'clear-avatar':
                        await this._run(() => api.profile.clearAvatar());
                        break;
                    case 'save-profile':
                        await this._saveProfile();
                        break;
                    case 'buy':
                        await this._buy(Number(btn.dataset.cents));
                        break;
                    case 'buy-other':
                        await this._buyOther();
                        break;
                    case 'check':
                        this._startCheck(btn.dataset.kind);
                        break;
                    case 'confirm-check':
                        await this._confirmCheck();
                        break;
                    case 'cancel-check':
                        this._endCheck();
                        this._render();
                        break;
                    case 'save-creator':
                        await this._saveCreator(this._creatorPatch());
                        break;
                }
            } catch (err) {
                this.error = err.message;
                this._render();
            }
        };

        const file = this.mount.querySelector('#avatar-file');
        if (file) {
            file.onchange = async () => {
                const chosen = file.files?.[0];
                if (!chosen) return;
                await this._run(() => api.profile.setAvatar(chosen));
            };
        }
    }

    /* ---------------------------------------------------------- the checks -- */

    /**
     * Put a check in front of the creator, with the picture it is about.
     *
     * @param {'standard'|'spatial'} kind
     */
    _startCheck(kind) {
        this._endCheck();

        this.runningCheck = kind;
        this.preview = new CheckPreview({ kind });

        // The only thing the page needs back from the preview: whether there
        // is now something worth confirming. Re-rendering the whole panel is
        // safe because the preview element is moved across rather than rebuilt.
        this.preview.addEventListener('confirmable', () => this._render());

        this._render();
        this.preview.start();
    }

    /** Take the check down, releasing the decoders and the socket with it. */
    _endCheck() {
        this.preview?.stop();
        this.preview = null;
        this.runningCheck = null;
        this.pendingCreatorPatch = null;
    }

    /** Run something that changes the server, then re-read everything. */
    async _run(work) {
        this.busy = true;
        this._render();

        try {
            await work();
            this.error = null;
        } catch (err) {
            this.error = err.message;
        } finally {
            this.busy = false;
        }

        await this.refresh();
    }

    async _saveProfile() {
        const tagline = this.mount.querySelector('#tagline')?.value ?? '';
        const bio = this.mount.querySelector('#bio')?.value ?? '';
        await this._run(() => api.profile.save({ tagline, bio }));
    }

    async _buy(amountCents) {
        await this._run(() => api.credits.buy(amountCents));
    }

    async _buyOther() {
        const input = this.mount.querySelector('#other-amount');
        const dollarsAsked = Number(input?.value);

        if (!Number.isFinite(dollarsAsked) || dollarsAsked <= 0) {
            this.error = 'Enter an amount in dollars.';
            this._render();
            return;
        }

        // The field is in dollars because that is what the tier buttons say;
        // everything past this line is credits.
        await this._buy(Math.round(dollarsAsked * 100));
    }

    _creatorPatch() {
        const num = (id) => Number(this.mount.querySelector(`#${id}`)?.value ?? 0);
        const on = (id) => !!this.mount.querySelector(`#${id}`)?.checked;

        return {
            public2dPerMin: num('public2dPerMin'),
            public3dPerMin: num('public3dPerMin'),
            private2dPerMin: num('private2dPerMin'),
            private3dPerMin: num('private3dPerMin'),
            public3dEnabled: on('public3dEnabled'),
            private3dEnabled: on('private3dEnabled'),
            recordingPolicy: this.mount.querySelector('#recordingPolicy')?.value ?? 'ask'
        };
    }

    /**
     * Save pricing, and turn the server's refusal into the step that fixes it.
     *
     * A 409 here means they asked for 3D without having confirmed it. Rather
     * than reporting that back as an error, the 3D check appears and the patch
     * is held so it can be re-applied the moment the check passes - which is
     * what "they are forced to perform 3D setup" should feel like.
     */
    async _saveCreator(patch) {
        this.busy = true;
        this._render();

        try {
            await api.profile.saveCreator(patch);
            this.error = null;
            this._endCheck();
        } catch (err) {
            if (err.status === 409 && err.details?.code === 'spatial_check_required') {
                this._startCheck('spatial');
                // After `_startCheck`, which clears anything the last one held.
                this.pendingCreatorPatch = patch;
                this.error = 'Confirm your 3D stream before offering it.';
            } else {
                this.error = err.message;
            }
        } finally {
            this.busy = false;
        }

        await this.refresh();
    }

    async _confirmCheck() {
        const kind = this.runningCheck;
        if (!kind) return;

        // Whatever they were trying to turn on when the check stopped them.
        // Read before the check is taken down, because taking it down is what
        // forgets it.
        const pending = this.pendingCreatorPatch;

        this.busy = true;
        this._render();

        try {
            await api.checks.pass(kind);
            this.error = null;
            this._endCheck();
        } catch (err) {
            // A 409 means the broadcast went away between the picture
            // appearing and the button being pressed, so the check stays up
            // rather than disappearing with the reason it failed.
            this.error = err.message;
        } finally {
            this.busy = false;
        }

        if (pending && !this.error) await this._saveCreator(pending);
        else await this.refresh();
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

const escapeAttr = escapeHtml;
