import * as pc from 'playcanvas';
import { icons } from './icons.js';
import { formatDuration, pickHero, searchCatalog } from '../catalog/catalog.js';
import { PROJECTION, STEREO } from '../catalog/media-format.js';
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
        const hero = pickHero(this.catalog.items);

        this.mount.innerHTML = `
            ${this._headerHtml()}
            <main id="browse-main">
                ${hero ? this._billboardHtml(hero) : ''}
                <section class="shelf live-creators" id="live-creators" hidden>
                    <div class="shelf-head">
                        <h2>Live Creators</h2>
                    </div>
                    <div class="creator-row" id="creator-row"></div>
                </section>
                <div class="shelves" id="shelves"></div>
            </main>
            ${this._modalHtml()}
        `;

        this.header = this.mount.querySelector('.site-header');
        this.shelvesEl = this.mount.querySelector('#shelves');
        this.modalEl = this.mount.querySelector('#detail-modal');
        this.creatorsEl = this.mount.querySelector('#live-creators');

        this._renderShelves(this.catalog.rows);
        this._renderCreators();
        this._bindHeader();
        this._bindBillboard(hero);
        this._bindModal();
        this._bindCreators();
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
        this.creatorsEl.hidden = creators.length === 0;
        if (!creators.length) return;

        const row = this.creatorsEl.querySelector('#creator-row');
        row.innerHTML = creators.map((creator) => this._creatorCardHtml(creator)).join('');
    }

    _creatorCardHtml(creator) {
        const initials = (creator.name ?? '?')
            .split(/\s+/)
            .slice(0, 2)
            .map((p) => p[0]?.toUpperCase() ?? '')
            .join('');

        const live = creator.status === 'live';
        const perMin = live ? creator.pricing.public2dPerMin : null;

        return `
            <button class="creator-card ${live ? 'is-live' : ''}" data-creator="${escapeHtml(creator.id)}"
                title="${escapeHtml(creator.tagline ?? creator.name ?? '')}">
                <span class="creator-face">
                    ${
                        creator.avatarUrl
                            ? `<img src="${escapeHtml(creator.avatarUrl)}" alt="" />`
                            : `<span class="creator-initials">${escapeHtml(initials)}</span>`
                    }
                    ${live ? '<span class="creator-live">LIVE</span>' : ''}
                    ${
                        live && creator.live.supports3d
                            ? '<span class="badge stereo creator-3d">3D</span>'
                            : ''
                    }
                </span>
                <span class="creator-name">${escapeHtml(creator.name ?? 'Creator')}</span>
                <span class="creator-sub">
                    ${live ? (perMin ? `${(perMin / 100).toFixed(2)} / min` : 'Free') : 'Ready'}
                </span>
            </button>
        `;
    }

    _bindCreators() {
        this.creatorsEl?.addEventListener('click', (e) => {
            const card = e.target.closest('button[data-creator]');
            if (!card) return;

            const creator = (this.creators ?? []).find((c) => c.id === card.dataset.creator);
            if (creator) this.fire('watchCreator', creator);
        });
    }

    _headerHtml() {
        return `
            <header class="site-header">
                <div class="brand">A<span>VR</span></div>
                <nav class="site-nav">
                    <button data-filter="all" class="active">Home</button>
                    <button data-filter="vr">VR</button>
                    <button data-filter="180">180°</button>
                    <button data-filter="360">360°</button>
                    <button data-filter="flat">Standard</button>
                    <button data-filter="mylist">My List</button>
                </nav>
                <div class="header-right">
                    <div class="search-box">
                        ${icons.search({ size: 16 })}
                        <input type="search" placeholder="Titles, formats, genres" id="search-input" />
                    </div>
                    <button class="icon-btn" id="compat-btn" title="Connect a VR player app">
                        ${icons.cast({ size: 18 })}
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

    _renderShelves(rows) {
        if (!rows.length) {
            this.shelvesEl.innerHTML = `
                <div class="empty-state">
                    <h2>Nothing here yet</h2>
                    <p>Drop video files into <code>public/media/</code> and they will appear on the shelves.</p>
                </div>`;
            return;
        }

        this.shelvesEl.innerHTML = rows
            .map(
                (row) => `
            <section class="shelf">
                <div class="shelf-head">
                    <h2>${escapeHtml(row.title)}</h2>
                    <span class="explore">EXPLORE ALL ›</span>
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

        this._bindShelves();
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

    _bindBillboard(hero) {
        if (!hero) return;

        this.mount.querySelector('#billboard').addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            this._handleAction(btn.dataset.action, hero);
        });
    }

    _bindShelves() {
        this.shelvesEl.querySelectorAll('.shelf').forEach((shelf) => {
            const track = shelf.querySelector('.shelf-track');

            shelf.querySelector('.prev').addEventListener('click', () => {
                track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' });
            });
            shelf.querySelector('.next').addEventListener('click', () => {
                track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' });
            });
        });

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

        const rowsFor = (list, title) => (list.length ? [{ title, items: list }] : []);

        switch (filter) {
            case 'vr':
                this._renderShelves(rowsFor(items.filter((i) => i.immersive), 'All VR Titles'));
                break;
            case '180':
                this._renderShelves(rowsFor(items.filter((i) => i.format.projection === PROJECTION.DOME180), 'VR 180'));
                break;
            case '360':
                this._renderShelves(rowsFor(items.filter((i) => i.format.projection === PROJECTION.SPHERE360), '360° Experiences'));
                break;
            case 'flat':
                this._renderShelves(rowsFor(items.filter((i) => !i.immersive), 'Standard Video'));
                break;
            case 'mylist':
                this._renderShelves(rowsFor(items.filter((i) => this.myList.has(i.id)), 'My List'));
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
        this._renderShelves(results.length ? [{ title: `Results for "${query}"`, items: results }] : []);
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
                    <div><dt>Source:</dt><dd style="word-break:break-all">${escapeHtml(item.src)}</dd></div>
                </dl>
            </div>
        `;

        this.modalEl.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    closeDetails() {
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

function describeFormat(format) {
    if (format.projection === PROJECTION.FLAT) return format.stereo === STEREO.MONO ? '2D' : '3D';

    const shape =
        format.projection === PROJECTION.DOME180
            ? 'VR180'
            : format.projection === PROJECTION.SPHERE360
              ? 'VR360'
              : `Fisheye ${format.fisheyeFov}°`;

    return `${shape} · ${format.stereo === STEREO.MONO ? 'Mono' : '3D'}`;
}

function projectionLabel(format) {
    switch (format.projection) {
        case PROJECTION.DOME180:
            return '180° equirectangular dome';
        case PROJECTION.SPHERE360:
            return '360° equirectangular sphere';
        case PROJECTION.FISHEYE:
            return `${format.fisheyeFov}° circular fisheye`;
        default:
            return 'Flat / rectilinear';
    }
}

function stereoLabel(format) {
    switch (format.stereo) {
        case STEREO.SBS:
            return 'Side-by-side (left | right)';
        case STEREO.TB:
            return 'Over-under (left / right)';
        default:
            return 'Monoscopic';
    }
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
