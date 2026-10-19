import { icons } from './icons.js';
import { AFFILIATE_LINK_REL } from '../catalog/affiliates.js';

/**
 * Live cams: a shelf of rooms broadcasting right now, and a theatre to watch
 * one in without leaving the page.
 *
 * The feed is Chaturbate's affiliate API, proxied by `server/routes/cams.js` —
 * see that file for why it is proxied and what it strips. Everything here is
 * presentation, and there are two ideas in it:
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
 *
 * There is no VR filter, and this is measured rather than assumed. A sweep of
 * every room online on 2026-10-19 — 5,990 of them, 801 distinct tags — found
 * not one carrying any of the nineteen spellings in the route's `VR_TAGS`, and
 * the partner's own tag index returns a count of zero for all nineteen. The
 * room object has no VR field to read instead. A control whose answer is
 * always "none" is worse than no control: it is a promise the feed cannot
 * keep. The route still accepts `?vr=1` and still ranks VR first, so the day a
 * room does tag itself the shelf surfaces it without a change here — but until
 * that day nothing is drawn that implies there is a headset feed to filter.
 *
 * ## Searching
 *
 * The box in the head searches everything broadcasting, not the sixty rooms
 * the page happens to hold — `PAGE_MAX` in the route is a page size, not a
 * corpus. So a keystroke is a request, and the two things that makes awkward
 * are both handled here rather than papered over:
 *
 *   **It must not feel like a request.** Every keystroke redraws the row
 *   immediately from the rooms already in hand, and the answer from the
 *   server replaces that a fraction of a second later. The preview is always
 *   a subset of the real answer — it is the same query over fewer rooms — so
 *   it never shows a card the server would not have, and widens rather than
 *   corrects when the response lands.
 *
 *   **It must not take the caret.** {@link CamShelf._render} replaces the
 *   mount and runs once; {@link CamShelf._reflow} replaces only the row. Every
 *   path that can run while somebody is typing goes through the second one.
 *
 * The suggestions under the box are the partner's tag vocabulary, counted
 * server-side over the rooms a query would be run against — the browser holds
 * sixty rooms and could only ever suggest from those, which would offer
 * "blonde" and not the other two hundred tags that also work.
 */

/** How often a visible card asks for a new frame. */
const REFRESH_MS = 9_000;

/** And the one under the pointer, which is the one being decided about. */
const HOVER_REFRESH_MS = 2_500;

/** Give up on a frame rather than leave a half-loaded image pending forever. */
const FRAME_TIMEOUT_MS = 6_000;

/**
 * How long after the last keystroke the match count is announced.
 *
 * This delay is for the `role="status"` line alone. A live region that
 * updates per character reads every intermediate count aloud and turns typing
 * four letters into four interruptions. It is deliberately longer than
 * {@link QUERY_DEBOUNCE_MS}, so the number it settles on is the server's
 * answer and not the preview's.
 */
const COUNT_SETTLE_MS = 400;

/**
 * How long after the last keystroke the query is actually sent.
 *
 * Short enough that it reads as a pause rather than a wait, long enough that
 * typing a word at any human speed costs one request and not six. The row
 * itself does not wait for this — see {@link CamShelf._visible} — so the
 * delay is invisible except in what it saves.
 */
const QUERY_DEBOUNCE_MS = 220;

/** Rows in the suggestion list. Eight fits without scrolling on a phone. */
const SUGGEST_MAX = 8;

/**
 * Everything about a room that a typed query is allowed to match.
 *
 * The same fields `normalise` flattens into `search` server-side, rebuilt
 * here because the server strips that field before sending — it is three
 * hundred bytes a room to duplicate what is already on the card. This is only
 * used for the preview during the debounce window; the authoritative match is
 * the server's, and the two have to agree or the row would flicker between
 * two different answers to the same query.
 */
function haystack(room) {
    return [room.name, room.username, room.subject]
        .concat(room.tags || [], room.languages || [])
        .join(' ')
        .toLowerCase();
}

/** The words a query is, by the same rule the server applies to `?q=`. */
function terms(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

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
        this.query = '';
        this.configured = false;

        /** How many rooms matched upstream, which exceeds `rooms.length`. */
        this.matched = 0;

        /** The partner's tag vocabulary: `[{tag, count}]`, commonest first. */
        this.tags = [];

        /**
         * The query the server had already run when it sent {@link rooms}.
         *
         * The reconciliation point between the box and the row. While this
         * equals {@link query} the rooms in hand are the answer; once the box
         * has moved on, the difference is applied locally as a preview until
         * the next response catches up. See {@link _visible}.
         */
        this.applied = '';

        /** @type {Map<HTMLElement, {room: object, at: number}>} */
        this.onScreen = new Map();

        /** @type {{tag: string, count: number}[]} */
        this.suggestions = [];
        this.suggestAt = -1;

        this.frame = 0;
        this.timer = null;
        this.countTimer = null;
        this.queryTimer = null;
        this.inflight = null;
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
     * Load the feed and draw the shelf. Once, on arrival.
     *
     * Silent on every failure. An unconfigured deployment, a partner outage
     * and a blocked request are indistinguishable to a visitor and all three
     * have the same right answer: there is no cam row, and the page says
     * nothing about why.
     */
    async refresh() {
        if (!this.mount) return;

        const ok = await this._load('/api/cams');

        if (!ok) {
            this.configured = false;
            this.rooms = [];
        }

        rememberCams(this.configured && this.rooms.length > 0);

        this._render();
    }

    /**
     * Ask the server for what is in the box, and redraw the row.
     *
     * The other half of {@link refresh}: same endpoint, same parsing, but it
     * goes to {@link _reflow} rather than `_render`, because by the time this
     * runs there is a visitor with a caret in a box that must survive it.
     *
     * A failed or superseded request leaves the row exactly as it was. The
     * preview already on screen is a subset of the right answer, so showing
     * it for longer is the correct degraded state; blanking the shelf because
     * one keystroke's request was cancelled is not.
     */
    async _requery() {
        // Read once, up front. The box is state the visitor can change while
        // this is in the air, and what the response means is what was asked
        // for — not what is in the box by the time it arrives.
        const asked = this.query;

        const url = new URL('/api/cams', location.origin);

        if (asked) url.searchParams.set('q', asked);

        if (await this._load(url.pathname + url.search, asked)) this._reflow();
    }

    /**
     * One request, and the state it lands in. Returns whether it landed.
     *
     * Only ever one in flight. A superseded request is aborted rather than
     * left to finish, which costs nothing and removes the out-of-order case
     * entirely: without it, typing "ab" and having the "a" response arrive
     * second would leave the row showing the wrong query's rooms with no way
     * to notice. `AbortError` and a network failure are the same thing here
     * — no new rooms — and both are caught.
     *
     * `asked` is what the caller put in the URL, and it becomes {@link
     * applied} only once a response has actually landed. That is the line
     * that stops `_visible` filtering locally, so it must not be crossed by a
     * request that was aborted, failed, or is still in the air — any of which
     * would leave the row claiming to be narrowed by a query nothing ran.
     *
     * @param {string} path
     * @param {string} asked the query `path` encodes
     */
    async _load(path, asked = '') {
        this.inflight?.abort();
        this.inflight = new AbortController();

        try {
            const res = await fetch(path, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                signal: this.inflight.signal
            });

            if (!res.ok) throw new Error(String(res.status));

            const data = await res.json();

            this.configured = data?.configured === true;
            this.rooms = Array.isArray(data?.rooms) ? data.rooms : [];
            this.tags = Array.isArray(data?.tags) ? data.tags : [];

            // `??` and not `||`: zero matches is an answer, and falling
            // through to `rooms.length` would report the same zero anyway —
            // but an older server that does not send the field at all must
            // fall through, and `0 || x` cannot tell those two apart.
            this.matched = Number(data?.matched ?? this.rooms.length) || 0;

            this.applied = asked;

            return true;
        } catch {
            return false;
        }
    }

    /* ---------------------------------------------------------- rendering -- */

    /**
     * The whole shelf, from the feed up.
     *
     * Called once when the feed lands, and not again: nothing here is on a
     * timer. `_tick` refreshes thumbnails in place and never comes through
     * this method, which is what makes it safe for the head to hold a text
     * input — a periodic `innerHTML` here would take the caret with it.
     *
     * Narrowing the row is {@link _reflow}'s job for the same reason. This
     * method is the one that replaces the mount wholesale, so every path
     * that can run while somebody is typing has to avoid it.
     */
    _render() {
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
                <div class="cam-search">
                    ${icons.search({ size: 14 })}
                    <!-- The placeholder is cut to fit the box rather than the
                         box widened to fit it: this head already carries a
                         heading, a badge, a count and a disclosure, and a
                         wider field drops the disclosure onto its own line at
                         1280. The title says the longer version.

                         No backticks in this comment. It is inside a template
                         literal, so one closes the string — and that breaks
                         the build without breaking a test.

                         role=combobox with aria-autocomplete=list is the
                         pattern for a text field that offers suggestions it
                         does not require: the typed value stands on its own,
                         and the list is help rather than a set of permitted
                         answers. aria-expanded and aria-activedescendant are
                         maintained in _suggest and _suggestMove. -->
                    <input type="search" data-cam-query
                           value="${escapeHtml(this.query)}"
                           placeholder="Search rooms or tags"
                           aria-label="Search live rooms"
                           title="Search every room broadcasting now by name, tag, language or topic. Escape clears it."
                           role="combobox" aria-expanded="false"
                           aria-controls="cam-suggest" aria-autocomplete="list"
                           autocomplete="off" autocapitalize="off" spellcheck="false" />
                    <!-- Populated on focus and on every keystroke, and left
                         in the document when empty rather than created and
                         destroyed, so aria-controls always resolves. -->
                    <ul class="cam-suggest" id="cam-suggest" role="listbox"
                        aria-label="Tag suggestions" hidden></ul>
                </div>
                <!-- Empty until a query narrows the row, so the normal case
                     is not a number nobody asked for, and a screen reader is
                     told only about a change the visitor caused. -->
                <p class="cam-count" role="status" aria-live="polite"></p>
                <span class="affiliates-disclosure cam-disclosure">
                    Paid links. We earn a commission, at no extra cost to you.
                </span>
            </div>
            <div class="shelf-viewport">
                <button class="shelf-arrow prev" type="button" aria-label="Scroll left">
                    ${icons.chevronLeft({ size: 24 })}
                </button>
                <div class="shelf-track cam-track"></div>
                <button class="shelf-arrow next" type="button" aria-label="Scroll right">
                    ${icons.chevronRight({ size: 24 })}
                </button>
            </div>`;

        this._bind();
        this._reflow();
        this._startRefresh();
    }

    /**
     * Redraw the row for what is in the box, and nothing else.
     *
     * Only `.cam-track`'s children are replaced. The track element itself
     * survives, which matters twice over: it carries the delegated click and
     * hover listeners {@link _bind} attached, so they are not rebound and do
     * not accumulate — and the head above it survives too, so the input the
     * visitor is typing into keeps its caret, its selection and its focus.
     */
    _reflow() {
        const track = this.mount.querySelector('.cam-track');
        if (!track) return;

        const rooms = this._visible();

        // It points at a card this is about to detach, and a stale value
        // would hold one dead node on the fast hover refresh forever.
        this.hovered = null;

        // "broadcasting right now" and not "on the shelf": the query ran
        // against everything online, so a visitor who gets nothing back has
        // been told something true about the whole catalogue rather than
        // about the sixty rooms that happened to be in the browser.
        track.innerHTML = rooms.length
            ? rooms.map((room) => this._cardHtml(room)).join('')
            : `<p class="cam-none">${
                  this.query
                      ? `Nothing broadcasting right now matches
                         &ldquo;${escapeHtml(this.query)}&rdquo;.
                         Try a shorter word, or clear the box.`
                      : 'No rooms to show right now.'
              }</p>`;

        this._watchVisibility();
        this._countLater();
    }

    /**
     * Say how many rooms matched, once the typing has stopped.
     *
     * Deferred rather than written straight out — see {@link COUNT_SETTLE_MS},
     * which outlasts {@link QUERY_DEBOUNCE_MS} precisely so the number this
     * settles on is the server's and not the preview's. Everything is read
     * inside the timer for the same reason: a count captured at the call site
     * would be the count of a row that has since been replaced.
     *
     * This is the only live region on the shelf, which is why the empty case
     * is written here as well as in the row: the sentence `_reflow` puts in
     * the track is inserted into a part of the page nothing is listening to,
     * so on its own it is visible and silent.
     */
    _countLater() {
        clearTimeout(this.countTimer);

        this.countTimer = setTimeout(() => {
            const el = this.mount.querySelector('.cam-count');
            if (!el) return;

            // What is actually in the row, rather than what was counted on
            // the way in: a response landing between the two would have
            // replaced the cards this is describing.
            const shown = this.mount.querySelectorAll('.cam-card').length;

            // `matched` belongs to the last query the server answered. If
            // the box has moved on since, the row on screen is the local
            // preview and the only honest number is the one in front of us.
            const total = this.applied === this.query ? this.matched : shown;

            if (!this.query) el.textContent = '';
            else if (!shown) el.textContent = 'No matches';
            // More matched than one page holds. Said plainly, because a bare
            // "60 rooms" against a query that found two hundred is a number
            // that happens to equal `PAGE_MAX` every time and reads as a
            // coincidence until you notice it never changes.
            else if (total > shown) el.textContent = `Top ${shown} of ${total}`;
            else el.textContent = `${shown} ${shown === 1 ? 'room' : 'rooms'}`;
        }, COUNT_SETTLE_MS);
    }

    /**
     * The rooms to draw: whatever the server has not already narrowed.
     *
     * The real search is the server's, over everything broadcasting. This
     * covers the gap between a keystroke and its answer, and the reason it
     * is safe to show is that it can only ever be too small.
     *
     * Adding a letter narrows an already-narrowed set, which is a subset of
     * the correct answer — the visitor sees fewer cards for a fifth of a
     * second and then more arrive. Removing one cannot widen what is in
     * hand, so the row simply holds still until the response lands. Neither
     * case ever puts up a card that does not match what is in the box, which
     * is the only property that would be worth a spinner to protect.
     *
     * Terms are ANDed, matching {@link matchesQuery} in the route, because
     * two words typed into one box mean "both" to everybody who has ever
     * used one — and because a preview that disagreed with the answer
     * replacing it would read as the row flickering between two opinions.
     */
    _visible() {
        if (this.query === this.applied) return this.rooms;

        const want = terms(this.query);
        if (!want.length) return this.rooms;

        return this.rooms.filter((room) => {
            const hay = haystack(room);
            return want.every((term) => hay.includes(term));
        });
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

    /* -------------------------------------------------------- suggestions -- */

    /**
     * The box, split into the words that are finished and the one that is not.
     *
     * Suggestions are made against the last whitespace-separated fragment,
     * not the whole box. Terms are ANDed, so somebody who has typed "blonde
     * sp" is adding a term and wants tags starting "sp" — matching the whole
     * string would offer nothing, since no single tag is "blonde sp".
     *
     * The split is what keeps the word under the cursor out of `done`, and
     * that distinction is the whole behaviour of this control. `done` is
     * excluded from the list, because suggesting a word the query already
     * contains offers a click that changes nothing. A half-typed word is not
     * in `done`, so typing "tee" still leads with "teen" — treating it as
     * already chosen empties the list at exactly the moment it is wanted.
     *
     * A trailing space means the last word is finished and a new one has not
     * started: an empty stem, so the list falls back to the commonest tags
     * as it does on an empty box.
     */
    _parse() {
        const el = this.mount.querySelector('[data-cam-query]');
        const raw = el ? el.value : this.query;
        const cut = raw.lastIndexOf(' ') + 1;

        return { done: terms(raw.slice(0, cut)), stem: raw.slice(cut).toLowerCase() };
    }

    /**
     * Recompute the suggestion list and draw it.
     *
     * Ranked by prefix first and then by room count, because a prefix match
     * is what somebody typing a word is reaching for — "an" should lead with
     * "anal" rather than with the commoner "natural", which only contains it.
     *
     * Finished words are dropped from the list; the one being typed is not.
     * See {@link _parse} for why that distinction is the whole control.
     */
    _suggest() {
        const { done, stem } = this._parse();
        const already = new Set(done);

        // One comparison, on prefix alone. The server sends these commonest
        // first and `sort` is stable, so ties keep that order and the count
        // ranking survives without being restated here.
        this.suggestions = this.tags
            .filter(({ tag }) => !already.has(tag) && (!stem || tag.includes(stem)))
            .sort((a, b) =>
                stem ? Number(b.tag.startsWith(stem)) - Number(a.tag.startsWith(stem)) : 0
            )
            .slice(0, SUGGEST_MAX);

        this.suggestAt = -1;
        this._drawSuggest();
    }

    /**
     * Paint the list, and tell the input what it is now controlling.
     *
     * The head's `z-index` is raised while the list is open. `.shelf-head` is
     * a stacking context — it has to be, or the track's negative margin eats
     * every pointer event in the strip — so nothing inside it can paint over
     * a hovered card at `z-index: 6` unless the head itself outranks one.
     */
    _drawSuggest() {
        const list = this.mount.querySelector('.cam-suggest');
        const input = this.mount.querySelector('[data-cam-query]');
        if (!list || !input) return;

        const open = this.suggestions.length > 0;

        list.innerHTML = this.suggestions
            .map(
                ({ tag, count }, i) => `
                <li class="cam-suggestion${i === this.suggestAt ? ' active' : ''}"
                    id="cam-suggest-${i}" role="option"
                    aria-selected="${i === this.suggestAt}"
                    data-cam-tag="${escapeHtml(tag)}">
                    <span class="cam-suggestion-tag">${escapeHtml(tag)}</span>
                    <span class="cam-suggestion-count">${count}</span>
                </li>`
            )
            .join('');

        list.hidden = !open;
        input.setAttribute('aria-expanded', String(open));

        this.mount.querySelector('.cam-head')?.classList.toggle('suggesting', open);

        if (open && this.suggestAt >= 0) {
            input.setAttribute('aria-activedescendant', `cam-suggest-${this.suggestAt}`);
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    /** Close the list without touching what has been typed. */
    _suggestClose() {
        this.suggestions = [];
        this.suggestAt = -1;
        this._drawSuggest();
    }

    /** Move the highlight, wrapping, and scroll it into view. */
    _suggestMove(delta) {
        if (!this.suggestions.length) return;

        const n = this.suggestions.length;
        this.suggestAt = (this.suggestAt + delta + n) % n;

        this._drawSuggest();

        this.mount
            .querySelector(`#cam-suggest-${this.suggestAt}`)
            ?.scrollIntoView({ block: 'nearest' });
    }

    /**
     * Take a suggestion: replace the word being typed with the whole tag.
     *
     * A trailing space, because picking a tag is almost always the first of
     * two — and because without it the next keystroke would be read by
     * {@link _parse} as continuing the tag just chosen.
     *
     * Sent immediately rather than debounced. A click or an Enter is a
     * decision and there is no further typing to wait for; making a visitor
     * sit through a delay meant for keystrokes after they have committed is
     * the one place the debounce would actually be felt.
     */
    _suggestTake(tag) {
        const input = this.mount.querySelector('[data-cam-query]');
        if (!input) return;

        const cut = input.value.lastIndexOf(' ') + 1;

        input.value = `${input.value.slice(0, cut)}${tag} `;
        this.query = input.value.trim();

        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);

        this._suggestClose();
        this._reflow();

        clearTimeout(this.queryTimer);
        this._requery();
    }

    /* ----------------------------------------------------------- bindings -- */

    _bind() {
        const track = this.mount.querySelector('.cam-track');

        this._bindSearch();

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

    /**
     * The search box: typing, the suggestion list, and the keyboard contract.
     *
     * Split out of {@link _bind} because it is the one control here with more
     * than one listener and an order its handlers depend on.
     */
    _bindSearch() {
        const search = this.mount.querySelector('[data-cam-query]');
        const list = this.mount.querySelector('.cam-suggest');
        if (!search) return;

        search.addEventListener('input', () => {
            this.query = search.value.trim();

            // Draw now from what is in hand, ask properly in a moment. The
            // first of these is why the box does not feel like a network
            // control; the second is why it is not one request per letter.
            this._reflow();
            this._suggest();

            clearTimeout(this.queryTimer);
            this.queryTimer = setTimeout(() => this._requery(), QUERY_DEBOUNCE_MS);
        });

        // Focusing an empty box offers the commonest tags unprompted, which
        // is the only place on this shelf that says what there is to search
        // for. A visitor who does not know the vocabulary cannot type it.
        search.addEventListener('focus', () => this._suggest());

        // And clicking a box that already has focus offers them again, which
        // is how every other combobox behaves. Without it, the list is
        // unreachable after an Escape until the next keystroke: the box is
        // still focused, so clicking it fires nothing.
        search.addEventListener('click', () => this._suggest());

        // Not `blur`: `focusout` bubbles, so this one listener covers focus
        // leaving the box for anywhere at all, including another window.
        search.addEventListener('focusout', () => this._suggestClose());

        search.addEventListener('keydown', (event) => {
            const open = this.suggestions.length > 0;

            switch (event.key) {
                case 'ArrowDown':
                    event.preventDefault();
                    if (open) this._suggestMove(1);
                    else this._suggest();
                    return;

                case 'ArrowUp':
                    event.preventDefault();
                    if (open) this._suggestMove(-1);
                    return;

                case 'Enter':
                    // Only when something is highlighted. Enter on a typed
                    // query with no selection must do nothing visible — the
                    // row is already showing that query, and quietly
                    // swapping in whatever happened to be first in the list
                    // would rewrite what the visitor asked for.
                    if (this.suggestAt < 0) return;

                    event.preventDefault();
                    this._suggestTake(this.suggestions[this.suggestAt].tag);
                    return;

                case 'Tab':
                    // Closed, not taken. Tab is "move on", and a list that
                    // commits on the way past makes the next field's content
                    // a surprise.
                    this._suggestClose();
                    return;

                case 'Escape':
                    // One step at a time: dismiss the list, and only clear
                    // the query on a second press. Escape wiping a query
                    // the visitor could not see past is the reason this is
                    // two gestures and not one.
                    if (open) {
                        event.preventDefault();
                        this._suggestClose();
                        return;
                    }

                    if (!search.value) return;

                    event.preventDefault();
                    search.value = '';
                    this.query = '';
                    this._reflow();

                    // Immediately. Clearing is a decision, and the whole
                    // list is what comes back — there is nothing to debounce.
                    clearTimeout(this.queryTimer);
                    this._requery();
                    return;

                default:
            }
        });

        // `mousedown` and not `click`: the default action of pressing a
        // pointer down outside a focused field is to blur it, which fires
        // `focusout`, which closes the list — and the click then lands on
        // nothing. Cancelling that one default keeps the caret in the box.
        list?.addEventListener('mousedown', (event) => event.preventDefault());

        list?.addEventListener('click', (event) => {
            const tag = event.target.closest?.('[data-cam-tag]')?.dataset.camTag;
            if (tag) this._suggestTake(tag);
        });
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

        // Their callbacks reach into a mount that is about to be replaced,
        // and the request would come back to an instance nothing is using.
        clearTimeout(this.countTimer);
        clearTimeout(this.queryTimer);
        this.countTimer = null;
        this.queryTimer = null;

        this.inflight?.abort();
        this.inflight = null;

        if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
        this.onVisibility = null;

        this.onScreen.clear();
    }
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
