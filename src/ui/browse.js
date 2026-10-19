import * as pc from 'playcanvas';
import { brandLockup } from './brand-mark.js';
import { isCreator } from '../auth/roles.js';
import { icons } from './icons.js';
import { formatDuration, pickHero, searchCatalog } from '../catalog/catalog.js';
import {
    AFFILIATE_GROUPS,
    AFFILIATE_LINK_REL,
    AFFILIATE_STOREFRONTS,
    fetchAffiliates,
    storefrontUrl
} from '../catalog/affiliates.js';
import { AFFILIATES_ONLY, COMING_SOON_SHELVES } from '../site-mode.js';
import { adSlotHtml, bioCardAdHtml, fillAdSlots, nativeStripHtml } from '../ads/juicyads.js';
import { CamShelf, camSkeletonHtml, camsExpected } from './cams.js';
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

/** How long the partner's promo banner holds each slide. Their feed asks 3s. */
const PITCH_INTERVAL_MS = 3000;

/**
 * How long a pointer must rest on a performer before their profile opens.
 *
 * Profiles are now preloaded in a single request on first render, so in the
 * ordinary case this buys nothing and is purely a UI control: long enough
 * that dragging the pointer across the row does not flash ten cards, short
 * enough that stopping to look feels like it responded.
 *
 * It remains a spending control for the one case a preload cannot cover — a
 * performer the chart has added since the last biography was written, whose
 * first hover anywhere in the world buys one.
 */
const HOVER_DELAY_MS = 350;

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

        // Decided once, used twice. `adSlotHtml` returns '' below the
        // placement's own floor, so this is also the answer to "is there a
        // skyscraper on this page" — and `has-sky-rail` hands that one answer
        // to the stylesheet, which uses it to inset the main column by the
        // width of the rail.
        //
        // Deliberately not a media query. The floor would then be the same
        // number written in `zones.js` and in `netflix.css`, and the failure
        // when those drift is either a 200px gutter reserved for nothing or
        // an advertisement sitting on top of a shelf.
        const skyscraper = adSlotHtml('top-skyscraper');
        const mainClass = [AFFILIATES_ONLY && 'affiliates-only', skyscraper && 'has-sky-rail']
            .filter(Boolean)
            .join(' ');

        this.mount.innerHTML = `
            ${this._headerHtml()}
            <main id="browse-main" class="${mainClass}">
                <!-- Full mode only. In affiliate-only mode the same group is
                     in the header next to the brand, and emitting it here as
                     well would put both pills on the page twice. -->
                ${AFFILIATES_ONLY ? '' : this._mastheadHtml()}
                ${AFFILIATES_ONLY ? '' : '<div id="billboard-slot"></div>'}
                ${this._camShelfHtml()}

                <!-- Below the cam shelf, not above it. The skyscraper is
                     already drawing at the top of this screen, and a 728x90
                     directly under the header would make the first two
                     things on the page both advertisements. See the note on
                     this placement in \`zones.js\`. -->
                ${adSlotHtml('top-leaderboard')}

                <section class="affiliates" id="affiliates" hidden>
                    <div class="shelf-head affiliates-head">
                        <h2>Partner sites</h2>
                        <span class="affiliates-disclosure">
                            Paid links. We earn a commission on sales, at no extra cost to you.
                        </span>
                    </div>
                    <div id="affiliate-pitch"></div>
                    <div id="affiliate-groups"></div>
                </section>
                ${AFFILIATES_ONLY ? this._comingSoonHtml() : this._ownContentHtml()}

                <!-- Last in the document and first on the screen: it is
                     positioned, so where it paints has nothing to do with
                     where it sits here. This is the reading order, and an
                     advertisement belongs at the end of it. -->
                ${skyscraper}
            </main>
            ${AFFILIATES_ONLY ? '' : this._modalHtml()}

            <!-- Outside <main>, and specifically outside .affiliates, which
                 carries \`position: relative; z-index: 2\` and so is a stacking
                 context. Nested in there, the card's own z-index was scoped to
                 that context and the whole card painted at level 2 — under
                 anything on the page above it, including an ad. It is
                 \`position: fixed\` and placed by script, so being a descendant
                 of the section bought it nothing to begin with. -->
            <div id="star-bio" class="star-bio" role="dialog"
                 aria-label="Performer profile" hidden></div>
        `;

        this.header = this.mount.querySelector('.site-header');
        this.shelvesEl = this.mount.querySelector('#shelves');
        this.modalEl = this.mount.querySelector('#detail-modal');
        this.creatorsEl = this.mount.querySelector('#live-creators');
        this.recordingsEl = this.mount.querySelector('#recordings-shelf');
        this.billboardEl = this.mount.querySelector('#billboard-slot');
        this.affiliatesEl = this.mount.querySelector('#affiliates');
        this.camShelfEl = this.mount.querySelector('#cam-shelf');

        // Not queried: `_renderFootAds` creates it. Cleared here because the
        // line above has just replaced the whole mount, so anything a previous
        // pass built is now detached.
        this.footAdsEl = null;

        // Timers, an IntersectionObserver and two document-level listeners,
        // all pointing at nodes the line above just detached.
        this.cams?.destroy();
        this.cams = this.camShelfEl ? new CamShelf(this.camShelfEl) : null;

        this._renderAffiliates();

        // Before the early return: the browse controls are emitted in both
        // site modes — in the header in one and in `.masthead` in the other —
        // so binding them after it would leave the cam button dead in the one
        // mode that is currently live.
        this._bindMasthead();

        // Again here, because `_renderAffiliates` returns immediately when
        // there is no affiliate section at all — and the top leaderboard is a
        // child of `<main>`, above that section, so it is drawn and fillable
        // either way. `fillAdSlots` marks what it has registered, so the two
        // calls do not double-count an impression.
        fillAdSlots(this.mount);

        // Everything below needs markup that affiliate-only mode did not emit.
        // Returning here rather than null-guarding each one keeps the single
        // reason they are all skipped in one readable place — and three of the
        // binds below would throw on a missing element rather than no-op.
        if (AFFILIATES_ONLY) return;

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

    /**
     * Our own surfaces, in the mode where none of them have anything in them.
     *
     * Rendered instead of `_ownContentHtml`, never alongside it — the two
     * carry the same headings, and the one thing worse than an empty Live
     * Creators row is two of them. See `COMING_SOON_SHELVES` in
     * `src/site-mode.js` for the content and for the rules it was written
     * under; this method is only the markup.
     *
     * ## Inert, and inert in the ways that matter
     *
     * - `aria-hidden` on the track and nothing focusable inside it, so a
     *   keyboard tabs straight past the placeholders instead of landing on
     *   six identical empty cards.
     * - No ids. The real shelves own `#live-creators`, `#recordings-shelf`
     *   and `#shelves`, and `_renderCreators` and friends look those up by
     *   id. Reusing them here would let a stray call in the wrong mode write
     *   real content into a placeholder.
     * - `pointer-events: none` in the CSS rather than a click handler that
     *   swallows events, because there is nothing to swallow: these are
     *   `<div>`s, not controls.
     *
     * The section itself stays reachable to a screen reader by its heading
     * and its "Coming Soon!" badge — the point is that the site does this,
     * not yet, and a visitor using a screen reader needs that as much as a
     * visitor looking at a dimmed row does.
     */
    _comingSoonHtml(shelves = COMING_SOON_SHELVES) {
        if (!shelves.length) return '';

        return `
            <div class="shelves coming-soon-shelves">
                ${shelves.map((s) => this._comingSoonShelfHtml(s)).join('')}
            </div>`;
    }

    /** One inert shelf: a heading, the badge, a line of copy, and shapes. */
    _comingSoonShelfHtml({ title, blurb, cards }) {
        // A count draws blank cards; a list of strings draws labelled ones.
        // The labelled form exists for the format shelf, where the words are
        // facts about the pipeline rather than a sample of a catalogue.
        const labels = Array.isArray(cards) ? cards : Array.from({ length: cards }, () => '');

        const deck = labels
            .map(
                (label, i) => `
                <div class="card soon-card" style="--soon-i:${i}">
                    <div class="soon-art">${
                        label ? `<span class="soon-label">${escapeHtml(label)}</span>` : ''
                    }</div>
                </div>`
            )
            .join('');

        return `
            <section class="shelf soon-shelf">
                <div class="shelf-head soon-head">
                    <h2>${escapeHtml(title)}</h2>
                    <span class="badge soon">Coming Soon!</span>
                </div>
                <p class="soon-blurb">${escapeHtml(blurb)}</p>
                <div class="shelf-viewport">
                    <div class="shelf-track soon-track" aria-hidden="true">${deck}</div>
                </div>
            </section>`;
    }

    /** Our own surfaces: the billboard's neighbours, and the catalogue. */
    _ownContentHtml() {
        return `
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
        `;
    }

    /* ----------------------------------------------------------- cams -- */

    /**
     * The live cam shelf, reserved at its final height before it has loaded.
     *
     * In the first-paint template rather than created later because it sits
     * above the partner section: a shelf that appears after the page has
     * painted pushes everything below it down, which is the layout shift
     * `_renderFootAds` goes to some length to avoid further down the page.
     * The rest of the reasoning, including why this is sometimes skipped
     * entirely, is in `camsExpected`.
     */
    _camShelfHtml() {
        if (!camsExpected()) return '';

        return `
            <section class="shelf cam-shelf is-loading" id="cam-shelf" data-nosnippet>
                ${camSkeletonHtml()}
            </section>`;
    }

    /**
     * Rooms broadcasting right now, from a partner's affiliate feed.
     *
     * Separate from `refreshAffiliates` because the two have nothing in
     * common but the word partner: that one is a static catalogue fetched
     * once, this one is a list that is wrong within the minute and is
     * proxied by our own server. A failure in either must not take the other
     * down, which is why they are not awaited together.
     */
    async refreshCams() {
        await this.cams?.refresh();

        // The shelf hides itself when the feed is empty or the partner is
        // unconfigured, and the Live Cams button points at it.
        this._syncCamsButton();
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
        if (AFFILIATES_ONLY) return;

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

    /* ------------------------------------------------- affiliate partners -- */

    /**
     * Other operators' catalogues, at the top of the page.
     *
     * **Shown to everyone, including signed-out visitors** — David's call on
     * 2026-10-18, overriding an earlier version that required `ageAssurance`
     * first. So these rows render for a visitor our own catalogue would still
     * be withheld from, and they are the one surface on the front page that
     * does. Worth knowing before changing it back or extending it: the
     * twenty-seven states in `docs/STATE-AGE-LAWS.md` legislate about exactly
     * this kind of artwork, and the gate is the mechanism that was answering
     * for it.
     *
     * Loaded once, not polled, and not session-dependent: there is nothing
     * about a partner's "newest" row that changes when somebody signs in, and
     * these are somebody else's servers.
     */
    async refreshAffiliates() {
        if (!this.affiliatesEl) return;

        // Already loaded. Re-rendering is free; re-fetching somebody else's
        // API because this page re-rendered is not.
        if (this.affiliateRows?.length) {
            this._renderAffiliates();
            return;
        }

        try {
            this.affiliateRows = await fetchAffiliates();
        } catch {
            // `fetchAffiliates` already isolates per-partner failures, so
            // reaching here means something systemic. A front page says
            // nothing about it: there is no partner row, and that is all.
            this.affiliateRows = [];
        }

        this._renderAffiliates();
    }

    _renderAffiliates() {
        if (!this.affiliatesEl) return;

        const rows = this.affiliateRows ?? [];
        this.affiliatesEl.hidden = rows.length === 0;

        if (!this.affiliatesEl.hidden) {
            // Grouped by kind, in the order `AFFILIATE_GROUPS` declares, and a
            // group with no programs in it is not drawn at all. That is what
            // lets a live-cams deal be a single entry in the registry later
            // on. `pitch` has no entry there because it is a banner rather
            // than a row, so it falls out of this loop and is drawn
            // separately below.
            const groups = AFFILIATE_GROUPS.map((group) => {
                const inGroup = rows.filter((row) => row.program.kind === group.kind);
                if (!inGroup.length) return '';

                return `
                    <div class="affiliate-group">
                        <h3 class="affiliate-group-label">${escapeHtml(group.label)}</h3>
                        ${inGroup.map((row) => this._affiliateShelfHtml(row)).join('')}
                    </div>`;
            }).filter(Boolean);

            // The billboard goes *between* two groups, never after the last
            // one. Filtering first is what makes that true: groups with no
            // programs render nothing, so "after the first group" has to mean
            // the first one that actually drew, or an empty Live cams group
            // would put the ad at the top. With fewer than two groups there is
            // no between, and the foot slot already covers the end of the page.
            const billboard = adSlotHtml('mid-billboard');
            if (billboard && groups.length > 1) groups.splice(1, 0, billboard);

            // And `pitch-billboard` at the head of them, which puts it
            // directly under the promo banner in `#affiliate-pitch`.
            //
            // Built here rather than written into `_render`'s template for
            // the reason `_renderFootAds` explains at length: this section
            // ships `hidden` and un-hides when the feed answers. An `<ins>`
            // registered while its section is `display: none` is an
            // impression for an advertisement nobody could have seen.
            const pitch = adSlotHtml('pitch-billboard');
            if (pitch) groups.unshift(pitch);

            this.affiliatesEl.querySelector('#affiliate-groups').innerHTML = groups.join('');

            this._bindShelfArrows(this.affiliatesEl);
            this._renderPitch(rows.find((row) => row.program.kind === 'pitch'));
            this._bindStarBios();
        }

        // Last, and on both paths. This is the point at which the partner
        // section has taken whatever height it is going to have, which is what
        // the slots below it need before they can be drawn.
        this._renderFootAds();
    }

    /**
     * The slots that sit below the partner section.
     *
     * Built here rather than written into `_render`'s template, and the reason
     * is measured rather than theoretical. `<section class="affiliates">` ships
     * `hidden` and un-hides when the feed answers, around 700ms in. Anything
     * already sitting below it at first paint is shoved down the page at that
     * moment: with these two slots in the template it measured 0.27 to 0.43
     * CLS depending on viewport, against a 0.1 threshold. The ads were not the
     * thing that arrived late — they were the thing that got moved.
     *
     * Two things are load-bearing, and both were arrived at by measuring the
     * version without them.
     *
     * The container is **created** here rather than sitting empty in the
     * template waiting to be filled. An empty div still has a position at
     * first paint, so when the section above expands it both moves and gains
     * height in the same frame, and the shift is scored against the box it
     * ends up as — an empty placeholder measured 0.29 to 0.36, no better than
     * the markup it replaced. A node appended after the fact has no previous
     * position and contributes nothing.
     *
     * And it is not created until the feed has **answered**, which is what
     * `settled` is for. `_renderAffiliates` runs once at startup, before
     * anything has been fetched, so creating on that pass puts the container
     * at a position the section above is about to invalidate — which is the
     * same shift again, 0.36, now attributed to a node that was created
     * dynamically and still too early. `affiliateRows` is `undefined` in
     * flight and an array once it is not, so it distinguishes "no answer yet"
     * from "answered with nothing", and only the first of those is a reason
     * to wait.
     *
     * Reserving space for the partner section up front would also work, and
     * would mean guessing the height of a feed that has not answered yet and
     * then shifting by the error in the guess.
     *
     * These stay outside the partner section rather than being appended to it,
     * which is what the `hidden` path above is for: if no partner answers, the
     * section stays empty and these are still drawn. A partner outage should
     * not take the ad inventory down with it.
     *
     * Drawn once. A second pass would discard filled iframes and push the same
     * zones onto the queue again, which is the network counting one impression
     * twice. `fillAdSlots` still runs on every pass, for the billboard the
     * partner section rebuilds above.
     *
     * (If `AFFILIATES_ONLY` is ever turned off, the shelves restored below the
     * partner section settle on their own schedule and this lands under them —
     * it would need the same treatment keyed to those instead.)
     */
    _renderFootAds() {
        const main = this.mount.querySelector('#browse-main');
        const settled = this.affiliateRows !== undefined;

        if (main && settled && !this.footAdsEl) {
            const html = nativeStripHtml() + adSlotHtml('footer-leaderboard');

            if (html) {
                this.footAdsEl = document.createElement('div');
                this.footAdsEl.id = 'foot-ads';
                this.footAdsEl.innerHTML = html;
                main.appendChild(this.footAdsEl);
            }
        }

        fillAdSlots(this.mount);
    }

    /* ------------------------------------------------------ pitch banner -- */

    /**
     * The partner's rotating promo banner.
     *
     * Every slide is in the DOM from the start and the rotation is a class
     * swap, so there is no layout shift when it advances and no second network
     * request when it comes back round. Images after the first are lazy, which
     * is the only reason holding five of them is cheap.
     *
     * Three behaviours worth keeping if this is rewritten: it pauses while the
     * pointer is over it (a banner that navigates out from under a click is
     * the single most annoying thing a carousel does), it stops entirely under
     * `prefers-reduced-motion`, and it stops when the tab is hidden rather
     * than quietly advancing for an hour in a background tab.
     */
    _renderPitch(row) {
        const slot = this.affiliatesEl?.querySelector('#affiliate-pitch');
        if (!slot) return;

        clearInterval(this._pitchTimer);
        this._pitchTimer = null;

        const items = row?.items ?? [];
        slot.hidden = items.length === 0;
        if (slot.hidden) {
            slot.innerHTML = '';
            return;
        }

        // The partner's own widget randomises, and their feed asks for it. The
        // order is fixed once per page load rather than per tick, so the
        // sequence stays stable while somebody is looking at it.
        const order = items.map((_, i) => i);
        for (let i = order.length - 1; i > 0; i -= 1) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        slot.innerHTML = `
            <div class="pitch" aria-label="${escapeHtml(row.program.partner)} promotions">
                ${order
                    .map((idx, pos) => this._pitchSlideHtml(items[idx], pos === 0))
                    .join('')}
            </div>`;

        const pitch = slot.querySelector('.pitch');
        const slides = [...pitch.querySelectorAll('.pitch-slide')];
        if (slides.length < 2) return;

        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (still) return;

        let at = 0;
        let paused = false;

        // The offscreen slides are stacked underneath the visible one, so
        // without this they stay in the tab order and a screen reader reads
        // five promos where the page shows one. Visibility and exposure have
        // to move together, which is why this is one function and not a
        // class toggle with the attributes set once at render.
        const show = (i, on) => {
            slides[i].classList.toggle('is-current', on);
            slides[i].toggleAttribute('aria-hidden', !on);
            if (on) slides[i].removeAttribute('tabindex');
            else slides[i].setAttribute('tabindex', '-1');
        };

        this._pitchTimer = setInterval(() => {
            if (paused || document.hidden) return;
            show(at, false);
            at = (at + 1) % slides.length;
            show(at, true);
        }, PITCH_INTERVAL_MS);

        pitch.addEventListener('pointerenter', () => {
            paused = true;
        });
        pitch.addEventListener('pointerleave', () => {
            paused = false;
        });
        pitch.addEventListener('focusin', () => {
            paused = true;
        });
        pitch.addEventListener('focusout', () => {
            paused = false;
        });
    }

    _pitchSlideHtml(item, current) {
        return `
            <a class="pitch-slide${current ? ' is-current' : ''}"
               href="${escapeHtml(item.href)}"
               target="_blank" rel="${AFFILIATE_LINK_REL}"
               ${current ? '' : 'tabindex="-1" aria-hidden="true"'}>
                <img src="${escapeHtml(item.image)}" alt=""
                     loading="${current ? 'eager' : 'lazy'}"
                     decoding="async" referrerpolicy="no-referrer" />
                ${item.title ? `<span class="pitch-caption">${escapeHtml(item.title)}</span>` : ''}
            </a>`;
    }

    /* ------------------------------------------------ the browse controls -- */

    /**
     * The two places a visitor can go, and the sentence that discloses one.
     *
     * ## The disclosure travels with the links. It is not optional
     *
     * The storefront links used to live in the partner section's head, and
     * the reason was compliance rather than layout: `AFFILIATE_LINK_REL`
     * declares a link paid to a crawler, but a reader needs telling too, and
     * the sentence that does it is in that head. Moving the links above it
     * would have made them undisclosed paid links to everyone who had not
     * scrolled down yet — which is now everyone, because they are the first
     * thing on the page.
     *
     * So the disclosure comes with them, in this one group, in whichever
     * place the group is mounted. Delete `.browse-disclosure` and these
     * become the most prominent undisclosed affiliate links on the site. It
     * renders only when there is a storefront to disclose, so the rule and
     * the thing it covers appear and disappear together and cannot drift.
     *
     * That coupling is also the whole reason this is one builder rather than
     * two. In affiliate-only mode the group sits inside `.site-header`, which
     * is `position: fixed` — so had the links gone up alone and the sentence
     * stayed in the body, the paid links would be on screen at every scroll
     * position and their disclosure would not. Keeping them in one subtree
     * makes that failure impossible to introduce by moving a mount point.
     *
     * ## Two mount points, one group
     *
     * Affiliate-only mode puts it in the header, beside the brand: these are
     * the only navigation that mode has, and the header is where a reader
     * looks for navigation. Full mode keeps it in the body as `.masthead`,
     * below a header that is already full of catalogue controls.
     *
     * In full mode it lands above the hero, which is worth a second look
     * whenever `AFFILIATES_ONLY` is turned off — an affiliate link above our
     * own hero is the wrong ranking once there is something of our own to
     * rank against. `src/site-mode.js` says the same about the partner
     * section, for the same reason.
     */
    _browseNavHtml(storefronts = AFFILIATE_STOREFRONTS) {
        const buttons = this._storefrontButtonsHtml(storefronts) + this._camsButtonHtml();
        if (!buttons) return '';

        // Singular or plural with the count, because one link reading "Paid
        // links" is the kind of boilerplate a reader learns to skip.
        const noun = storefronts.length === 1 ? 'link' : 'links';
        const disclosure = storefronts.length
            ? `<p class="browse-disclosure">
                   Paid ${noun}. We earn a commission on sales, at no extra cost to you.
               </p>`
            : '';

        return `
            <div class="browse-nav-group">
                <nav class="browse-nav" aria-label="Browse">${buttons}</nav>
                ${disclosure}
            </div>`;
    }

    /**
     * The body mount for the browse controls, used in full mode only.
     *
     * Affiliate-only mode renders the same group into `.site-header` instead
     * — see `_headerHtml` — so this wrapper is never emitted there and the
     * two pills never appear twice.
     *
     * There is no advertisement in this row. There was for part of
     * 2026-10-18, a 908x258 at the right-hand end called `top-billboard`;
     * it is a 160x600 positioned down the right of the first screen now, not
     * in this row and not in the flow at all. See `top-skyscraper` in
     * `src/ads/zones.js`.
     */
    _mastheadHtml(storefronts = AFFILIATE_STOREFRONTS) {
        const nav = this._browseNavHtml(storefronts);
        return nav ? `<div class="masthead">${nav}</div>` : '';
    }

    /**
     * The partners' own storefronts, as primary buttons.
     *
     * An `<a>` and not a `<button>`: it navigates, so it must be
     * middle-clickable, copyable and visible to a crawler as the paid link
     * it is. `AFFILIATE_LINK_REL` carries the declaration.
     *
     * `label` is printed and `partner` is announced — see the note on the
     * two fields in `affiliates.js`. The `title` and the `aria-label` say
     * the same full sentence so a hover and a screen reader agree.
     *
     * Drawn from configuration, so no storefront configured means no markup
     * at all rather than an empty button.
     */
    _storefrontButtonsHtml(storefronts = AFFILIATE_STOREFRONTS) {
        return storefronts
            .map((s) => {
                const full = `${s.label} at ${s.partner} — paid link, opens in a new tab`;
                return `
                    <a class="pill pill-movies" href="${escapeHtml(storefrontUrl(s))}"
                       target="_blank" rel="${AFFILIATE_LINK_REL}"
                       title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}">
                        <span class="pill-icon">${icons.film({ size: 18 })}</span>
                        <span class="pill-text">${escapeHtml(s.label)}</span>
                    </a>`;
            })
            .join('');
    }

    /**
     * The jump to the live cam shelf.
     *
     * A `<button>` and not an `<a href="#cam-shelf">`, because it scrolls
     * within this page and a hash in the address bar would survive a reload
     * into a position the shelf may no longer occupy.
     *
     * Gated on `camsExpected()` — the same call that decides whether the
     * shelf is reserved at all — so the button and its destination are never
     * out of step on first paint. They can still diverge *after* the feed
     * answers, because an empty feed hides the shelf; `_syncCamsButton`
     * closes that gap, and is called from the same place the shelf is
     * refreshed.
     *
     * It deliberately does not link `cams.lustxr.com`. That host is the
     * Chaturbate white label, and linking it from an indexed page is the one
     * thing `docs/SEARCH.md` §5 rules out — `test/cams.test.js` fails the
     * build if our own hostnames ever become a cam link.
     */
    _camsButtonHtml() {
        if (!camsExpected()) return '';

        return `
            <button class="pill pill-cams" type="button" data-masthead="cams">
                <span class="pill-live" aria-hidden="true"></span>
                <span class="pill-text">Live Cams</span>
            </button>`;
    }

    /**
     * Hide the cam button when the shelf it points at has gone.
     *
     * `CamShelf._render` hides its mount when the partner is unconfigured or
     * nobody is broadcasting. A button that scrolls to a hidden element
     * scrolls nowhere, which reads as a broken control rather than as a
     * quiet night, so it follows the shelf exactly.
     */
    _syncCamsButton() {
        const btn = this.mount.querySelector('[data-masthead="cams"]');
        if (btn) btn.hidden = !this.camShelfEl || this.camShelfEl.hidden;
    }

    /**
     * Wire the masthead's one scripted control.
     *
     * Only the cam button needs anything: the storefront is an `<a>` and the
     * browser handles it.
     *
     * `scroll-margin-top` on the shelf does the offsetting, not an arithmetic
     * `scrollTo` here — the header is fixed and 96px or 128px depending on
     * the breakpoint, and duplicating that number in JavaScript is how it
     * ends up wrong at one of them. `behavior: 'smooth'` is left to the
     * browser, which already drops it for `prefers-reduced-motion`.
     */
    _bindMasthead() {
        const btn = this.mount.querySelector('[data-masthead="cams"]');
        if (!btn) return;

        btn.addEventListener('click', () => {
            if (!this.camShelfEl || this.camShelfEl.hidden) return;
            this.camShelfEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    _affiliateShelfHtml({ program, items }) {
        const stars = program.kind === 'stars';
        const card = stars
            ? (item) => this._starCardHtml(item)
            : (item) => this._affiliateCardHtml(item);

        return `
            <section class="shelf affiliate-shelf${stars ? ' star-shelf' : ''}">
                <div class="shelf-head">
                    <h2>${escapeHtml(program.title)}</h2>
                    <span class="badge partner">${escapeHtml(program.partner)}</span>
                </div>
                <div class="shelf-viewport">
                    <button class="shelf-arrow prev">${icons.chevronLeft({ size: 24 })}</button>
                    <div class="shelf-track">
                        ${items.map(card).join('')}
                    </div>
                    <button class="shelf-arrow next">${icons.chevronRight({ size: 24 })}</button>
                </div>
            </section>`;
    }

    /**
     * A performer: a face, a name, and a biography behind the hover.
     *
     * `data-star-id` is what the hover handler reads and what the server
     * validates its spend against, so a card without one is simply not
     * hoverable — which is the correct behaviour for a feed row that arrived
     * without an id rather than something to paper over with a fallback.
     */
    _starCardHtml(item) {
        return `
            <a class="card star-card" href="${escapeHtml(item.href)}"
               target="_blank" rel="${AFFILIATE_LINK_REL}"
               ${item.starId ? `data-star-id="${item.starId}"` : ''}>
                <div class="star-portrait">
                    <img src="${escapeHtml(item.image)}" alt="" loading="lazy"
                         decoding="async" referrerpolicy="no-referrer" />
                </div>
                <span class="star-name">${escapeHtml(item.title)}</span>
            </a>`;
    }

    /**
     * A real anchor, not a card with a click handler.
     *
     * Middle-click, open-in-new-tab, "copy link" and a screen reader all work
     * for free, and `rel` — which is the whole disclosure and safety story
     * here — only means anything on an anchor. What goes in it and why is
     * `AFFILIATE_LINK_REL`.
     */
    _affiliateCardHtml(item) {
        const minutes = item.durationMs ? formatDuration(item.durationMs / 1000) : '';

        return `
            <a class="card affiliate-card" href="${escapeHtml(item.href)}"
               target="_blank" rel="${AFFILIATE_LINK_REL}">
                <div class="affiliate-art">
                    <img src="${escapeHtml(item.image)}" alt="" loading="lazy"
                         decoding="async" referrerpolicy="no-referrer" />
                    ${minutes ? `<span class="card-duration">${minutes}</span>` : ''}
                </div>
                <div class="card-body">
                    <h3 class="card-title">${escapeHtml(item.title)}</h3>
                    <div class="card-meta">
                        <span>${escapeHtml(item.partner)}</span>
                        <span class="affiliate-go">${icons.external({ size: 12 })}</span>
                    </div>
                </div>
            </a>`;
    }

    /* -------------------------------------------- performer biographies -- */

    /**
     * Show a profile when the pointer rests on a performer.
     *
     * Bound on the section rather than on each card, and once per section
     * rather than once per render. `_renderAffiliates` replaces the rows
     * inside `#affiliates` but not `#affiliates` itself, and it runs again on
     * every refresh, so without the guard below each refresh adds another
     * full set of handlers to the same element — including one on `window`,
     * which nothing would ever remove.
     *
     * Measured, so it is not overstated: duplicate handlers do *not* buy the
     * biography twice, because each one clears the timer the last one set.
     * That is incidental rather than designed, and it is not what the guard
     * is for — the guard is for the unbounded listener growth behind it.
     *
     * **Resting, not passing.** `HOVER_DELAY_MS` is what makes the difference
     * between an intent to read and a mouse on its way somewhere else. With
     * profiles preloaded it is mostly a flicker control, but it is still a
     * spending control for a performer the chart added after the last
     * biography was written, and the in-flight request is aborted on the way
     * out, so a sweep costs nothing either way.
     *
     * Keyboard gets the same thing on focus, with no delay — arriving by tab
     * is already deliberate, and there is no sweeping to protect against.
     *
     * **The card is a dialog now, not a tooltip.** It holds an ad, which is a
     * link, and a tooltip containing something clickable is a tooltip nobody
     * can click: the role is wrong for assistive technology and the old
     * `pointer-events: none` made it literally true. Both are changed, and
     * the dismissal had to change with them — a card that vanishes on
     * `pointerout` cannot be reached by the pointer that would click it.
     * Outside click, Escape, or scrolling the row closes it.
     */
    _bindStarBios() {
        // Two different scopes on purpose. `root` is the section the performer
        // cards live in and is what the delegated listeners bind to; the card
        // itself is a sibling of that section rather than a child, so it has
        // to be looked up from the mount. See `_render` for why.
        const root = this.affiliatesEl;
        const card = this.mount.querySelector('#star-bio');
        if (!root || !card) return;

        this.starBios ??= new Map();
        this._preloadStarBios();

        // Transient state is reset on every render; the listeners below are
        // not. A row that was being hovered when the refresh landed should
        // not leave a request in flight against markup that no longer exists.
        clearTimeout(this._bioTimer);
        this._bioAbort?.abort();
        this._bioAbort = null;
        card.hidden = true;

        if (this._bioBoundTo === root) return;
        this._bioBoundTo = root;

        // Built once, for the lifetime of the card. Only `.star-bio-body` is
        // rewritten per performer — see `BIO_CARD_AD` in `zones.js` for why
        // the ad must not be, and `_showBio` for the one call that registers
        // it. `bioCardAdHtml()` is `''` when the zone is unconfigured, which
        // leaves the biography sitting directly above its disclaimer.
        card.innerHTML =
            '<div class="star-bio-body"></div>' +
            bioCardAdHtml() +
            '<p class="star-bio-source">Written by AI. May be incomplete or wrong.</p>';

        const body = card.querySelector('.star-bio-body');

        const hide = () => {
            clearTimeout(this._bioTimer);
            this._bioAbort?.abort();
            this._bioAbort = null;
            card.hidden = true;
            this._bioFor = null;
        };

        // Registered the first time the card is shown rather than at bind
        // time. `fillAdSlots` marks what it has pushed, so calling it on every
        // open is one impression per page load and not one per hover — but a
        // slot pushed while its container is `display: none` is a slot the
        // network can decline to draw, and the card ships hidden.
        const show = (anchor) => {
            this._place(card, anchor);
            card.hidden = false;
            fillAdSlots(card);
        };

        const open = async (anchor) => {
            const starId = Number(anchor.dataset.starId);
            if (!starId) return;

            this._bioFor = starId;

            // Preloading means this is a hit for every performer the chart
            // had a profile for when the page loaded, and the card opens in
            // the same frame as the pointer arriving. The spinner is left in
            // for the one that was added since.
            let bio = this.starBios.get(starId);

            if (!bio) {
                card.classList.add('is-loading');
                body.innerHTML = '<p class="star-bio-loading">Looking up…</p>';
                show(anchor);

                this._bioAbort = new AbortController();

                try {
                    const res = await fetch(`/api/stars/${starId}/bio`, {
                        signal: this._bioAbort.signal,
                        headers: { Accept: 'application/json' }
                    });

                    // 503 is "no key configured" and 404 is "chart moved on".
                    // Neither is worth a message on a hover card, and both are
                    // remembered so the next hover does not ask again.
                    bio = res.ok ? await res.json() : { known: false };
                } catch (err) {
                    if (err.name === 'AbortError') return;
                    bio = { known: false };
                }

                this.starBios.set(starId, bio);
            }

            // The pointer may have moved on while that was in the air.
            if (this._bioFor !== starId) return;

            if (!bio.known) {
                hide();
                return;
            }

            card.classList.remove('is-loading');
            body.innerHTML = this._starBioHtml(bio, anchor);
            show(anchor);
        };

        const enter = (event) => {
            const anchor = event.target.closest?.('.star-card[data-star-id]');
            if (!anchor || !root.contains(anchor)) return;

            clearTimeout(this._bioTimer);
            this._bioAbort?.abort();

            const delay = event.type === 'focusin' ? 0 : HOVER_DELAY_MS;
            this._bioTimer = setTimeout(() => open(anchor), delay);
        };

        /** Anything inside the card, or the performer it is describing. */
        const inside = (node) =>
            Boolean(node) && (card.contains(node) || Boolean(node.closest?.('.star-card')));

        // `pointerover` rather than `pointerenter`: it bubbles, which is what
        // makes one listener on the section work for every card in it.
        //
        // Not bound on a touch screen. `pointerover` fires on a tap there, so
        // every tap on a performer would flash a loading card on its way to
        // following the link — and buy a biography to show for a fifth of a
        // second. Keyboard is bound either way: `focusin` has no such
        // ambiguity, and a phone with a keyboard attached should still work.
        if (window.matchMedia?.('(hover: hover)')?.matches !== false) {
            root.addEventListener('pointerover', enter);
        }

        root.addEventListener('focusin', enter);

        // Outside click, not `pointerout`. The card holds an ad, and the only
        // way to reach an ad in a card that closes when the pointer leaves the
        // portrait is to not let go of the mouse — which is to say there is no
        // way to reach it.
        //
        // `pointerdown` rather than `click` so the card is gone before a
        // navigation starts, and on `document` because an outside click is by
        // definition not in this section.
        //
        // Note what this deliberately does *not* catch: a click inside the ad.
        // Events in a cross-origin iframe do not cross into this document, so
        // there is no event here to mistake for an outside click, and the card
        // stays put while the ad opens its own tab.
        document.addEventListener('pointerdown', (event) => {
            if (!card.hidden && !inside(event.target)) hide();
        });

        // The keyboard equivalent, and the replacement for the `focusout`
        // handler that used to do this. Focus landing somewhere else on the
        // page is as deliberate as clicking there.
        document.addEventListener('focusin', (event) => {
            if (!card.hidden && !inside(event.target)) hide();
        });

        // A card pinned to a position in the viewport is wrong the moment the
        // row scrolls under it, and the row scrolls on every arrow press.
        root.addEventListener('scroll', hide, { capture: true, passive: true });
        window.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
    }

    /**
     * Fetch every biography the server already has, in one request.
     *
     * Hovering used to be the only thing that fetched, which meant the first
     * rest on each of ten performers was ten round trips and ten spinners —
     * for text that, in the overwhelming majority of cases, was already
     * written and sitting on disk.
     *
     * **One request, not ten.** The per-star route is rate limited at 30 a
     * minute, so preloading by firing ten of it would spend a third of a
     * visitor's budget on page load and lock out anyone who reloads three
     * times. `/api/stars/bios` answers the whole row at once.
     *
     * **It cannot spend anything.** The bulk route serves what is cached and
     * nothing else; a performer it has no profile for is simply absent from
     * the response and falls through to the hover path, which is still the
     * only thing in this system that can commission a biography. That is what
     * keeps a page load from ever being able to cost ten OpenAI calls.
     *
     * Failure is silent and leaves the map empty, because the fallback is the
     * behaviour this site had yesterday.
     */
    _preloadStarBios() {
        if (this._bioPreload) return this._bioPreload;

        this._bioPreload = fetch('/api/stars/bios', { headers: { Accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : null))
            .then((payload) => {
                for (const [id, bio] of Object.entries(payload?.bios ?? {})) {
                    const starId = Number(id);
                    if (starId && !this.starBios.has(starId)) this.starBios.set(starId, bio);
                }
            })
            .catch(() => {});

        return this._bioPreload;
    }

    /**
     * The per-performer part of the card.
     *
     * Only this is replaced on each hover. The ad below it and the "Written
     * by AI" line below that are built once in `_bindStarBios` and outlive
     * every performer shown in the card — the ad because re-rendering it
     * would file an impression per hover, the disclaimer because it is a
     * fixed statement about the card and not about any one profile.
     *
     * That line is not decoration. A paragraph of confident career history
     * about a real person, in our own styling, under our own heading, reads
     * as something we are asserting — and it is a language model's
     * recollection, which is a different claim with a different error rate.
     * Saying so is the honest minimum, and it is why the model is also
     * allowed to answer "I don't know" rather than fill the space.
     */
    _starBioHtml(bio, anchor) {
        const name = bio.name || anchor.querySelector('.star-name')?.textContent || '';

        return `
            <h4 class="star-bio-name">${escapeHtml(name)}</h4>
            <p class="star-bio-text">${escapeHtml(bio.bio)}</p>
            ${
                bio.highlights?.length
                    ? `<ul class="star-bio-facts">${bio.highlights
                          .map((h) => `<li>${escapeHtml(h)}</li>`)
                          .join('')}</ul>`
                    : ''
            }`;
    }

    /**
     * Put the card beside the portrait, and keep it on screen.
     *
     * Positioned against the viewport (`position: fixed`) rather than against
     * the shelf, because the shelf is a scroll container with `overflow`
     * hidden on it — an absolutely positioned child would be clipped at the
     * first and last card, which are exactly the two the card most needs to
     * escape from.
     */
    _place(card, anchor) {
        const MARGIN = 12;
        const rect = anchor.getBoundingClientRect();

        // Measure before deciding: the card's height depends on how much the
        // model wrote, so it is not a constant to hard-code.
        card.style.visibility = 'hidden';
        card.hidden = false;
        const box = card.getBoundingClientRect();
        card.style.visibility = '';

        let left = rect.left + rect.width / 2 - box.width / 2;
        left = Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN));

        // Below the portrait by preference, above it when that would run off
        // the bottom — which is the usual case for the stars row, since it
        // sits near the top of the page.
        let top = rect.bottom + 10;
        if (top + box.height > window.innerHeight - MARGIN) {
            top = Math.max(MARGIN, rect.top - box.height - 10);
        }

        card.style.left = `${Math.round(left)}px`;
        card.style.top = `${Math.round(top)}px`;
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
        // No row to fill, so no timer and no requests. Guarded here rather
        // than at the call sites because `setMode` restarts polling every
        // time the player closes, and one missed call site is a poll that
        // runs forever against a page that cannot show the answer.
        if (AFFILIATES_ONLY) return;

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
        if (AFFILIATES_ONLY) return;

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
        if (!this.modalEl) return;

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

    /**
     * The fixed header.
     *
     * ## Affiliate-only mode carries navigation now, and did not before
     *
     * It was the brand and nothing else, because every other control here
     * acts on a catalogue this mode does not draw. Two things changed that
     * on 2026-10-18:
     *
     * The two places a visitor can actually go — the partner storefront and
     * the live cam shelf — came up here from a row in the body. They are
     * site navigation, and the header is where a reader looks for site
     * navigation; a row of pills below the fixed header was a second one.
     *
     * And the catalogue controls came back **inert**: drawn, dimmed, not
     * focusable, under a Coming Soon overlay. Same reasoning as the
     * placeholder shelves in `src/site-mode.js` — a page that shows only
     * paid partner rows reads as a site that does nothing of its own, and
     * the filters name the one thing this site does that no partner does.
     *
     * There is still no account control. That is not a Coming Soon: signing
     * in works today, `/creator` and `/profile` open the auth modal, and
     * putting "Coming Soon" over a feature that already exists would be the
     * one false label on the page.
     */
    _headerHtml() {
        if (AFFILIATES_ONLY) {
            return `
                <header class="site-header site-header-lite">
                    <div class="brand">${brandLockup({ symbolHeight: 68, wordmarkHeight: 42 })}</div>
                    ${this._browseNavHtml()}
                    ${this._headerSoonHtml()}
                </header>
            `;
        }

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
     * The catalogue controls in affiliate-only mode: drawn, dead, labelled.
     *
     * ## Why show a control that does nothing
     *
     * Because the alternative reads worse. With only partner rows on the
     * page, a header holding nothing but a logo says this is a links page.
     * The filters are the one thing here that no partner offers — sorting a
     * library by 180° dome, 360° sphere and flat — so drawing them, greyed,
     * says what the site is for rather than what it currently has. The
     * placeholder shelves in `src/site-mode.js` make the same trade.
     *
     * The honesty of it rests entirely on the overlay. A dimmed control with
     * no label is a bug; a dimmed control under "Coming Soon" is a roadmap.
     * `.header-soon-veil` is the label, it is a sibling rather than a
     * `::after` so it can carry the badge markup the rest of the site uses,
     * and it is the part of this that must not be deleted.
     *
     * ## These are copies, and they must not be mistaken for the originals
     *
     * Two attributes are deliberately absent, and a test pins each:
     *
     * - **No `data-filter`.** `_bindHeader` binds every `[data-filter]` in
     *   the mount. Today it is never called in this mode, but if
     *   `AFFILIATES_ONLY` is ever flipped back these would be wired up
     *   alongside the real nav and clicking a dead button would filter the
     *   page from behind a Coming Soon sign.
     * - **No `id="search-input"`.** That id is queried by exactly one
     *   `querySelector`, which returns the first match in document order —
     *   so a duplicate here would hand every search keystroke to the
     *   disabled copy.
     *
     * `disabled` stops the click, `tabindex="-1"` keeps them out of the tab
     * order, and `aria-hidden` on the groups keeps the whole dead set out of
     * the accessibility tree. The badge is outside that and stays readable,
     * with a `title` that says which features it covers — otherwise a screen
     * reader gets "Coming Soon" attached to nothing.
     */
    _headerSoonHtml() {
        const filter = (label) => `<button type="button" disabled tabindex="-1">${label}</button>`;

        return `
            <div class="header-soon">
                <nav class="site-nav" aria-hidden="true">
                    ${filter('Home')}
                    ${filter('VR')}
                    ${filter('180° dome')}
                    ${filter('360° sphere')}
                    ${filter('Standard')}
                    ${filter('My List')}
                </nav>
                <div class="header-right" aria-hidden="true">
                    <div class="search-box">
                        ${icons.search({ size: 16 })}
                        <input type="search" placeholder="Titles, formats, genres"
                            disabled tabindex="-1" />
                    </div>
                    <button class="icon-btn labelled" type="button" disabled tabindex="-1">
                        ${icons.cast({ size: 18 })}<span>Send to headset</span>
                    </button>
                </div>
                <div class="header-soon-veil">
                    <span class="badge soon"
                        title="Our own library, search and headset casting are not live yet">
                        Coming Soon!
                    </span>
                </div>
            </div>`;
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
                        isCreator(user.role)
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
        if (!this.shelvesEl) return;

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
    /**
     * @param {HTMLElement} [root] which subtree to wire; the catalogue shelves
     *   by default, the partner section when it re-renders its own rows.
     */
    _bindShelfArrows(root = this.shelvesEl) {
        if (!root) return;

        root.querySelectorAll('.shelf').forEach((shelf) => {
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
        // Affiliate-only mode emits no modal, and `setMode` calls this on
        // every return to the browse view. See `src/site-mode.js`.
        if (!this.modalEl) return;

        const wasOpen = this.modalEl.classList.contains('open');

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

        // Only on a real close: Escape fires this on every keypress with
        // nothing open, and the listener turns it into a URL change.
        if (wasOpen) this.fire('detailsClosed');
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
