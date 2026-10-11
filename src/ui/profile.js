import { api } from '../api/client.js';
import { icons } from './icons.js';
import { dollars } from './money.js';
import { CheckPreview } from '../live/check-preview.js';
import { isCreator } from '../auth/roles.js';

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
 * The sections are tabs rather than one long scroll, because a creator who
 * arrives here from Studio's "Run the checks" wants exactly one of them and
 * should not have to find it past a credit statement.
 *
 * Prices are in credits per minute and a credit is one US cent, so every number
 * that reaches this file is an integer. `dollars()` in `./money.js` is the only
 * place that divides, and nothing multiplies back.
 */

const TIER_LABELS = new Map([
    [1000, '$10'],
    [2500, '$25'],
    [5000, '$50'],
    [10000, '$100']
]);

/**
 * The tabs, in the order a new account meets them.
 *
 * `going-live` is one section and not two because the checks and the prices
 * answer the same question — whether this creator can be paid to go on air —
 * and a price set on a rig that has never passed a check earns nothing.
 */
const SECTIONS = [
    { id: 'you', label: 'You' },
    { id: 'credits', label: 'Credits' },
    { id: 'going-live', label: 'Going live', creatorOnly: true },
    { id: 'recordings', label: 'Recordings' },
    { id: 'operator', label: 'Operator', superuserOnly: true }
];

/** How long to wait after the last keystroke before asking whether a name is free. */
const NAME_CHECK_DELAY_MS = 350;

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

        /** Which tab is showing. @type {'you'|'credits'|'going-live'|'recordings'} */
        this.section = 'you';

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

        /* ------------------------------------------------------- the link -- */

        /** What `/api/profile/names` last said: the names, the limit, the rules. */
        this.names = null;

        /**
         * What is in the name field right now.
         *
         * Held outside the DOM because every render rebuilds the panel, and a
         * half-typed name disappearing because a balance refreshed in the
         * background is the kind of bug nobody can reproduce on purpose.
         */
        this.nameDraft = null;

        /** The answer to "is this one free", or `{pending: true}` while asking. */
        this.nameCheck = null;
        this.nameNotice = null;
        this.nameError = null;
        this.nameTimer = null;

        /** The runtime reserved list, for the operator tab. */
        this.reserved = null;
        this.reservedError = null;
    }

    /**
     * @param {'you'|'credits'|'going-live'|'recordings'} [section]
     *   Where to land. Studio sends creators straight to `going-live`; anything
     *   the account has no business seeing falls back to `you` at render.
     */
    async open(section) {
        this.visible = true;
        this.mount.hidden = false;
        document.body.classList.add('is-profile');

        if (section) this.section = section;

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
            // Both sides of the marketplace, and neither is fatal: a profile
            // that cannot reach them is still a profile.
            this.recordings = api.isCreator ? await api.recordings.mine().catch(() => []) : [];
            this.purchased = await api.recordings.purchased().catch(() => []);
            await this._loadNames();
            this.error = null;
        } catch (err) {
            this.error = err.message;
        }

        this._render();

        // After the render, because the tab it fills only exists once the role
        // is known. Guarded on both so a failure stays failed: `_loadReserved`
        // renders, and re-fetching on every render that reported an error
        // would be a loop.
        if (this.section === 'operator' && this.reserved === null && !this.reservedError) {
            await this._loadReserved();
        }
    }

    /* ------------------------------------------------------------ rendering -- */

    _render() {
        if (!this.visible) return;

        const isCreator = this._isCreator();
        const isOperator = this._isOperator();
        const tabs = SECTIONS.filter(
            (s) => (!s.creatorOnly || isCreator) && (!s.superuserOnly || isOperator)
        );

        // Only once the role is known. The first paint happens before the
        // profile has been read, and dropping `going-live` on that paint would
        // throw away where Studio just sent them.
        if (this.data && !tabs.some((s) => s.id === this.section)) this.section = 'you';

        this.mount.innerHTML = `
            <div class="profile-shell">
                <!-- Title and tabs stick together, as one block: two sticky
                     elements at guessed offsets is how you get a tab row
                     floating over the heading it belongs to. -->
                <div class="profile-head">
                    <header class="profile-bar">
                        <button class="btn ghost sm" data-act="back">${icons.chevronLeft({ size: 16 })} Back</button>
                        <h1>${isCreator ? 'Creator account' : 'Your account'}</h1>
                        ${isCreator ? '<button class="btn btn-secondary sm" data-act="studio">Creator Studio</button>' : ''}
                    </header>

                    ${
                        this.data
                            ? `<nav class="profile-tabs" role="tablist">
                                ${tabs
                                    .map(
                                        (s) => `
                                    <button class="profile-tab ${s.id === this.section ? 'on' : ''}" role="tab"
                                        aria-selected="${s.id === this.section}"
                                        data-act="section" data-section="${s.id}">${s.label}</button>`
                                    )
                                    .join('')}
                               </nav>`
                            : ''
                    }
                </div>

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

    /** @returns {boolean} */
    _isCreator() {
        return isCreator(this.data?.profile?.role);
    }

    /**
     * Exactly superuser, not "admin or better".
     *
     * The tab and the server guard behind it read the same field, and the
     * guard is `requireRole('superuser')` - a tab that appeared for admins
     * would be a tab full of 403s.
     */
    _isOperator() {
        return this.data?.profile?.role === 'superuser';
    }

    _bodyHtml() {
        switch (this.section) {
            case 'credits':
                return this._creditsHtml();

            case 'going-live':
                return `${this._checksHtml()}${this._pricingHtml()}`;

            case 'recordings':
                return `${this._isCreator() ? this._myRecordingsHtml() : ''}${this._purchasedHtml()}`;

            case 'operator':
                return this._operatorHtml();

            default:
                return `${this._identityHtml(this.data.profile)}${this._namesHtml()}${this._emailsHtml()}`;
        }
    }

    /* ---------------------------------------------------------- your link -- */

    /**
     * The one address that does not change.
     *
     * Everything else that points at a broadcast is minted per broadcast: the
     * session id names a socket, and the destination the capture app scans is
     * a grant that is spent the moment it connects. This is the only thing a
     * creator can put on a card, and the card outlives any one stream.
     *
     * Renaming keeps the old name working - that is what `renameChannel` does
     * on the server - so the copy says so. Somebody deciding whether to change
     * a link they have already given out needs to know that before they press
     * the button, not after.
     */
    _namesHtml() {
        if (!this.names) {
            return `
                <section class="profile-card">
                    <h2>Your link</h2>
                    <p class="muted">${this.nameError ? escapeHtml(this.nameError) : 'Loading…'}</p>
                </section>`;
        }

        const { names, primary, canAddMore, limit, suggestion } = this.names;
        const draft = this.nameDraft ?? primary ?? suggestion ?? '';
        const extras = names.filter((n) => !n.isPrimary);
        const several = limit === null || limit > 1;

        return `
            <section class="profile-card">
                <h2>Your link</h2>

                ${
                    primary
                        ? `<div class="link-row">
                               <input class="channel-url" type="text" readonly
                                   value="${escapeAttr(this._channelUrl(primary))}" />
                               <button class="btn sm" data-act="copy-link"
                                   data-value="${escapeAttr(this._channelUrl(primary))}">Copy</button>
                           </div>
                           <p class="muted">
                               Share this one address. It opens your page when you are off air and
                               your broadcast when you are on, and it does not change between them.
                           </p>`
                        : `<p class="muted">
                               You do not have a link yet. Pick a name and it becomes your address
                               on this site.
                           </p>`
                }

                <label class="field">
                    <span>${primary ? 'Change your name' : 'Choose your name'}</span>
                    <div class="link-row">
                        <span class="link-prefix">${escapeHtml(this._channelUrl(''))}</span>
                        <input type="text" id="channel-name" maxlength="30" autocomplete="off"
                            spellcheck="false" value="${escapeAttr(draft)}" placeholder="your-name" />
                    </div>
                </label>

                <p class="muted" id="channel-status">${this._nameStatusHtml()}</p>

                <div class="row-actions">
                    <button class="btn btn-primary" data-act="save-name" ${this.busy ? 'disabled' : ''}>
                        ${primary ? 'Save link' : 'Claim link'}
                    </button>
                    ${
                        primary && canAddMore
                            ? `<button class="btn sm" data-act="add-name" ${this.busy ? 'disabled' : ''}>
                                   Add another name
                               </button>`
                            : ''
                    }
                </div>

                ${
                    primary
                        ? `<p class="muted small">
                               Changing it keeps the old name working, so links already out there
                               do not break.
                           </p>`
                        : ''
                }

                ${
                    extras.length
                        ? `<h3>Also yours</h3>
                           <p class="muted small">
                               These point at the same channel and redirect to
                               <strong>/${escapeHtml(primary ?? '')}</strong>.
                           </p>
                           <ul class="name-list">
                               ${extras
                                   .map(
                                       (n) => `
                                   <li>
                                       <code>/${escapeHtml(n.slug)}</code>
                                       <span>
                                           <button class="btn ghost sm" data-act="make-primary"
                                               data-slug="${escapeAttr(n.slug)}">Make main</button>
                                           <button class="btn ghost sm" data-act="drop-name"
                                               data-slug="${escapeAttr(n.slug)}">Release</button>
                                       </span>
                                   </li>`
                                   )
                                   .join('')}
                           </ul>`
                        : ''
                }

                ${
                    several
                        ? `<p class="muted small">
                               This account may hold ${limit === null ? 'any number of' : limit} names.
                           </p>`
                        : ''
                }

                ${this.nameNotice ? `<p class="ok">${escapeHtml(this.nameNotice)}</p>` : ''}
                ${this.nameError ? `<p class="error">${escapeHtml(this.nameError)}</p>` : ''}
            </section>
        `;
    }

    /** The status line under the name field, rebuilt without a full render. */
    _nameStatusHtml() {
        const check = this.nameCheck;
        if (!check) return 'Lowercase letters, numbers and hyphens.';

        if (check.pending) return 'Checking…';
        if (check.mine) return 'That one is already yours.';
        if (check.available) return `<span class="ok">/${escapeHtml(check.slug)} is free.</span>`;

        return `<span class="error">${escapeHtml(check.error ?? 'That name is taken.')}</span>`;
    }

    /** `https://host/name`, which is what gets pasted somewhere. */
    _channelUrl(slug) {
        return `${window.location.origin}/${slug}`;
    }

    /**
     * The operator console: the words nobody may take.
     *
     * Only the runtime list is editable here. The built-in list in
     * `server/channels/slug.js` is code - a route name or an impersonation risk
     * that a deploy decided on - and a console that could delete `api` from it
     * would be a console that could take the site down from a text field.
     */
    _operatorHtml() {
        return `
            <section class="profile-card">
                <h2>Reserved names</h2>
                <p class="muted">
                    Names no ordinary account may claim. The built-in list — routes, mailboxes,
                    words that read as staff — is part of the code and is not shown here. This is
                    what has been added since.
                </p>

                <label class="field">
                    <span>Reserve a name</span>
                    <input type="text" id="reserve-slug" maxlength="30" autocomplete="off"
                        spellcheck="false" placeholder="a-name" />
                </label>

                <label class="field">
                    <span>Why</span>
                    <input type="text" id="reserve-reason" maxlength="200"
                        placeholder="Held for the launch partner" />
                </label>

                <button class="btn btn-primary" data-act="reserve" ${this.busy ? 'disabled' : ''}>
                    Reserve it
                </button>

                ${
                    this.reserved === null
                        ? `<p class="muted">${this.reservedError ? escapeHtml(this.reservedError) : 'Loading…'}</p>`
                        : this.reserved.length
                          ? `<ul class="name-list">
                                 ${this.reserved
                                     .map(
                                         (r) => `
                                     <li>
                                         <code>/${escapeHtml(r.slug)}</code>
                                         <span class="muted small">${escapeHtml(r.reason ?? '')}</span>
                                         <button class="btn ghost sm" data-act="unreserve"
                                             data-slug="${escapeAttr(r.slug)}">Release</button>
                                     </li>`
                                     )
                                     .join('')}
                             </ul>`
                          : '<p class="muted">Nothing reserved beyond the built-in list.</p>'
                }

                ${this.reservedError && this.reserved !== null ? `<p class="error">${escapeHtml(this.reservedError)}</p>` : ''}
            </section>
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

    /**
     * Email settings.
     *
     * One switch, and a plain statement of what it does not cover. The second
     * part matters as much as the first: somebody turning marketing off has
     * usually decided they get too much email, and if they believe this also
     * silenced their receipts and security notices they will reach for the
     * spam button instead - which is worse for them and for us. The server
     * enforces the same split; see `server/mail/templates.js`.
     */
    _emailsHtml() {
        const on = this.data?.emails?.marketing === true;

        return `
            <section class="profile-card">
                <h2>Email</h2>

                <label class="check">
                    <input type="checkbox" id="marketing-emails" ${on ? 'checked' : ''} />
                    Email me news and offers
                </label>

                <p class="muted">
                    Off by default. Receipts, security notices and the results of identity checks
                    are sent either way — they are part of your account, not marketing.
                </p>

                <button class="btn btn-primary" data-act="save-emails" ${this.busy ? 'disabled' : ''}>
                    Save email settings
                </button>
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

                ${
                    // The two titles are the capture app's own Mode names, not
                    // descriptions of them. A creator running this check has the
                    // phone in the other hand, and "Spatial" — which is what
                    // this row used to say — is not a control the app has.
                    row(
                        'standard',
                        'Standard stream (2D)',
                        'Broadcast in <strong>Standard</strong>. Confirms picture and sound are arriving from your camera.'
                    )
                }
                ${row(
                    'spatial',
                    'Stereo Side-by-Side stream (3D)',
                    'Broadcast in <strong>Stereo Side-by-Side</strong>. Confirms the left and right eyes are the right way round.'
                )}

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
                            : `Start a broadcast in <strong>Standard</strong> from the capture app. Your own
                               outgoing picture appears below. Confirm only if it is the right camera, the
                               right way up, and sound is arriving.`
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

    /**
     * The creator's own recordings, and what they can do with each.
     *
     * Only the creator's recordings appear here, because only they exist on
     * this server: the viewer's recording of the same conversation was written
     * to the viewer's own disk and there is no route that would have accepted
     * it. That is also why these can be sold at all - the customer's voice is
     * not in them.
     *
     * The 2D/3D tag is shown and not offered. It was decided by what the
     * session was carrying when the file was finalised, so a broadcast whose
     * second eye dropped out is listed as 2D whatever it was set to, and a
     * buyer on a headset gets the format the tag promised.
     */
    _myRecordingsHtml() {
        const recordings = this.recordings ?? [];

        if (!recordings.length) {
            return `
                <section class="profile-card">
                    <h2>Your recordings</h2>
                    <p class="muted">
                        Nothing recorded yet. In a 1:1 you can record your own camera and voice - the
                        viewer's voice is never in it - and put the result up for sale here.
                    </p>
                </section>`;
        }

        return `
            <section class="profile-card">
                <h2>Your recordings</h2>
                <p class="muted">
                    Each one holds your camera and your voice only. Set the price when you list it;
                    taking a listing down does not take it back from anyone who already bought it.
                </p>
                ${recordings.map((row) => this._recordingRowHtml(row)).join('')}
            </section>`;
    }

    _recordingRowHtml(row) {
        const id = escapeHtml(row.id);
        const minutes = Math.max(1, Math.round((row.durationMs ?? 0) / 60000));
        const tag = `<span class="badge ${row.tag === '3d' ? 'stereo' : 'vr'}">${row.tag.toUpperCase()}</span>`;

        if (row.status !== 'ready') {
            return `
                <div class="recording-line">
                    <div>
                        <strong>${row.status === 'recording' ? 'Recording now' : 'Recording failed'}</strong>
                        <p class="muted">${escapeHtml(row.failureReason ?? 'Started ' + new Date(row.createdAt).toLocaleString())}</p>
                    </div>
                    ${tag}
                </div>`;
        }

        const heading = `
            <div>
                <strong>${escapeHtml(row.title ?? `Recording of ${new Date(row.createdAt).toLocaleDateString()}`)}</strong>
                <p class="muted">
                    ${minutes} min · ${formatBytes(row.sizeBytes)}
                    ${row.sales ? ` · sold ${row.sales} time${row.sales === 1 ? '' : 's'}` : ''}
                </p>
            </div>
            ${tag}`;

        if (row.listed) {
            return `
                <div class="recording-line listed">
                    ${heading}
                    <span class="price">${dollars(row.price)}</span>
                    <a class="btn ghost sm" href="${escapeHtml(api.recordings.fileUrl(row.id))}" target="_blank" rel="noopener">Watch</a>
                    <button class="btn ghost sm" data-act="unlist-recording" data-id="${id}">Take down</button>
                </div>`;
        }

        return `
            <div class="recording-line">
                ${heading}
                <input type="text" id="rec-title-${id}" maxlength="120" placeholder="Title for the marketplace"
                    value="${escapeHtml(row.title ?? '')}" />
                <span class="price-input">
                    <input type="number" id="rec-price-${id}" min="1" max="100000" step="1"
                        value="${Number(row.price ?? 500)}" />
                    <small>credits</small>
                </span>
                <a class="btn ghost sm" href="${escapeHtml(api.recordings.fileUrl(row.id))}" target="_blank" rel="noopener">Watch</a>
                <button class="btn btn-primary sm" data-act="list-recording" data-id="${id}">Put on sale</button>
            </div>`;
    }

    /** What this account has bought. Kept for both roles: a creator can buy too. */
    _purchasedHtml() {
        const purchased = this.purchased ?? [];

        if (!purchased.length) {
            return `
                <section class="profile-card">
                    <h2>Recordings you own</h2>
                    <p class="muted">
                        Nothing bought yet. Recordings creators have put up for sale appear on the
                        home page, and what you buy stays here to watch again.
                    </p>
                </section>`;
        }

        return `
            <section class="profile-card">
                <h2>Recordings you own</h2>
                ${purchased
                    .map(
                        (row) => `
                    <div class="recording-line">
                        <div>
                            <strong>${escapeHtml(row.title ?? 'Untitled')}</strong>
                            <p class="muted">${escapeHtml(row.creatorName ?? 'Creator')} · paid ${dollars(row.paid)}</p>
                        </div>
                        <span class="badge ${row.tag === '3d' ? 'stereo' : 'vr'}">${row.tag.toUpperCase()}</span>
                        <a class="btn ghost sm" href="${escapeHtml(api.recordings.fileUrl(row.id))}" target="_blank" rel="noopener">Watch</a>
                    </div>`
                    )
                    .join('')}
            </section>`;
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
                    case 'studio':
                        window.dispatchEvent(new CustomEvent('avr:open-studio'));
                        break;
                    case 'section':
                        // A check running under one tab has a socket and two
                        // decoders open; leaving the tab ends it rather than
                        // leaving it running behind a credit statement.
                        if (this.runningCheck) this._endCheck();
                        this.section = btn.dataset.section;
                        this._render();
                        if (this.section === 'operator') await this._loadReserved();
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
                    case 'save-emails':
                        await this._saveEmails();
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
                    case 'list-recording':
                        await this._listRecording(btn.dataset.id);
                        break;
                    case 'unlist-recording':
                        await this._run(() => api.recordings.unlist(btn.dataset.id));
                        break;
                    case 'copy-link':
                        await copyToClipboard(btn, this.mount);
                        break;
                    case 'save-name':
                        await this._saveName();
                        break;
                    case 'add-name':
                        await this._saveName({ additional: true });
                        break;
                    case 'make-primary':
                        await this._nameAction(() => api.channels.rename(btn.dataset.slug));
                        break;
                    case 'drop-name':
                        await this._nameAction(() => api.channels.release(btn.dataset.slug));
                        break;
                    case 'reserve':
                        await this._reserve();
                        break;
                    case 'unreserve':
                        await this._unreserve(btn.dataset.slug);
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

        // Debounced rather than per-keystroke: the endpoint is rate-limited,
        // and "is `d` free" is not a question anybody wanted answered on the
        // way to typing `dana`.
        const name = this.mount.querySelector('#channel-name');
        if (name) {
            name.oninput = () => {
                this.nameDraft = name.value;
                this.nameNotice = null;
                clearTimeout(this.nameTimer);
                this.nameTimer = setTimeout(() => this._checkName(), NAME_CHECK_DELAY_MS);
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

    /**
     * Put one recording on sale.
     *
     * The title and the price are read off the row being listed rather than
     * from a shared form, so two recordings on screen at once cannot be listed
     * with each other's numbers. The server validates both again and its
     * complaint is what gets shown - there is one set of rules for this and it
     * is not in the browser.
     */
    async _listRecording(id) {
        const title = this.mount.querySelector(`#rec-title-${CSS.escape(id)}`)?.value ?? '';
        const price = Number(this.mount.querySelector(`#rec-price-${CSS.escape(id)}`)?.value);

        await this._run(async () => {
            try {
                await api.recordings.list(id, { title: title.trim(), price });
            } catch (err) {
                // The listing route answers with `errors: [...]` for a bad
                // title or price, which is more use than "Request failed".
                const details = err.details?.errors;
                throw details?.length ? new Error(details.join('. ')) : err;
            }
        });
    }

    async _saveProfile() {
        const tagline = this.mount.querySelector('#tagline')?.value ?? '';
        const bio = this.mount.querySelector('#bio')?.value ?? '';
        await this._run(() => api.profile.save({ tagline, bio }));
    }

    /**
     * Saved on its own, not folded into "Save profile".
     *
     * Consent to be marketed at is the one setting on this page where somebody
     * has to be able to say what they changed. A tagline edit that silently
     * carried an opt-in along with it would be exactly the pre-ticked box this
     * checkbox exists to avoid.
     */
    async _saveEmails() {
        const marketingEmails = this.mount.querySelector('#marketing-emails')?.checked === true;
        await this._run(() => api.profile.save({ marketingEmails }));
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

    /* ---------------------------------------------------------- your link -- */

    /**
     * Read the name list.
     *
     * Its failure is kept apart from `this.error` on purpose: a profile whose
     * name list failed to load is still a profile, and the card says so where
     * the card is rather than replacing the page with an error.
     */
    async _loadNames() {
        try {
            this.names = await api.channels.mine();
            this.nameError = null;
        } catch (err) {
            this.nameError = err.message;
        }
    }

    /** Ask whether what is in the field right now is free, and say so in place. */
    async _checkName() {
        const typed = (this.nameDraft ?? '').trim();
        const line = this.mount.querySelector('#channel-status');

        // Unchanged from what they already hold: nothing to ask, and asking
        // would answer "that one is already yours" at every keystroke of a
        // name they are only half way through editing.
        if (!typed || typed === this.names?.primary) {
            this.nameCheck = null;
            if (line) line.innerHTML = this._nameStatusHtml();
            return;
        }

        this.nameCheck = { pending: true };
        if (line) line.innerHTML = this._nameStatusHtml();

        try {
            const answer = await api.channels.check(typed);

            // The field moved on while the answer was in flight.
            if ((this.nameDraft ?? '').trim() !== typed) return;

            this.nameCheck = answer;
        } catch (err) {
            this.nameCheck = { available: false, error: err.message };
        }

        const current = this.mount.querySelector('#channel-status');
        if (current) current.innerHTML = this._nameStatusHtml();
    }

    /**
     * Claim the name in the field, or move the channel onto it.
     *
     * @param {{additional?: boolean}} [opts] - `additional` adds a name beside
     *   the existing one instead of replacing it, which only an account with a
     *   limit above one can do.
     */
    async _saveName({ additional = false } = {}) {
        const typed = (this.mount.querySelector('#channel-name')?.value ?? '').trim();

        if (!typed) {
            this.nameError = 'Pick a channel name.';
            this._render();
            return;
        }

        if (!additional && typed === this.names?.primary) {
            this.nameNotice = 'That is already your link.';
            this._render();
            return;
        }

        const primary = this.names?.primary;

        await this._nameAction(() =>
            additional || !primary ? api.channels.claim(typed, !primary) : api.channels.rename(typed)
        );
    }

    /**
     * Run something that changes the name list, then re-read everything.
     *
     * Separate from `_run` because the errors belong beside the field rather
     * than at the top of the page, and because a successful one has to forget
     * the draft - otherwise the field keeps showing what was typed instead of
     * what was saved.
     */
    async _nameAction(work) {
        this.busy = true;
        this.nameError = null;
        this.nameNotice = null;
        this._render();

        try {
            await work();
            this.nameDraft = null;
            this.nameCheck = null;
            this.nameNotice = 'Saved.';
        } catch (err) {
            this.nameError = err.message;
        } finally {
            this.busy = false;
        }

        await this.refresh();
    }

    /* ------------------------------------------------------------ operator -- */

    async _loadReserved() {
        try {
            this.reserved = await api.reserved.list();
            this.reservedError = null;
        } catch (err) {
            this.reservedError = err.message;
        }

        this._render();
    }

    async _reserve() {
        const slug = (this.mount.querySelector('#reserve-slug')?.value ?? '').trim();
        const reason = (this.mount.querySelector('#reserve-reason')?.value ?? '').trim();

        if (!slug) {
            this.reservedError = 'Type the name to reserve.';
            this._render();
            return;
        }

        await this._reservedAction(() => api.reserved.add(slug, reason));
    }

    async _unreserve(slug) {
        await this._reservedAction(() => api.reserved.remove(slug));
    }

    async _reservedAction(work) {
        this.busy = true;
        this.reservedError = null;
        this._render();

        try {
            await work();
        } catch (err) {
            this.reservedError = err.message;
        } finally {
            this.busy = false;
        }

        await this._loadReserved();
    }
}

/**
 * Copy, with a fallback.
 *
 * The async clipboard API needs a secure context, and this site is reachable
 * over plain HTTP on a LAN - so the field stays selectable and the button says
 * "press Ctrl-C" rather than failing silently. Same shape as the one in
 * Studio; see `src/ui/creator/portal.js`.
 */
async function copyToClipboard(btn, root) {
    const original = btn.textContent;

    try {
        await navigator.clipboard.writeText(btn.dataset.value);
        btn.textContent = 'Copied';
    } catch {
        root.querySelector('.channel-url')?.select();
        btn.textContent = 'Press Ctrl-C';
    }

    setTimeout(() => {
        btn.textContent = original;
    }, 2000);
}

function escapeHtml(value) {
    return String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

const escapeAttr = escapeHtml;

/** A file size a person can judge a download by. */
function formatBytes(bytes) {
    const mb = (bytes ?? 0) / 1_000_000;
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}
