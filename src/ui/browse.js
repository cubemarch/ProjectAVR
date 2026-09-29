import * as pc from 'playcanvas';
import { brandLockup } from './brand-mark.js';
import { icons } from './icons.js';
import { formatDuration, pickHero, searchCatalog } from '../catalog/catalog.js';
import {
    PROJECTION,
    PROJECTION_DETAIL,
    STEREO,
    STEREO_DETAIL,
    depthTag,
    formatSummary
} from '../catalog/media-format.js';
import { dollars, perMinute } from './money.js';
import { api } from '../api/client.js';

/**
 * The browse experience: billboard, shelves, detail modal and search.
 *
 * Emits:
 *   'play'    (item, { immersive })  - start playback
 *   'enterVr' (item)                 - start playback and request an XR session
 */
export class BrowseUI extends pc.EventHandler {
    /**
     * @param {HTMLElement} mount
     * @param {{items: object[], rows: object[]}} catalog
     * @param {{xrSupported: boolean}} caps
     */
    constructor(mount, catalog, caps) {
        super();

        this.mount = mount;
        this.catalog = catalog;
        this.caps = caps;
        this.myList = new Set(loadMyList());
        this.progress = loadProgress();

        this._render();
        this._bindScroll();
    }

    _render() {
        this.hero = pickHero(this.catalog.items);

        this.mount.innerHTML = `
            ${this._headerHtml()}
            <main id="browse-main">
                <div id="billboard-slot"></div>
                <section class="shelf live-creators" id="live-creators" hidden>
                    <div class="shelf-head">
                        <h2>Live Creators</h2>
                    </div>
                    <div class="creator-row" id="creator-row"></div>
                </section>
                <section class="shelf recordings-shelf" id="recordings-shelf" hidden>
                    <div class="shelf-head">
                        <h2>Recorded 1:1s</h2>
                        <div class="tag-filter" id="recording-tags">
                            <button data-tag="" class="active">All</button>
                            <button data-tag="2d">2D</button>
                            <button data-tag="3d">3D</button>
                        </div>
                    </div>
                    <div class="recording-row" id="recording-row"></div>
                </section>
                <div class="shelves" id="shelves"></div>
            </main>
            ${this._modalHtml()}
        `;

        this.header = this.mount.querySelector('.site-header');
        this.shelvesEl = this.mount.querySelector('#shelves');
        this.modalEl = this.mount.querySelector('#detail-modal');
        this.creatorsEl = this.mount.querySelector('#live-creators');
        this.recordingsEl = this.mount.querySelector('#recordings-shelf');
        this.billboardEl = this.mount.querySelector('#billboard-slot');

        this._renderBillboard();
        this._renderShelves(this.catalog.rows);
        this._renderCreators();
        this._renderRecordings();
        this._bindHeader();
        this._bindBillboard();
        this._bindModal();
        this._bindCreators();
        this._bindRecordings();
        this._bindShelves();
    }

    /* ------------------------------------------------------- the market -- */

    /**
     * What creators have put up for sale.
     *
     * Every one of these is a recording of a private turn made on the server
     * from the creator's own camera feed, so the person buying it is not in it.
     * The 2D/3D tag comes off the file rather than off a form: it says what was
     * actually captured, which is the only version of that promise worth making
     * to somebody about to spend credits on a headset.
     *
     * Behind the same door as the rest of the catalogue - the listing route
     * requires an account and the age gate - so a signed-out visitor is not
     * shown an empty shelf, they are shown no shelf.
     */
    async refreshRecordings() {
        if (!api.signedIn) {
            this.recordings = [];
            this.recordingsBlocked = null;
            this._renderRecordings();
            return;
        }

        try {
            const { recordings } = await api.recordings.market(this.recordingTag || null);
            this.recordings = recordings;
            this.recordingsBlocked = null;
        } catch (err) {
            this.recordings = [];
            this.recordingsBlocked = err.status === 403 ? 'age' : 'error';
        }

        this._renderRecordings();
    }

    _renderRecordings() {
        if (!this.recordingsEl) return;

        const recordings = this.recordings ?? [];

        // The age gate is worth a line; anything else is not worth a shelf that
        // says "something went wrong" on a home page.
        if (this.recordingsBlocked === 'age') {
            this.recordingsEl.hidden = false;
            this.recordingsEl.querySelector('#recording-row').innerHTML =
                '<p class="shelf-note">Confirm your age on your profile to see recordings for sale.</p>';
            return;
        }

        // Keep the shelf up while a filter is on, so choosing 3D and finding
        // nothing reads as "none of these yet" rather than as the row vanishing.
        // Signed out there is no shelf at all, filter or no filter — the route
        // was never asked, so "nothing on sale" would be a thing we do not know.
        this.recordingsEl.hidden = !api.signedIn || (recordings.length === 0 && !this.recordingTag);
        if (this.recordingsEl.hidden) return;

        this.recordingsEl.querySelector('#recording-row').innerHTML = recordings.length
            ? recordings.map((row) => this._recordingCardHtml(row)).join('')
            : '<p class="shelf-note">Nothing on sale in this format yet.</p>';
    }

    _recordingCardHtml(row) {
        const minutes = Math.max(1, Math.round((row.durationMs ?? 0) / 60000));

        return `
            <article class="recording-card" data-recording="${escapeHtml(row.id)}">
                <div class="recording-art">
                    <span class="badge ${row.tag === '3d' ? 'stereo' : 'vr'}">${row.tag.toUpperCase()}</span>
                    <span class="recording-length">${minutes} min</span>
                </div>
                <h3>${escapeHtml(row.title ?? 'Untitled')}</h3>
                <div class="recording-meta">
                    <span>${escapeHtml(row.creatorName ?? 'Creator')}</span>
                    <span class="price">${row.owned ? 'Purchased' : dollars(row.price)}</span>
                </div>
                <button class="btn ${row.owned ? 'btn-secondary' : 'btn-primary'}"
                    data-recording-action="${row.owned ? 'watch' : 'buy'}">
                    ${row.owned ? 'Watch' : 'Buy'}
                </button>
            </article>`;
    }

    _bindRecordings() {
        this.recordingsEl?.addEventListener('click', async (e) => {
            const tag = e.target.closest('#recording-tags button');

            if (tag) {
                this.recordingTag = tag.dataset.tag;
                this.recordingsEl
                    .querySelectorAll('#recording-tags button')
                    .forEach((b) => b.classList.toggle('active', b === tag));
                await this.refreshRecordings();
                return;
            }

            const card = e.target.closest('[data-recording]');
            const button = e.target.closest('[data-recording-action]');
            if (!card || !button) return;

            const row = (this.recordings ?? []).find((r) => r.id === card.dataset.recording);
            if (!row) return;

            if (button.dataset.recordingAction === 'watch') {
                this._openRecording(row);
                return;
            }

            button.disabled = true;

            try {
                await api.recordings.buy(row.id);
                this.fire('notice', `Bought “${row.title}”.`);
                await this.refreshRecordings();
                this._openRecording({ ...row, owned: true });
            } catch (err) {
                button.disabled = false;
                this.fire(
                    'notice',
                    err.status === 402
                        ? 'Not enough credits. Top up on your profile page.'
                        : `Could not buy that: ${err.message}`
                );
            }
        });
    }

    /**
     * Play a purchased recording.
     *
     * A plain `<video>` rather than the immersive player: a 3D recording is a
     * side-by-side MP4 and the catalogue player is built around a title in the
     * library, which this is not. The note under it says what the picture is,
     * rather than leaving somebody to wonder why they can see two of it.
     */
    _openRecording(row) {
        const modal = this.mount.querySelector('#detail-modal');
        const panel = modal.querySelector('.modal');

        panel.innerHTML = `
            <button class="modal-close">${icons.close({ size: 18 })}</button>
            <video class="recording-player" controls autoplay playsinline
                src="${escapeHtml(api.recordings.fileUrl(row.id))}"></video>
            <div class="modal-body recording-body">
                <h2>${escapeHtml(row.title ?? 'Untitled')}</h2>
                <p class="modal-sub">${escapeHtml(row.creatorName ?? 'Creator')} ·
                    ${row.tag.toUpperCase()} · ${Math.max(1, Math.round((row.durationMs ?? 0) / 60000))} min</p>
                ${
                    row.tag === '3d'
                        ? '<p class="modal-sub">Recorded in stereo, side by side. Open it in a headset player for depth.</p>'
                        : ''
                }
            </div>`;

        modal.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    /* ----------------------------------------------------- live creators -- */

    /**
     * Start watching who is on air.
     *
     * Polled rather than pushed: the home page has no socket, opening one per
     * visitor to learn a list of at most a few dozen names would be a socket
     * per visitor for a list that changes every few minutes. The interval is
     * long for the same reason.
     */
    startCreatorPolling(intervalMs = 15_000) {
        clearInterval(this._creatorTimer);
        this._creatorTimer = setInterval(() => this.refreshCreators(), intervalMs);

        // The market is read once when the page comes back into view rather
        // than on the timer: a listing is not a thing that appears mid-glance,
        // and the shelf is behind an authenticated route.
        this.refreshRecordings();

        return this.refreshCreators();
    }

    stopCreatorPolling() {
        clearInterval(this._creatorTimer);
    }

    async refreshCreators() {
        try {
            this.creators = await api.liveCreators();
        } catch {
            // A home page that cannot reach the list is a home page without the
            // row, not a broken one.
            this.creators = [];
        }

        this._renderCreators();
    }

    _renderCreators() {
        if (!this.creatorsEl) return;

        const creators = this.creators ?? [];
        const liveCount = creators.filter((c) => c.status === 'live').length;

        this.creatorsEl.hidden = creators.length === 0;

        // The heading counts, so "Live Creators" over a row of people who are
        // all set up and none of them broadcasting is not a claim the page is
        // making on their behalf.
        const heading = this.creatorsEl.querySelector('h2');
        if (heading) {
            heading.textContent = liveCount
                ? `Live now · ${liveCount}`
                : 'Creators';
        }

        // The billboard leads with whoever is on air, so it changes whenever
        // this list does.
        this._renderBillboard();

        if (!creators.length) return;

        const row = this.creatorsEl.querySelector('#creator-row');
        row.innerHTML = creators.map((creator) => this._creatorCardHtml(creator)).join('');
    }

    _creatorCardHtml(creator) {
        const live = creator.status === 'live';
        const perMin = creator.pricing?.public2dPerMin ?? 0;

        // What pressing it costs, on the face of it. "Ready" used to be the
        // whole of the second line for anyone not on air, which reads as an
        // invitation and led to a toast saying there was nothing to watch.
        const sub = live
            ? perMin > 0
                ? `${dollars(perMin)} / min`
                : 'Free to watch'
            : 'Not on air · see prices';

        return `
            <button class="creator-card ${live ? 'is-live' : ''}" data-creator="${escapeHtml(creator.id)}"
                data-creator-action="${live ? 'watch' : 'info'}"
                aria-label="${escapeHtml(
                    live ? `Watch ${creator.name ?? 'creator'} live` : `${creator.name ?? 'Creator'}, not on air`
                )}"
                title="${escapeHtml(creator.tagline ?? creator.name ?? '')}">
                <span class="creator-face">
                    ${
                        creator.avatarUrl
                            ? `<img src="${escapeHtml(creator.avatarUrl)}" alt="" />`
                            : `<span class="creator-initials">${escapeHtml(initialsOf(creator.name))}</span>`
                    }
                    ${live ? '<span class="creator-live">LIVE</span>' : ''}
                    ${
                        live && creator.live.supports3d
                            ? '<span class="badge stereo creator-3d">3D</span>'
                            : ''
                    }
                </span>
                <span class="creator-name">${escapeHtml(creator.name ?? 'Creator')}</span>
                <span class="creator-sub">${escapeHtml(sub)}</span>
            </button>
        `;
    }

    _bindCreators() {
        this.creatorsEl?.addEventListener('click', (e) => {
            const card = e.target.closest('button[data-creator]');
            if (!card) return;

            const creator = (this.creators ?? []).find((c) => c.id === card.dataset.creator);
            if (creator) this._chooseCreator(creator, card.dataset.creatorAction ?? 'watch');
        });
    }

    /**
     * What clicking a creator does.
     *
     * On air, straight into the broadcast — that is what the picture is there
     * for. Not on air, their page, which used to be a toast saying they were
     * not on air: a dead end, on the one control the home page most wants
     * pressed, in front of an endpoint that had been serving exactly this page
     * since the day it was written and had nothing calling it.
     *
     * @param {object} creator
     * @param {'watch'|'info'} action
     */
    _chooseCreator(creator, action) {
        if (action === 'watch' && creator.status === 'live') {
            this.fire('watchCreator', creator);
            return;
        }

        this.openCreatorDetails(creator);
    }

    /**
     * A creator's page: who they are, what they charge, and whether they are on
     * air. Prices for all four combinations, because deciding to wait for
     * somebody is a decision about money and the 1:1 rate is the one nobody
     * finds out until they are already in the room.
     */
    async openCreatorDetails(creator) {
        const panel = this.modalEl.querySelector('.modal');
        this._modalItem = null;

        panel.innerHTML = `
            <div class="modal-body creator-body">
                <button class="modal-close">${icons.close({ size: 18 })}</button>
                <p class="modal-sub">Loading ${escapeHtml(creator.name ?? 'creator')}…</p>
            </div>`;

        this.modalEl.classList.add('open');
        document.body.style.overflow = 'hidden';

        const detail = await api.profile.creator(creator.id).catch(() => null);
        if (!this.modalEl.classList.contains('open')) return;

        const profile = detail?.profile ?? creator;
        const pricing = detail?.pricing ?? creator.pricing ?? {};
        const live = creator.status === 'live';

        const rate = (amount, enabled = true) =>
            !enabled ? 'Not offered' : amount > 0 ? perMinute(amount) : 'Free';

        panel.innerHTML = `
            <div class="modal-body creator-body">
                <button class="modal-close">${icons.close({ size: 18 })}</button>
                <div class="creator-head">
                    <span class="creator-face lg">
                        ${
                            profile.avatarUrl
                                ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="" />`
                                : `<span class="creator-initials">${escapeHtml(initialsOf(profile.name))}</span>`
                        }
                    </span>
                    <div>
                        <h2>${escapeHtml(profile.name ?? 'Creator')}</h2>
                        <p class="modal-sub">
                            ${live ? '<span class="live-pill">LIVE NOW</span>' : 'Not on air right now'}
                            ${live && creator.live?.supports3d ? ' · 3D available' : ''}
                        </p>
                    </div>
                </div>

                ${profile.tagline ? `<p class="creator-tagline">${escapeHtml(profile.tagline)}</p>` : ''}
                ${profile.bio ? `<p>${escapeHtml(profile.bio)}</p>` : ''}

                <dl class="spec-list">
                    <div><dt>Public room, 2D:</dt><dd>${escapeHtml(rate(pricing.public2dPerMin))}</dd></div>
                    <div><dt>Public room, 3D:</dt><dd>${escapeHtml(rate(pricing.public3dPerMin, pricing.public3dEnabled))}</dd></div>
                    <div><dt>Private 1:1, 2D:</dt><dd>${escapeHtml(rate(pricing.private2dPerMin))}</dd></div>
                    <div><dt>Private 1:1, 3D:</dt><dd>${escapeHtml(rate(pricing.private3dPerMin, pricing.private3dEnabled))}</dd></div>
                </dl>

                <div class="billboard-actions">
                    ${
                        live
                            ? `<button class="btn btn-primary" data-creator-action="watch" data-creator="${escapeHtml(creator.id)}">
                                 ${icons.play({ size: 18 })} Watch live
                               </button>`
                            : `<button class="btn btn-secondary" disabled>Not on air — check back later</button>`
                    }
                </div>
            </div>`;

        panel.querySelector('[data-creator-action="watch"]')?.addEventListener('click', () => {
            this.closeDetails();
            this.fire('watchCreator', creator);
        });
    }

    _headerHtml() {
        return `
            <header class="site-header">
                <div class="brand">${brandLockup({ symbolHeight: 68, wordmarkHeight: 42 })}</div>
                <nav class="site-nav">
                    <button data-filter="all" class="active">Home</button>
                    <button data-filter="vr">VR</button>
                    <button data-filter="180">180° dome</button>
                    <button data-filter="360">360° sphere</button>
                    <button data-filter="flat">Standard</button>
                    <button data-filter="mylist">My List</button>
                </nav>
                <div class="header-right">
                    <div class="search-box">
                        ${icons.search({ size: 16 })}
                        <input type="search" placeholder="Titles, formats, genres" id="search-input" />
                    </div>
                    <button class="icon-btn labelled" id="compat-btn"
                        aria-label="Connect a VR player app"
                        title="Send a title to a headset player">
                        ${icons.cast({ size: 18 })}<span>Send to headset</span>
                    </button>
                    <div id="account-slot"></div>
                </div>
            </header>
        `;
    }

    /**
     * Render the account control.
     *
     * Called again whenever the session changes, so signing in or out updates
     * the header without rebuilding the whole page.
     *
     * @param {object|null} user
     */
    renderAccount(user) {
        const slot = this.mount.querySelector('#account-slot');
        if (!slot) return;

        // The opening hero offers a different next step to a signed-in visitor
        // than to a stranger, so it follows the session.
        this._renderBillboard();

        if (!user) {
            // Both, and sign-up first. A visitor who has never been here has
            // nothing to sign in with, and one control that turns out to be
            // the wrong one is the commonest reason a signup never starts.
            slot.innerHTML = `
                <div class="account-anon">
                    <button class="btn btn-primary sm" data-account="signup">Sign up</button>
                    <button class="btn sm" data-account="signin">Sign in</button>
                </div>`;
            return;
        }

        const initials = (user.displayName || user.email)
            .split(/\s+/)
            .slice(0, 2)
            .map((p) => p[0]?.toUpperCase() ?? '')
            .join('');

        slot.innerHTML = `
            <div class="account">
                <button class="avatar" data-account="menu" title="${escapeHtml(user.email)}">${initials}</button>
                <div class="account-menu" hidden>
                    <div class="account-head">
                        <strong>${escapeHtml(user.displayName)}</strong>
                        <span>${escapeHtml(user.email)}</span>
                        <span class="badge vr">${user.role}</span>
                    </div>
                    <button data-account="profile">Profile &amp; credits</button>
                    ${
                        user.role === 'creator' || user.role === 'admin'
                            ? `<button data-account="studio">Creator Studio</button>`
                            : `<button data-account="become-creator">Become a creator</button>`
                    }
                    <button data-account="signout">Sign out</button>
                </div>
            </div>
        `;
    }

    /* --------------------------------------------------------- billboard -- */

    /**
     * What the top of the page is about right now.
     *
     * Three states, in order of what a visitor came for. Somebody is on air, so
     * lead with them — this is a live product and burying that under a
     * catalogue title was showing the smaller half of it first. Nobody is on
     * air, so lead with the best thing in the library. Neither, so say what the
     * site is, because an empty hero on a first visit explains nothing.
     */
    _renderBillboard() {
        if (!this.billboardEl) return;

        const live = (this.creators ?? []).find((c) => c.status === 'live');
        const next = live
            ? `live:${live.id}`
            : this.hero
              ? `title:${this.hero.id}`
              : `empty:${api.signedIn ? 'in' : 'out'}:${api.isCreator ? 'creator' : 'viewer'}`;

        // Re-rendered on every creator poll, which is every fifteen seconds.
        // Rebuilding an unchanged hero would restart its transitions and steal
        // focus from anything the visitor had tabbed to inside it.
        if (next === this._billboardKey) return;
        this._billboardKey = next;

        this.billboardEl.innerHTML = live
            ? this._liveBillboardHtml(live)
            : this.hero
              ? this._billboardHtml(this.hero)
              : this._openingBillboardHtml();
    }

    /**
     * The hero for a broadcast that is running.
     *
     * The price is on it, in dollars, before anything is clicked: the watch
     * button leads to a page that starts charging by the minute, and a paid
     * door with no price on it is the one thing a viewer never forgives.
     */
    _liveBillboardHtml(creator) {
        const others = (this.creators ?? []).filter((c) => c.status === 'live').length - 1;
        const perMin = creator.pricing?.public2dPerMin ?? 0;

        return `
            <section class="billboard billboard-live" id="billboard">
                <div class="billboard-art billboard-art-blank"></div>
                <div class="billboard-inner">
                    <div class="billboard-eyebrow">
                        <span class="live-pill">LIVE NOW</span>
                        ${creator.live?.supports3d ? '<span>·</span><span>3D available</span>' : ''}
                        ${others > 0 ? `<span>·</span><span>${others} more on air</span>` : ''}
                    </div>
                    <h1>${escapeHtml(creator.name ?? 'Creator')}</h1>
                    <div class="billboard-meta">
                        <span>${perMin > 0 ? escapeHtml(perMinute(perMin)) : 'Free to watch'}</span>
                        <span>Public room</span>
                    </div>
                    <p>${escapeHtml(creator.tagline || 'Broadcasting right now. The room is open.')}</p>
                    <div class="billboard-actions">
                        <button class="btn btn-primary" data-creator-action="watch" data-creator="${escapeHtml(creator.id)}">
                            ${icons.play({ size: 18 })} Watch live
                        </button>
                        <button class="btn btn-secondary" data-creator-action="info" data-creator="${escapeHtml(creator.id)}">
                            ${icons.info({ size: 18 })} Prices and profile
                        </button>
                    </div>
                </div>
            </section>
        `;
    }

    /**
     * Nothing on air and nothing in the library.
     *
     * A first deployment, or a quiet hour. Either way it is the only chance the
     * page gets to say what it is for, so it says it plainly and offers the one
     * action that leads anywhere.
     */
    _openingBillboardHtml() {
        return `
            <section class="billboard billboard-opening" id="billboard">
                <div class="billboard-art billboard-art-blank"></div>
                <div class="billboard-inner">
                    <div class="billboard-eyebrow"><span>Live, in 2D and 3D</span></div>
                    <h1>Watch creators live, in a browser or a headset.</h1>
                    <p>
                        Public rooms are charged by the minute. Go 1:1 privately with a creator,
                        record the session, and buy back the ones they put up for sale.
                    </p>
                    <div class="billboard-actions">
                        ${
                            api.signedIn
                                ? `<button class="btn btn-primary" data-account="profile">Top up credits</button>`
                                : `<button class="btn btn-primary" data-account="signup">Create an account</button>`
                        }
                        <button class="btn btn-secondary" data-account="${api.isCreator ? 'studio' : 'become-creator'}">
                            ${api.isCreator ? 'Open Creator Studio' : 'Become a creator'}
                        </button>
                    </div>
                </div>
            </section>
        `;
    }

    _billboardHtml(item) {
        const canVr = this.caps.xrSupported;

        return `
            <section class="billboard" id="billboard">
                <div class="billboard-art" style="background-image:url('${item.backdrop}')"></div>
                <div class="billboard-inner">
                    <div class="billboard-eyebrow">
                        ${[...item.badges, item.genre]
                            .filter(Boolean)
                            .map((label) => `<span>${escapeHtml(label)}</span>`)
                            .join('<span>·</span>')}
                    </div>
                    <h1>${escapeHtml(item.title)}</h1>
                    <div class="billboard-meta">
                        <span>${formatDuration(item.duration)}</span>
                        ${item.year ? `<span>${item.year}</span>` : ''}
                        ${item.resolution ? `<span>${item.resolution}</span>` : ''}
                    </div>
                    <p>${escapeHtml(item.synopsis || '')}</p>
                    <div class="billboard-actions">
                        <button class="btn btn-primary" data-action="play">
                            ${icons.play({ size: 18 })} Play
                        </button>
                        <button class="btn btn-vr" data-action="vr" ${canVr ? '' : 'disabled title="No WebXR device detected"'}>
                            ${icons.headset({ size: 18 })} ${canVr ? 'Watch in VR' : 'VR Unavailable'}
                        </button>
                        <button class="btn btn-secondary" data-action="info">
                            ${icons.info({ size: 18 })} More Info
                        </button>
                    </div>
                </div>
            </section>
        `;
    }

    _modalHtml() {
        return `
            <div class="modal-backdrop" id="detail-modal">
                <div class="modal" role="dialog" aria-modal="true"></div>
            </div>
        `;
    }

    /**
     * @param {{title: string, items: object[]}[]} rows
     * @param {{empty?: string}} [opts] - What to say when `rows` is empty. The
     *   default is the library having nothing in it at all, which is a very
     *   different thing from a filter that matched nothing, and telling a
     *   visitor to drop files into a directory because they picked 360° is
     *   how a dead end gets mistaken for a broken page.
     */
    _renderShelves(rows, opts = {}) {
        if (!rows.length) {
            const hint =
                opts.empty === undefined
                    ? 'The library is separate from the live side — anyone on air can still be watched now.'
                    : 'Try Home for everything, or watch whoever is on air.';

            this.shelvesEl.innerHTML = `
                <div class="empty-state">
                    <h2>${escapeHtml(opts.empty ?? 'No titles in the library yet')}</h2>
                    <p>${hint}</p>
                </div>`;
            return;
        }

        this.shelvesEl.innerHTML = rows
            .map(
                (row) => `
            <section class="shelf">
                <div class="shelf-head">
                    <h2>${escapeHtml(row.title)}</h2>
                </div>
                <div class="shelf-viewport">
                    <button class="shelf-arrow prev">${icons.chevronLeft({ size: 24 })}</button>
                    <div class="shelf-track">
                        ${row.items.map((item) => this._cardHtml(item)).join('')}
                    </div>
                    <button class="shelf-arrow next">${icons.chevronRight({ size: 24 })}</button>
                </div>
            </section>`
            )
            .join('');

        this._bindShelfArrows();
    }

    _cardHtml(item) {
        const inList = this.myList.has(item.id);
        const watched = this.progress[item.id];
        const pct = watched && item.duration ? Math.min(100, (watched / item.duration) * 100) : 0;

        const badges = item.badges
            .map((b) => `<span class="badge ${b === '3D' ? 'stereo' : 'vr'}">${b}</span>`)
            .join('');

        return `
            <article class="card" data-id="${item.id}">
                <div class="card-art" style="background-image:url('${item.poster}')">
                    <div class="card-badges">${badges}</div>
                    <span class="card-duration">${formatDuration(item.duration)}</span>
                    ${pct > 1 ? `<div class="card-progress"><i style="width:${pct}%"></i></div>` : ''}
                </div>
                <div class="card-body">
                    <div class="card-actions">
                        <button class="round-btn filled" data-action="play" title="Play">${icons.play({ size: 12 })}</button>
                        ${
                            item.immersive && this.caps.xrSupported
                                ? `<button class="round-btn vr" data-action="vr" title="Watch in VR">${icons.headset({ size: 13 })}</button>`
                                : ''
                        }
                        <button class="round-btn" data-action="list" title="${inList ? 'Remove from My List' : 'Add to My List'}">
                            ${inList ? icons.check({ size: 13 }) : icons.plus({ size: 13 })}
                        </button>
                        <button class="round-btn" data-action="info" title="More info" style="margin-left:auto">
                            ${icons.info({ size: 13 })}
                        </button>
                    </div>
                    <h3 class="card-title">${escapeHtml(item.title)}</h3>
                    <div class="card-meta">
                        ${item.genre ? `<span>${escapeHtml(item.genre)}</span>` : ''}
                        <span class="fmt">${describeFormat(item.format)}</span>
                        ${item.resolution ? `<span>${item.resolution}</span>` : ''}
                    </div>
                </div>
            </article>
        `;
    }

    /* ------------------------------------------------------------ events -- */

    _bindScroll() {
        const onScroll = () => {
            this.header.classList.toggle('scrolled', window.scrollY > 24);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
    }

    _bindHeader() {
        const nav = this.mount.querySelector('.site-nav');
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-filter]');
            if (!btn) return;

            nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
            this._applyFilter(btn.dataset.filter);
        });

        const search = this.mount.querySelector('#search-input');
        let timer = null;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => this._applySearch(search.value), 160);
        });

        this.mount.querySelector('#compat-btn').addEventListener('click', () => {
            this.fire('showCompat');
        });

        // Account menu, delegated because the slot is re-rendered on session change.
        this.mount.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-account]');
            const menu = this.mount.querySelector('.account-menu');

            if (!btn) {
                if (menu) menu.hidden = true;
                return;
            }

            switch (btn.dataset.account) {
                case 'menu':
                    if (menu) menu.hidden = !menu.hidden;
                    break;
                case 'signin':
                    this.fire('signIn');
                    break;
                case 'signup':
                    this.fire('signUp');
                    break;
                case 'profile':
                    this.fire('openProfile');
                    if (menu) menu.hidden = true;
                    break;
                case 'studio':
                    this.fire('openStudio');
                    if (menu) menu.hidden = true;
                    break;
                case 'become-creator':
                    this.fire('becomeCreator');
                    if (menu) menu.hidden = true;
                    break;
                case 'signout':
                    this.fire('signOut');
                    if (menu) menu.hidden = true;
                    break;
            }
        });
    }

    /**
     * Delegated to the slot rather than to the hero inside it, because which
     * hero is in there changes every time the live list does.
     */
    _bindBillboard() {
        this.billboardEl?.addEventListener('click', (e) => {
            const creatorBtn = e.target.closest('button[data-creator-action]');
            if (creatorBtn) {
                const creator = (this.creators ?? []).find((c) => c.id === creatorBtn.dataset.creator);
                if (creator) this._chooseCreator(creator, creatorBtn.dataset.creatorAction);
                return;
            }

            const btn = e.target.closest('button[data-action]');
            if (btn && this.hero) this._handleAction(btn.dataset.action, this.hero);
        });
    }

    /**
     * The arrows, which belong to the shelves that were just rendered.
     *
     * Separate from `_bindShelves` because that one attaches to `#shelves`
     * itself, which survives every re-render — binding both together meant a
     * card click firing once per filter the visitor had used since loading.
     */
    _bindShelfArrows() {
        this.shelvesEl.querySelectorAll('.shelf').forEach((shelf) => {
            const track = shelf.querySelector('.shelf-track');

            shelf.querySelector('.prev').addEventListener('click', () => {
                track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' });
            });
            shelf.querySelector('.next').addEventListener('click', () => {
                track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' });
            });
        });
    }

    /** Card clicks, delegated once to the container. */
    _bindShelves() {
        this.shelvesEl.addEventListener('click', (e) => {
            const card = e.target.closest('.card');
            if (!card) return;

            const item = this.catalog.items.find((i) => i.id === card.dataset.id);
            if (!item) return;

            const btn = e.target.closest('button[data-action]');
            this._handleAction(btn ? btn.dataset.action : 'info', item, btn);
        });
    }

    _handleAction(action, item, btn) {
        switch (action) {
            case 'play':
                this.fire('play', item, { immersive: false });
                break;
            case 'vr':
                this.fire('enterVr', item);
                break;
            case 'info':
                this.openDetails(item);
                break;
            case 'list':
                this._toggleMyList(item, btn);
                break;
        }
    }

    _toggleMyList(item, btn) {
        const member = !this.myList.has(item.id);

        if (member) {
            this.myList.add(item.id);
            if (btn) btn.innerHTML = icons.check({ size: 13 });
        } else {
            this.myList.delete(item.id);
            if (btn) btn.innerHTML = icons.plus({ size: 13 });
        }

        // Written locally either way so the UI is correct while signed out;
        // the server call is a no-op without a session.
        saveMyList([...this.myList]);
        api.setMyList(item.id, member);
    }

    _applyFilter(filter) {
        const items = this.catalog.items;

        // Shelf headings repeat the nav button that opened them, in the same
        // words, so it is obvious which filter is on — and the empty line says
        // which filter found nothing rather than implying the library is bare.
        const show = (list, title, empty) =>
            this._renderShelves(list.length ? [{ title, items: list }] : [], { empty });

        switch (filter) {
            case 'vr':
                show(items.filter((i) => i.immersive), 'All VR titles', 'No VR titles in the library yet');
                break;
            case '180':
                show(
                    items.filter((i) => i.format.projection === PROJECTION.DOME180),
                    '180° dome',
                    'No 180° dome titles in the library yet'
                );
                break;
            case '360':
                show(
                    items.filter((i) => i.format.projection === PROJECTION.SPHERE360),
                    '360° sphere',
                    'No 360° sphere titles in the library yet'
                );
                break;
            case 'flat':
                show(items.filter((i) => !i.immersive), 'Standard', 'No standard titles in the library yet');
                break;
            case 'mylist':
                show(
                    items.filter((i) => this.myList.has(i.id)),
                    'My List',
                    'Nothing saved yet — the + on any title puts it here'
                );
                break;
            default:
                this._renderShelves(this.catalog.rows);
        }
    }

    _applySearch(query) {
        if (!query.trim()) {
            this._renderShelves(this.catalog.rows);
            return;
        }

        const results = searchCatalog(this.catalog.items, query);
        this._renderShelves(
            results.length ? [{ title: `Results for "${query}"`, items: results }] : [],
            { empty: `Nothing in the library matches “${query}”` }
        );
    }

    /* ------------------------------------------------------------- modal -- */

    _bindModal() {
        this.modalEl.addEventListener('click', (e) => {
            if (e.target === this.modalEl || e.target.closest('.modal-close')) {
                this.closeDetails();
                return;
            }

            const btn = e.target.closest('button[data-action]');
            if (!btn || !this._modalItem) return;

            if (btn.dataset.action !== 'info') this.closeDetails();
            this._handleAction(btn.dataset.action, this._modalItem, btn);
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeDetails();
        });
    }

    /** @param {object} item */
    openDetails(item) {
        this._modalItem = item;
        const fmt = item.format;
        const canVr = this.caps.xrSupported;

        this.modalEl.querySelector('.modal').innerHTML = `
            <div class="modal-art" style="background-image:url('${item.backdrop}')">
                <button class="modal-close">${icons.close({ size: 18 })}</button>
                <div class="modal-art-inner">
                    <h2>${escapeHtml(item.title)}</h2>
                    <div class="billboard-actions">
                        <button class="btn btn-primary" data-action="play">${icons.play({ size: 18 })} Play</button>
                        ${
                            item.immersive
                                ? `<button class="btn btn-vr" data-action="vr" ${canVr ? '' : 'disabled'}>
                                     ${icons.headset({ size: 18 })} Watch in VR
                                   </button>`
                                : ''
                        }
                        <button class="btn btn-secondary" data-action="list">${icons.plus({ size: 18 })} My List</button>
                    </div>
                </div>
            </div>
            <div class="modal-body">
                <div>
                    <div class="billboard-meta">
                        ${item.year ? `<span>${item.year}</span>` : ''}
                        <span>${formatDuration(item.duration)}</span>
                        ${item.resolution ? `<span>${item.resolution}</span>` : ''}
                        ${item.badges.map((b) => `<span class="badge ${b === '3D' ? 'stereo' : 'vr'}">${b}</span>`).join('')}
                    </div>
                    <p>${escapeHtml(item.synopsis || 'No synopsis available.')}</p>
                </div>
                <dl class="spec-list">
                    <div><dt>Projection:</dt><dd>${projectionLabel(fmt)}</dd></div>
                    <div><dt>Stereo:</dt><dd>${stereoLabel(fmt)}</dd></div>
                    ${fmt.lens ? `<div><dt>Lens:</dt><dd>${fmt.lens.toUpperCase()}</dd></div>` : ''}
                    ${item.genre ? `<div><dt>Genre:</dt><dd>${escapeHtml(item.genre)}</dd></div>` : ''}
                    ${item.studio ? `<div><dt>Studio:</dt><dd>${escapeHtml(item.studio)}</dd></div>` : ''}
                </dl>
            </div>
        `;

        this.modalEl.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    closeDetails() {
        // A recording plays inside this modal, and a hidden element with a
        // paused-looking dialog over it would go on making noise. Emptying the
        // source is what actually releases the connection, not just the sound.
        const player = this.modalEl.querySelector('.recording-player');
        if (player) {
            player.pause();
            player.removeAttribute('src');
            player.load();
        }

        this.modalEl.classList.remove('open');
        this._modalItem = null;
        document.body.style.overflow = '';
    }

    /** Persist resume position for the continue-watching indicator. */
    saveProgress(itemId, seconds) {
        this.progress[itemId] = seconds;

        try {
            localStorage.setItem('avr:progress', JSON.stringify(this.progress));
        } catch {
            /* storage disabled - progress is a nicety, not a requirement */
        }

        // Signed in, the server copy is authoritative and follows the viewer
        // between devices.
        api.saveProgress(itemId, seconds);
    }

    getProgress(itemId) {
        return this.progress[itemId] || 0;
    }

    setVisible(visible) {
        this.mount.style.display = visible ? '' : 'none';
    }
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * The one-line format, for a card.
 *
 * Flat titles are described by their depth alone — on a poster tile "Flat ·
 * Standard" is three words to say "an ordinary video". Everything else names
 * the shape, in the same words Studio and the capture app use.
 */
function describeFormat(format) {
    if (format.projection === PROJECTION.FLAT) return depthTag(format.stereo);
    return formatSummary(format);
}

function projectionLabel(format) {
    return format.projection === PROJECTION.FISHEYE && format.fisheyeFov
        ? `${format.fisheyeFov}° fisheye`
        : (PROJECTION_DETAIL[format.projection] ?? PROJECTION_DETAIL[PROJECTION.FLAT]);
}

function stereoLabel(format) {
    return STEREO_DETAIL[format.stereo] ?? STEREO_DETAIL[STEREO.MONO];
}

/** Up to two initials, for an account with no picture. */
function initialsOf(name) {
    return String(name ?? '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? '')
        .join('');
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function loadMyList() {
    try {
        return JSON.parse(localStorage.getItem('avr:mylist') || '[]');
    } catch {
        return [];
    }
}

function saveMyList(list) {
    try {
        localStorage.setItem('avr:mylist', JSON.stringify(list));
    } catch {
        /* ignore */
    }
}

function loadProgress() {
    try {
        return JSON.parse(localStorage.getItem('avr:progress') || '{}');
    } catch {
        return {};
    }
}
