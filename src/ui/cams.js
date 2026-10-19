import { icons } from './icons.js';
import { AFFILIATE_LINK_REL } from '../catalog/affiliates.js';

/**
 * Live cams: a shelf of rooms broadcasting right now, and a theatre to watch
 * one in without leaving the page.
 *
 * The feed is Chaturbate's affiliate API, proxied by `server/routes/cams.js` —
 * see that file for why it is proxied and what it strips. Everything here is
 * presentation, and there are three ideas in it:
 *
 *   **VR first.** This site is about headsets, so the shelf opens filtered to
 *   rooms tagged for one and the full list is a second click. That ordering is
 *   the only thing distinguishing this row from the same feed on thousands of
 *   other sites, and it is the reason it is defensible to publish at all.
 *
 *   **The thumbnails are alive.** A still frame of a live room is a worse lie
 *   the longer the page is open. Visible cards refresh on a timer, the hovered
 *   one faster, and each new frame is decoded off-screen and swapped in only
 *   once it has loaded — so a slow fetch never blanks a card that was fine.
 *   Off-screen cards, a backgrounded tab and `prefers-reduced-motion` all stop
 *   it completely.
 *
 *   **Watching happens here.** The partner's embeddable player is the white
 *   label: a real room, on our page, that still pays. Clicking a card opens it
 *   in a theatre rather than navigating away. Middle-click, ⌘-click and "open
 *   in new tab" still go to the partner, because the card is a real anchor and
 *   only an unmodified left click is intercepted.
 *
 * ## What this does not do
 *
 * No room gets a URL. The theatre is a dialog, not a route, and nothing here
 * is written into the sitemap, the `<noscript>` or the structured data. A page
 * per room off a feed every affiliate has is scaled content abuse under
 * Google's spam policy, and the rooms are gone within the hour besides — the
 * same reason `live.html` is `noindex`. `data-nosnippet` on the section keeps
 * the list out of a snippet even if a renderer does see it.
 */

/** How often a visible card asks for a new frame. */
const REFRESH_MS = 9_000;

/** And the one under the pointer, which is the one being decided about. */
const HOVER_REFRESH_MS = 2_500;

/** Give up on a frame rather than leave a half-loaded image pending forever. */
const FRAME_TIMEOUT_MS = 6_000;

const FILTERS = [
    { id: 'vr', label: 'VR & 3D' },
    { id: '', label: 'Everyone' }
];

/** How many skeleton cards the reserved space is drawn as. */
const SKELETON_CARDS = 8;

const MEMORY_KEY = 'avr:cams';

/**
 * Whether to reserve space for this shelf before the feed has answered.
 *
 * The shelf sits above the fold, so anything that makes it appear *after*
 * first paint pushes the whole page down — the same layout shift
 * `_renderFootAds` exists to avoid, and the one Core Web Vital that is also a
 * ranking input. Unlike the partner section, a shelf has a height we control
 * rather than one that depends on what a feed returns, so the space can be
 * reserved exactly instead of guessed at.
 *
 * That leaves one case: a deployment with no affiliate code, where the
 * reservation is collapsed a moment later and the shift happens anyway. So
 * the answer is remembered. A visitor whose last load had no rooms gets no
 * reservation and no shift; the cost is one shift on a first-ever visit, and
 * it corrects itself in the other direction just as fast once the feed starts
 * answering.
 */
export function camsExpected() {
    try {
        return localStorage.getItem(MEMORY_KEY) !== '0';
    } catch {
        // Private mode, or storage disabled. Reserving is the better default:
        // it is right whenever the feed works, which is the normal case.
        return true;
    }
}

function rememberCams(any) {
    try {
        localStorage.setItem(MEMORY_KEY, any ? '1' : '0');
    } catch {
        /* Nothing to do, and nothing worth saying about it. */
    }
}

/**
 * The placeholder the shelf occupies until the feed answers.
 *
 * Written into the page's first paint by `BrowseUI._render` rather than
 * created here, because a node created later has no previous position and
 * therefore reserves nothing. It is replaced wholesale by {@link
 * CamShelf._render}.
 */
export function camSkeletonHtml() {
    return `
        <div class="shelf-head cam-head">
            <h2>Live now</h2>
            <span class="badge partner">Chaturbate</span>
        </div>
        <div class="shelf-viewport">
            <div class="shelf-track cam-track">
                ${Array.from(
                    { length: SKELETON_CARDS },
                    () => `
                    <div class="card cam-card cam-skeleton" aria-hidden="true">
                        <div class="cam-art"></div>
                        <div class="card-body">
                            <h3 class="card-title"></h3>
                            <p class="cam-subject"></p>
                        </div>
                    </div>`
                ).join('')}
            </div>
        </div>`;
}

export class CamShelf {
    /**
     * @param {HTMLElement} mount the element to render the shelf into
     */
    constructor(mount) {
        this.mount = mount;
        this.rooms = [];
        this.filter = 'vr';
        this.configured = false;

        /** @type {Map<HTMLElement, {room: object, at: number}>} */
        this.onScreen = new Map();

        this.frame = 0;
        this.timer = null;
        this.observer = null;
        this.theatre = null;
        this.returnFocusTo = null;

        // A cam shelf is motion by definition, and a refreshing thumbnail is
        // the kind of unrequested movement this setting exists to stop. With
        // it on the shelf still works — the frames are just the ones that
        // arrived with the page.
        this.still =
            typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /**
     * Load the feed and draw.
     *
     * Silent on every failure. An unconfigured deployment, a partner outage
     * and a blocked request are indistinguishable to a visitor and all three
     * have the same right answer: there is no cam row, and the page says
     * nothing about why.
     */
    async refresh() {
        if (!this.mount) return;

        try {
            const res = await fetch('/api/cams', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
            });

            if (!res.ok) throw new Error(String(res.status));

            const data = await res.json();

            this.configured = data?.configured === true;
            this.rooms = Array.isArray(data?.rooms) ? data.rooms : [];
            this.vrTotal = Number(data?.vrTotal) || 0;
        } catch {
            this.configured = false;
            this.rooms = [];
        }

        // Nothing to show opens filtered to everyone instead of to an empty
        // VR shelf — a row that is empty on arrival reads as broken, and the
        // visitor has no way to know the second filter is the populated one.
        if (!this.vrTotal) this.filter = '';

        rememberCams(this.configured && this.rooms.length > 0);

        this._render();
    }

    /* ---------------------------------------------------------- rendering -- */

    _render() {
        const rooms = this._visible();

        this.mount.classList.remove('is-loading');
        this.mount.hidden = !this.configured || this.rooms.length === 0;

        if (this.mount.hidden) {
            this._stopRefresh();
            this.mount.innerHTML = '';
            return;
        }

        this.mount.innerHTML = `
            <div class="shelf-head cam-head">
                <h2>Live now</h2>
                <span class="badge partner">Chaturbate</span>
                <div class="tag-filter cam-filter" role="group" aria-label="Filter live rooms">
                    ${FILTERS.map(
                        (f) => `
                        <button type="button" data-cam-filter="${f.id}"
                                class="${this.filter === f.id ? 'active' : ''}"
                                aria-pressed="${this.filter === f.id}"
                                ${f.id === 'vr' && !this.vrTotal ? 'disabled' : ''}>
                            ${escapeHtml(f.label)}
                        </button>`
                    ).join('')}
                </div>
                <span class="affiliates-disclosure cam-disclosure">
                    Paid links. We earn a commission, at no extra cost to you.
                </span>
            </div>
            <div class="shelf-viewport">
                <button class="shelf-arrow prev" type="button" aria-label="Scroll left">
                    ${icons.chevronLeft({ size: 24 })}
                </button>
                <div class="shelf-track cam-track">
                    ${rooms.map((room) => this._cardHtml(room)).join('')}
                </div>
                <button class="shelf-arrow next" type="button" aria-label="Scroll right">
                    ${icons.chevronRight({ size: 24 })}
                </button>
            </div>`;

        this._bind();
        this._watchVisibility();
        this._startRefresh();
    }

    _visible() {
        return this.filter === 'vr' ? this.rooms.filter((r) => r.vr) : this.rooms;
    }

    /**
     * One room.
     *
     * An anchor, for the same reason every other card here is one: `rel` is
     * the disclosure and it only means anything on a link, and middle-click,
     * "open in new tab" and a screen reader all work without being
     * reimplemented. The theatre is layered on top of that by intercepting
     * exactly one gesture — see {@link _bind}.
     *
     * The art box has a fixed 4:3 aspect ratio in CSS and the image is sized
     * to it, so a card occupies its final height before its thumbnail
     * arrives. The whole row loads at once and every one of them is a
     * third-party request; without that, this shelf alone would be the
     * largest layout shift on the page.
     */
    _cardHtml(room) {
        const badges = [
            room.vr ? '<span class="cam-badge vr">VR</span>' : '',
            room.hd ? '<span class="cam-badge hd">HD</span>' : '',
            room.fresh ? '<span class="cam-badge new">New</span>' : ''
        ].join('');

        const label = room.embed
            ? `Watch ${room.name} live`
            : `Open ${room.name}'s room at Chaturbate`;

        return `
            <a class="card cam-card" href="${escapeHtml(room.href)}"
               target="_blank" rel="${AFFILIATE_LINK_REL}"
               data-cam="${escapeHtml(room.username)}"
               aria-label="${escapeHtml(label)}">
                <div class="cam-art">
                    <img src="${escapeHtml(room.thumb)}" alt=""
                         loading="lazy" decoding="async" referrerpolicy="no-referrer" />
                    <span class="cam-live"><i aria-hidden="true"></i>Live</span>
                    ${
                        room.viewers
                            ? `<span class="cam-viewers">${icons.users({ size: 12 })}${room.viewers.toLocaleString()}</span>`
                            : ''
                    }
                    ${badges ? `<div class="cam-badges">${badges}</div>` : ''}
                </div>
                <div class="card-body">
                    <h3 class="card-title">${escapeHtml(room.name)}${
                        room.age ? ` <span class="cam-age">${room.age}</span>` : ''
                    }</h3>
                    <!-- Emitted even when empty. The element carries a
                         two-line min-height, so every card in the row is the
                         same height as every other and as the skeleton that
                         reserved the space for it. -->
                    <p class="cam-subject">${escapeHtml(room.subject || '')}</p>
                </div>
            </a>`;
    }

    /* ----------------------------------------------------------- bindings -- */

    _bind() {
        const track = this.mount.querySelector('.cam-track');

        for (const btn of this.mount.querySelectorAll('[data-cam-filter]')) {
            btn.addEventListener('click', () => {
                this.filter = btn.dataset.camFilter;
                this._render();
            });
        }

        for (const [dir, delta] of [
            ['prev', -1],
            ['next', 1]
        ]) {
            this.mount.querySelector(`.shelf-arrow.${dir}`)?.addEventListener('click', () => {
                track?.scrollBy({
                    left: delta * track.clientWidth * 0.8,
                    behavior: this.still ? 'auto' : 'smooth'
                });
            });
        }

        // One listener for the row rather than one per card, and it defers to
        // the browser for everything except a plain click: a modified click is
        // a deliberate request for a new tab, and hijacking it to open a
        // dialog is the behaviour that makes people stop trusting links.
        track?.addEventListener('click', (event) => {
            const anchor = event.target.closest?.('.cam-card');
            if (!anchor) return;

            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (event.button !== 0) return;

            const room = this.rooms.find((r) => r.username === anchor.dataset.cam);
            if (!room?.embed) return;

            event.preventDefault();
            this._openTheatre(room, anchor);
        });

        track?.addEventListener(
            'pointerover',
            (event) => {
                const anchor = event.target.closest?.('.cam-card');
                this.hovered = anchor || null;
            },
            { passive: true }
        );

        track?.addEventListener(
            'pointerleave',
            () => {
                this.hovered = null;
            },
            { passive: true }
        );
    }

    /* -------------------------------------------------- living thumbnails -- */

    /**
     * Track which cards are actually on screen.
     *
     * A shelf is a horizontal scroller holding sixty cards, of which five are
     * visible. Refreshing all sixty would be sixty third-party image requests
     * every nine seconds to show five of them, which is a cost the partner
     * pays and the visitor pays twice over on a phone.
     */
    _watchVisibility() {
        this.observer?.disconnect();

        if (typeof IntersectionObserver !== 'function') {
            // No observer: treat the first screenful as visible and leave the
            // rest alone. Better than refreshing everything, and the only
            // browsers without this are ones nothing here supports anyway.
            for (const el of [...this.mount.querySelectorAll('.cam-card')].slice(0, 6)) {
                this.onScreen.set(el, 0);
            }
            return;
        }

        this.onScreen.clear();

        this.observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) this.onScreen.set(entry.target, 0);
                    else this.onScreen.delete(entry.target);
                }
            },
            { root: this.mount.querySelector('.shelf-track'), threshold: 0.25 }
        );

        for (const el of this.mount.querySelectorAll('.cam-card')) this.observer.observe(el);
    }

    _startRefresh() {
        this._stopRefresh();
        if (this.still) return;

        this.timer = setInterval(() => this._tick(), 1_000);

        this.onVisibility ??= () => {
            // A backgrounded tab is throttled rather than stopped, so without
            // this a tab left open overnight keeps pulling frames nobody is
            // looking at.
            if (document.hidden) this._stopRefresh();
            else this._startRefresh();
        };

        document.addEventListener('visibilitychange', this.onVisibility);
    }

    _stopRefresh() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * One second of work: refresh whichever visible cards are due.
     *
     * Driven by a single one-second interval rather than a timer per card,
     * because sixty timers drifting against each other means sixty separate
     * wakeups and the staggering has to be done by hand anyway. Each card
     * carries the frame number it last asked for, and `frame` advances every
     * second, so "due" is arithmetic rather than scheduling.
     */
    _tick() {
        if (document.hidden) return;

        this.frame += 1;

        // Spread the row out so five cards do not all fire on the same second.
        // Insertion order into `onScreen` is scroll order, so this staggers
        // along the shelf and stays stable for as long as a card is on screen.
        let offset = 0;

        for (const [el, last] of this.onScreen) {
            const period = Math.round(
                (el === this.hovered ? HOVER_REFRESH_MS : REFRESH_MS) / 1_000
            );

            offset += 1;

            if (this.frame - last < period) continue;
            if ((this.frame + offset) % period !== 0) continue;

            this.onScreen.set(el, this.frame);
            this._swapFrame(el);
        }
    }

    /**
     * Fetch the next frame off-screen and swap it in only once it has decoded.
     *
     * Assigning straight to `img.src` shows the card's current frame until the
     * new one arrives and a broken-image box if it never does, which on a slow
     * connection is a shelf that flickers to empty every nine seconds. This
     * way a failed or slow frame is simply a frame that does not change.
     */
    _swapFrame(el) {
        const img = el.querySelector('img');
        if (!img) return;

        let base;
        try {
            base = new URL(img.src);
        } catch {
            return;
        }

        base.searchParams.set('f', String(this.frame));

        const next = new Image();
        let settled = false;

        const timeout = setTimeout(() => {
            settled = true;
            next.src = '';
        }, FRAME_TIMEOUT_MS);

        next.referrerPolicy = 'no-referrer';
        next.decoding = 'async';

        next.onload = () => {
            clearTimeout(timeout);
            if (settled || !el.isConnected) return;
            img.src = next.src;
        };

        next.onerror = () => clearTimeout(timeout);
        next.src = base.toString();
    }

    /* ------------------------------------------------------------ theatre -- */

    /**
     * The white label player, in a dialog.
     *
     * **Appended to `<body>`, deliberately.** The shelf lives inside
     * `<section class="affiliates">`, which carries `position: relative;
     * z-index: 2` and is therefore a stacking context — a dialog nested in
     * there paints at level 2 however high its own `z-index` is, which is the
     * bug that put an ad over the performer bio card. Being a child of the
     * shelf bought this nothing anyway: it is `position: fixed`.
     *
     * The frame is **created on open and destroyed on close**, which is what
     * actually stops the stream. Hiding it leaves a live video decoding behind
     * a `display: none`.
     */
    _openTheatre(room, anchor) {
        this._closeTheatre();

        this.returnFocusTo = anchor;

        const el = document.createElement('div');
        el.className = 'cam-theatre';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', `${room.name}, live`);

        el.innerHTML = `
            <div class="cam-theatre-backdrop" data-close></div>
            <div class="cam-theatre-box">
                <div class="cam-theatre-head">
                    <h2>${escapeHtml(room.name)}</h2>
                    ${room.vr ? '<span class="cam-badge vr">VR</span>' : ''}
                    ${room.hd ? '<span class="cam-badge hd">HD</span>' : ''}
                    ${
                        room.viewers
                            ? `<span class="cam-theatre-viewers">${room.viewers.toLocaleString()} watching</span>`
                            : ''
                    }
                    <button type="button" class="cam-theatre-close" data-close
                            aria-label="Close">${icons.close({ size: 20 })}</button>
                </div>
                <div class="cam-theatre-stage"></div>
                <div class="cam-theatre-foot">
                    ${room.subject ? `<p class="cam-subject">${escapeHtml(room.subject)}</p>` : ''}
                    <a class="cam-theatre-out" href="${escapeHtml(room.href)}"
                       target="_blank" rel="${AFFILIATE_LINK_REL}">
                        Open at Chaturbate ${icons.external({ size: 12 })}
                    </a>
                </div>
                <p class="cam-theatre-note">
                    Streamed by Chaturbate. Paid link — we earn a commission on
                    anything you spend there, at no extra cost to you.
                </p>
            </div>`;

        const frame = document.createElement('iframe');
        frame.src = room.embed;
        frame.title = `${room.name}, live from Chaturbate`;
        frame.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'origin';

        // `allow-top-navigation` is the one omitted on purpose, and it is the
        // whole point of the attribute: a third-party frame that can navigate
        // the top window can replace this site with anything. `allow-popups`
        // plus `allow-popups-to-escape-sandbox` is what the player's own
        // "join" links use instead, so they open a tab rather than nothing.
        // `allow-same-origin` is required — their player stores session state
        // — and it means this sandbox is a navigation guard, not a jail.
        frame.setAttribute(
            'sandbox',
            'allow-scripts allow-same-origin allow-forms allow-popups ' +
                'allow-popups-to-escape-sandbox allow-presentation'
        );

        el.querySelector('.cam-theatre-stage').append(frame);
        document.body.append(el);
        document.body.classList.add('cam-theatre-open');

        el.addEventListener('click', (event) => {
            if (event.target.closest('[data-close]')) this._closeTheatre();
        });

        this.onKeydown = (event) => {
            if (event.key === 'Escape') {
                this._closeTheatre();
                return;
            }

            if (event.key !== 'Tab') return;

            // Focus trap. Only two things in here are focusable — close and
            // the outbound link — so this is a two-element cycle rather than
            // a general implementation, and the iframe is intentionally not
            // in it: focus inside a cross-origin frame is the frame's to
            // manage and Tab cannot be observed leaving it.
            const stops = [...el.querySelectorAll('button, a[href]')];
            if (!stops.length) return;

            const first = stops[0];
            const last = stops[stops.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', this.onKeydown);

        this.theatre = el;
        el.querySelector('.cam-theatre-close')?.focus();
    }

    _closeTheatre() {
        if (!this.theatre) return;

        if (this.onKeydown) document.removeEventListener('keydown', this.onKeydown);
        this.onKeydown = null;

        this.theatre.remove();
        this.theatre = null;
        document.body.classList.remove('cam-theatre-open');

        // Back where it came from, or the next Tab starts at the top of the
        // document and the row the visitor was working through is lost.
        this.returnFocusTo?.focus?.();
        this.returnFocusTo = null;
    }

    /** Release everything that outlives a render: timers, observers, listeners. */
    destroy() {
        this._stopRefresh();
        this._closeTheatre();
        this.observer?.disconnect();
        this.observer = null;

        if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
        this.onVisibility = null;

        this.onScreen.clear();
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
