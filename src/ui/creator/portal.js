import { api } from '../../api/client.js';
import { icons } from '../icons.js';
import { formatDuration } from '../../catalog/catalog.js';
import {
    PROJECTION,
    PROJECTION_DETAIL,
    PROJECTION_LABELS,
    STEREO,
    STEREO_DETAIL,
    depthTag
} from '../../catalog/media-format.js';
import { dollars } from '../money.js';
import { qrSvg } from '../qr.js';

/**
 * Creator portal.
 *
 * Four views behind one shell: a dashboard of what you have published and how
 * it is doing, an editor for one title, an upload flow, and the broadcast
 * address the capture app is pointed at.
 *
 * The face check is on the Go live panel, not on the shell. Opening this page
 * shows what has been published and how it is doing; minting a broadcast
 * address is the thing that puts somebody on camera, so that is where knowing
 * who is sitting in front of the screen is worth a check - a password only
 * says that somebody signed in at some point, possibly on a laptop somebody
 * else is now holding.
 *
 * The editor deliberately puts projection and stereo controls next to a live
 * preview of what those settings mean. Getting them wrong is the single most
 * common way VR video ends up unwatchable, and the mistake is invisible until
 * someone puts a headset on.
 */

/** How often the creator's panel re-reads the waiting list, or its own room. */
const WAITING_POLL_MS = 4000;

const STATUS_LABELS = {
    draft: 'Draft',
    uploading: 'Uploading',
    processing: 'Processing',
    ready: 'Ready to publish',
    published: 'Published',
    failed: 'Failed'
};

export class CreatorPortal {
    /**
     * @param {HTMLElement} mount
     */
    constructor(mount) {
        this.mount = mount;
        this.view = 'dashboard';
        this.titles = [];
        this.overview = null;
        this.editing = null;
        this.visible = false;

        // The waiting room. `waiting` is other people's names, so it starts
        // empty and is emptied again on close rather than left in the object.
        this.waiting = [];
        this.waitingError = null;
        this.room = null;
        this.roomViewer = null;
        this.roomClosedBecause = null;
    }

    async open(view = 'dashboard') {
        this.visible = true;
        this.mount.hidden = false;
        document.body.classList.add('is-portal');
        this.view = view;

        this._renderShell();

        // No face check here. Studio opening is not the event worth binding a
        // face to - going on air is - so the check has moved to the Go live
        // panel, where the link is minted. What that gives up is stated
        // plainly: a password now protects the creator's titles and view
        // counts, where a face used to. Nothing on these screens puts anybody
        // on camera, and the one thing that does is still gated.
        //
        // The identity read is started but not waited on. It only decides
        // what the Go live panel offers, and blocking the dashboard on a
        // provider round trip would reintroduce the pause this removes.
        this._loadIdentity();
        this._loadReadiness();

        await this.refresh();
    }

    close() {
        this.visible = false;
        this.mount.hidden = true;
        clearTimeout(this._pollTimer);
        clearTimeout(this._waitingTimer);
        clearInterval(this._countdownTimer);

        // The link carries a stream key in the clear. Short-lived, but not
        // short-lived enough to leave sitting in a field behind a hidden panel,
        // on the screen of whoever opens the portal next.
        this.destination = null;

        // The room outlives the panel on the server - a creator can close the
        // portal mid-broadcast - but the viewer's name is somebody else's, and
        // it has no business surviving on a screen nobody is looking at.
        this.room = null;
        this.roomViewer = null;
        this.roomClosedBecause = null;
        this.waiting = [];
        this._waitingLoaded = false;

        document.body.classList.remove('is-portal');
    }

    /* ------------------------------------------------------------- identity -- */

    /**
     * Where this creator stands, for the Go live panel to read.
     *
     * Two things come out of it. Whether there is a face on file at all -
     * without one the panel offers enrolment rather than a broadcast link,
     * because the check that gates the link would have nothing to compare
     * against. And which provider the server is really using, read from the
     * server rather than inferred from a build flag: a client that guesses
     * can guess that a stub is real.
     */
    async _loadIdentity() {
        try {
            const status = await api.identity.status();
            this.identity = status;
            this._stub = status.provider === 'mock';
            this.enrolled = status.verification?.status === 'verified';
        } catch (err) {
            // Not fatal, and deliberately not rendered over the dashboard.
            // The panel that needs this is the only one that should suffer
            // for its absence, and it will ask again when it is opened.
            this.identity = null;
            this.identityError = err;
        }

        // Two panels wait on this now: the Go live panel, and the readiness
        // list on the dashboard. Both are started at open and either can
        // finish second, so both have to be redrawn when this lands.
        if (this.visible && (this.view === 'broadcast' || this.view === 'dashboard')) this._render();
    }

    /**
     * What stands between this creator and being on air.
     *
     * All of it lives somewhere else — enrolment at the identity provider, the
     * per-session stream checks in the relay, prices on the profile page — and
     * none of it was said here. Studio is where somebody comes to broadcast, so
     * Studio is where being unable to has to be visible, rather than at the end
     * of a Go live panel that turns out to be a gate.
     */
    async _loadReadiness() {
        try {
            const { streamChecks, creator } = await api.profile.mine();
            this.checks = streamChecks ?? null;
            this.pricing = creator ?? null;
        } catch {
            // Same rule as the identity read: one panel is poorer for it, the
            // rest of Studio carries on.
            this.checks = null;
            this.pricing = null;
        }

        if (this.visible && this.view === 'dashboard') this._render();
    }

    async refresh() {
        try {
            const [overview, titles] = await Promise.all([api.creator.overview(), api.creator.titles()]);
            this.overview = overview;
            this.titles = titles;

            // Keep the open editor in step with the poll, otherwise its status
            // badge freezes on "Processing" for the whole transcode and the
            // creator has no idea whether anything is happening.
            if (this.view === 'edit' && this.editing) {
                const fresh = titles.find((t) => t.id === this.editing.id);

                if (fresh) {
                    const wasProcessing = this.editing.status === 'processing';
                    this.editing = fresh;

                    // Re-rendering the form would discard whatever is being
                    // typed, so while a transcode is in flight only the status
                    // is patched in place. A full render happens once it
                    // settles, to pick up the duration and dimensions ffmpeg
                    // just discovered.
                    if (wasProcessing && fresh.status === 'processing') {
                        this._patchEditorStatus(fresh);
                        this._scheduleProcessingPoll();
                        return;
                    }
                }
            }

            this._render();
            this._scheduleProcessingPoll();
        } catch (err) {
            this._renderError(err);
        }
    }

    /**
     * Poll while anything is transcoding.
     *
     * Only while it matters - a dashboard with nothing in flight makes no
     * requests at all, which keeps an idle open tab from generating load.
     */
    _scheduleProcessingPoll() {
        clearTimeout(this._pollTimer);

        const busy = this.titles.some((t) => t.status === 'processing');
        if (!busy || !this.visible) return;

        this._pollTimer = setTimeout(() => this.refresh(), 4000);
    }

    /* ------------------------------------------------------------ rendering -- */

    _renderShell() {
        this.mount.innerHTML = `
            <div class="portal">
                <header class="portal-head">
                    <div class="brand">A<span>VR</span> <em>Studio</em></div>
                    <nav class="portal-nav">
                        <button data-view="dashboard">Dashboard</button>
                        <button data-view="titles">Titles</button>
                        <button data-view="broadcast">Go live</button>
                        <button data-view="feed">Headset feed</button>
                    </nav>
                    <div class="portal-head-right">
                        <button class="btn btn-vr sm" data-action="new">${icons.plus({ size: 16 })} New title</button>
                        <button class="btn btn-secondary sm" data-action="exit">Back to browse</button>
                    </div>
                </header>
                <div class="portal-body" data-body></div>
                <div class="portal-dialog" data-dialog-host hidden></div>
            </div>
        `;

        this.body = this.mount.querySelector('[data-body]');
        this.dialogHost = this.mount.querySelector('[data-dialog-host]');

        this.mount.addEventListener('click', (e) => this._onClick(e));
        this.mount.addEventListener('submit', (e) => this._onSubmit(e));
        this.mount.addEventListener('change', (e) => {
            const input = e.target.closest('input[type="file"]');
            if (input?.files?.length) {
                this._startUpload(input.files[0]);
                return;
            }

            // Lens FOV only means anything for a fisheye source, so it follows
            // the projection selector rather than waiting for a save.
            if (e.target.name === 'projection') {
                const field = this.body.querySelector('[data-fisheye]');
                if (field) field.hidden = e.target.value !== PROJECTION.FISHEYE;
            }
        });

        this._bindDropZone();
    }

    /* -------------------------------------------------------------- dialog -- */

    /**
     * Ask a question, or state a fact, without leaving Studio.
     *
     * `prompt`, `confirm` and `alert` were doing this. They freeze the whole
     * tab, they cannot be styled to look like anything else here, and after the
     * second one a browser offers to suppress the rest — which silently removes
     * the confirmation in front of a delete that takes the video files with it.
     *
     * @param {object} spec
     * @param {string} spec.title
     * @param {string} [spec.body]
     * @param {{label: string, value?: string, placeholder?: string}} [spec.field]
     *   Present for a question with an answer; absent for a yes/no.
     * @param {string} [spec.confirm]
     * @param {string|null} [spec.cancel] - `null` for a message with one way out.
     * @param {boolean} [spec.danger]
     * @returns {Promise<string|boolean|null>} the typed value, `true` for a
     *   plain confirmation, or `null` if it was dismissed.
     */
    _ask({ title, body = '', field = null, confirm = 'OK', cancel = 'Cancel', danger = false }) {
        const host = this.dialogHost;
        if (!host) return Promise.resolve(null);

        host.innerHTML = `
            <div class="portal-dialog-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                <h3>${escapeHtml(title)}</h3>
                ${body ? `<p>${escapeHtml(body)}</p>` : ''}
                ${
                    field
                        ? `<label class="portal-dialog-field">
                               <span>${escapeHtml(field.label)}</span>
                               <input type="text" data-dialog-field
                                   value="${escapeHtml(field.value ?? '')}"
                                   placeholder="${escapeHtml(field.placeholder ?? '')}" />
                           </label>`
                        : ''
                }
                <div class="portal-dialog-actions">
                    ${cancel ? `<button class="btn btn-secondary sm" data-dialog="cancel">${escapeHtml(cancel)}</button>` : ''}
                    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} sm" data-dialog="confirm">
                        ${escapeHtml(confirm)}
                    </button>
                </div>
            </div>`;

        host.hidden = false;

        const input = host.querySelector('[data-dialog-field]');
        (input ?? host.querySelector('[data-dialog="confirm"]'))?.focus();
        input?.select();

        return new Promise((resolve) => {
            const done = (value) => {
                host.hidden = true;
                host.innerHTML = '';
                host.removeEventListener('click', onClick);
                window.removeEventListener('keydown', onKey);
                resolve(value);
            };

            const accept = () => done(field ? input?.value ?? '' : true);

            const onClick = (e) => {
                if (e.target === host || e.target.closest('[data-dialog="cancel"]')) {
                    done(null);
                    return;
                }
                if (e.target.closest('[data-dialog="confirm"]')) accept();
            };

            const onKey = (e) => {
                if (e.key === 'Escape') done(null);
                if (e.key === 'Enter' && field) {
                    e.preventDefault();
                    accept();
                }
            };

            host.addEventListener('click', onClick);
            window.addEventListener('keydown', onKey);
        });
    }

    /** A dead end with one way out of it. */
    _say(title, body = '') {
        return this._ask({ title, body, confirm: 'OK', cancel: null });
    }

    /**
     * Drag-and-drop upload.
     *
     * Bound once on the shell and delegated, because the drop zone is
     * re-rendered whenever the editor redraws.
     */
    _bindDropZone() {
        const zoneFor = (e) => e.target.closest?.('[data-drop]');

        // The default action for a drop anywhere on a page is to navigate to
        // the file, which would throw away the whole session.
        for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
            this.mount.addEventListener(type, (e) => {
                if (type === 'dragover' || type === 'drop' || zoneFor(e)) e.preventDefault();
            });
        }

        this.mount.addEventListener('dragover', (e) => zoneFor(e)?.classList.add('dragover'));
        this.mount.addEventListener('dragleave', (e) => zoneFor(e)?.classList.remove('dragover'));

        this.mount.addEventListener('drop', (e) => {
            const zone = zoneFor(e);
            if (!zone) return;

            zone.classList.remove('dragover');

            const file = e.dataTransfer?.files?.[0];
            if (!file) return;

            if (!/^video\//.test(file.type) && !/\.(mp4|m4v|mov|mkv|webm)$/i.test(file.name)) {
                this._say(
                    'That is not a video file',
                    `“${file.name}” is not one of MP4, M4V, MOV, MKV or WebM.`
                );
                return;
            }

            this._startUpload(file);
        });
    }

    _render() {
        this.mount.querySelectorAll('.portal-nav button').forEach((b) => {
            b.classList.toggle('active', b.dataset.view === this.view);
        });

        switch (this.view) {
            case 'titles':
                this.body.innerHTML = this._titlesHtml();
                break;
            case 'edit':
                this.body.innerHTML = this._editorHtml();
                break;
            case 'broadcast':
                this.body.innerHTML = this._broadcastHtml();
                this._startCountdown();
                this._startWaitingPoll();
                break;
            case 'feed':
                this.body.innerHTML = this._feedHtml();
                this._loadFeed();
                break;
            default:
                this.body.innerHTML = this._dashboardHtml();
        }
    }

    /** Update only the editor's status chip, leaving form state untouched. */
    _patchEditorStatus(title) {
        const head = this.body?.querySelector('.editor-head');
        if (!head) return;

        const chip = head.querySelector('.status');
        if (chip) {
            chip.className = `status status-${title.status}`;
            chip.textContent = STATUS_LABELS[title.status] ?? title.status;
        }

        let detail = head.querySelector('.muted');
        if (title.statusDetail) {
            if (!detail) {
                detail = document.createElement('span');
                detail.className = 'muted';
                head.appendChild(detail);
            }
            detail.textContent = title.statusDetail;
        } else {
            detail?.remove();
        }
    }

    _renderError(err) {
        this.body.innerHTML = `<div class="empty-state"><h2>Could not load</h2><p>${escapeHtml(err.message)}</p></div>`;
    }

    _dashboardHtml() {
        const t = this.overview?.totals ?? { titles: 0, published: 0, views: 0, hoursWatched: 0 };
        const queue = this.overview?.queue ?? {};
        const remote = this.overview?.storage?.remote;

        return `
            ${this._readinessHtml()}

            <div class="stat-row">
                ${statTile('Titles', t.titles)}
                ${statTile('Published', t.published)}
                ${statTile('Total views', t.views.toLocaleString())}
                ${statTile('Hours watched', t.hoursWatched.toFixed(1))}
            </div>

            ${
                queue.workerEnabled === false
                    ? `<div class="notice">
                           <strong>No transcoding worker is running on this node.</strong>
                           Uploads will be stored and queued, but will not be packaged into an
                           adaptive-bitrate ladder until a worker picks them up.
                           Start one with <code>npm run worker</code>.
                       </div>`
                    : ''
            }

            ${
                remote === false
                    ? `<div class="notice subtle">
                           Storage is local disk, so uploads and playback stream through this server.
                           Configure <code>AVR_STORAGE=s3</code> to hand delivery to a CDN.
                       </div>`
                    : ''
            }

            ${this._sparklineHtml()}

            <h3 class="section-title">Your titles</h3>
            ${this._titlesTableHtml(this.titles.slice(0, 8))}
        `;
    }

    /**
     * The first thing on the dashboard: can you go live, and for how much.
     *
     * The stream checks expire with the session by design, so this is a
     * different answer every time Studio is opened — which is exactly why it
     * cannot be left on another page for the creator to remember to visit.
     */
    _readinessHtml() {
        // Nothing is known yet. An empty row of grey ticks would be a claim.
        if (this.checks === undefined && this.enrolled === undefined) return '';

        const checks = this.checks ?? { standard: false, spatial: false };
        const p = this.pricing;
        const wants3d = Boolean(p?.public3dEnabled || p?.private3dEnabled);

        const steps = [
            {
                done: this.enrolled === true,
                label: 'Identity on file',
                detail:
                    this.enrolled === true
                        ? 'Checked against your face before each broadcast link is issued.'
                        : 'Needed once, before your first broadcast. The Go live panel will ask.'
            },
            {
                done: Boolean(checks.standard),
                label: 'Standard stream confirmed',
                detail: checks.standard
                    ? 'Confirmed this session.'
                    : 'Confirmed once per sign-in, from your profile. Until then you cannot go on air.'
            }
        ];

        if (wants3d) {
            steps.push({
                done: Boolean(checks.spatial),
                label: 'Stereo Side-by-Side stream confirmed',
                detail: checks.spatial
                    ? 'Confirmed this session, so you can offer 3D.'
                    : 'You are offering 3D, so this one is required too.'
            });
        }

        const blocked = steps.some((s) => !s.done);

        return `
            <section class="panel ready-panel">
                <h3 class="section-title">Going live</h3>

                <ul class="ready-list">
                    ${steps
                        .map(
                            (s) => `
                        <li class="ready-step ${s.done ? 'is-done' : ''}">
                            <span class="ready-mark">${s.done ? icons.check({ size: 13 }) : ''}</span>
                            <div>
                                <strong>${escapeHtml(s.label)}</strong>
                                <span class="muted small">${escapeHtml(s.detail)}</span>
                            </div>
                        </li>`
                        )
                        .join('')}
                </ul>

                ${p ? `<p class="muted small ready-prices">${escapeHtml(priceSummary(p))}</p>` : ''}

                <div class="ready-actions">
                    <button class="btn ${blocked ? 'btn-secondary' : 'btn-vr'} sm" data-view="broadcast">Go live</button>
                    <button class="btn btn-secondary sm" data-action="open-profile">
                        ${blocked ? 'Run the checks' : 'Checks and prices'}
                    </button>
                </div>
            </section>
        `;
    }

    /**
     * Inline sparkline of daily views.
     *
     * Drawn as an SVG polyline rather than pulling in a chart library - it is
     * one series with no axes and no interaction.
     */
    _sparklineHtml() {
        const daily = this.overview?.daily ?? [];
        if (daily.length < 2) return '';

        const max = Math.max(...daily.map((d) => d.views), 1);
        const w = 720;
        const h = 90;

        const points = daily
            .map((d, i) => {
                const x = (i / (daily.length - 1)) * w;
                const y = h - (d.views / max) * (h - 8) - 4;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(' ');

        return `
            <section class="panel">
                <h3 class="section-title">Views · last 30 days</h3>
                <svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
                     aria-label="Daily views, peak ${max}">
                    <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2"
                              stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                </svg>
                <div class="sparkline-axis"><span>${daily[0].day}</span><span>peak ${max}/day</span><span>${daily.at(-1).day}</span></div>
            </section>
        `;
    }

    _titlesHtml() {
        if (!this.titles.length) {
            return `
                <div class="empty-state">
                    <h2>No titles yet</h2>
                    <p>Create one, upload a video, and it will be packaged for adaptive streaming.</p>
                    <button class="btn btn-vr" data-action="new">${icons.plus({ size: 16 })} New title</button>
                </div>`;
        }

        return `<h3 class="section-title">All titles</h3>${this._titlesTableHtml(this.titles)}`;
    }

    _titlesTableHtml(titles) {
        if (!titles.length) return `<p class="muted">Nothing here yet.</p>`;

        const stats = new Map((this.overview?.titles ?? []).map((r) => [r.id, r]));

        return `
            <div class="table-wrap">
                <table class="portal-table">
                    <thead>
                        <tr>
                            <th>Title</th><th>Format</th><th>Status</th>
                            <th>Visibility</th><th class="num">Views</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${titles
                            .map((t) => {
                                const s = stats.get(t.id);
                                return `
                            <tr data-id="${t.id}">
                                <td>
                                    <div class="cell-title">${escapeHtml(t.title)}</div>
                                    <div class="cell-sub">${t.duration ? formatDuration(t.duration) : '—'}
                                        ${t.width ? ` · ${t.width}×${t.height}` : ''}
                                        ${t.hasHls ? ' · <span class="ok">HLS</span>' : ''}</div>
                                </td>
                                <td><span class="badge vr">${formatLabel(t)}</span></td>
                                <td>
                                    <span class="status status-${t.status}">${STATUS_LABELS[t.status] ?? t.status}</span>
                                    ${t.statusDetail ? `<div class="cell-sub">${escapeHtml(t.statusDetail)}</div>` : ''}
                                </td>
                                <td class="muted">${t.visibility}</td>
                                <td class="num">${s ? s.views : 0}</td>
                                <td class="row-actions">
                                    <button class="btn btn-secondary sm" data-action="edit" data-id="${t.id}">Edit</button>
                                    ${
                                        t.status === 'published'
                                            ? `<button class="btn btn-secondary sm" data-action="unpublish" data-id="${t.id}">Unpublish</button>`
                                            : `<button class="btn btn-primary sm" data-action="publish" data-id="${t.id}"
                                                  ${t.hasSource || t.hasHls ? '' : 'disabled title="Upload a file first"'}>Publish</button>`
                                    }
                                </td>
                            </tr>`;
                            })
                            .join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    _editorHtml() {
        const t = this.editing;
        if (!t) return '<div class="empty-state"><h2>Nothing selected</h2></div>';

        const isFisheye = t.projection === PROJECTION.FISHEYE;

        return `
            <div class="editor">
                <div class="editor-main">
                    <div class="editor-head">
                        <button class="btn btn-secondary sm" data-action="back">${icons.back({ size: 15 })} Titles</button>
                        <span class="status status-${t.status}">${STATUS_LABELS[t.status] ?? t.status}</span>
                        ${t.statusDetail ? `<span class="muted">${escapeHtml(t.statusDetail)}</span>` : ''}
                    </div>

                    <form class="portal-form" data-form="metadata">
                        <div class="field-error" data-error hidden></div>

                        <label><span>Title</span>
                            <input name="title" value="${escapeAttr(t.title)}" required maxlength="200" /></label>

                        <label><span>Synopsis</span>
                            <textarea name="synopsis" rows="4" maxlength="4000">${escapeHtml(t.synopsis ?? '')}</textarea></label>

                        <div class="field-row">
                            <label><span>Genre</span><input name="genre" value="${escapeAttr(t.genre ?? '')}" maxlength="60" /></label>
                            <label><span>Studio</span><input name="studio" value="${escapeAttr(t.studio ?? '')}" maxlength="120" /></label>
                            <label><span>Year</span><input name="year" type="number" min="1880" max="2200" value="${t.year ?? ''}" /></label>
                        </div>

                        <h4>Playback format</h4>
                        <p class="muted small">
                            These two settings decide how the video is mapped onto geometry in a headset.
                            Getting them wrong is the usual cause of "the VR video looks broken".
                        </p>

                        <div class="field-row">
                            <label><span>Projection</span>
                                <select name="projection">
                                    ${option(PROJECTION.FLAT, PROJECTION_DETAIL[PROJECTION.FLAT], t.projection)}
                                    ${option(PROJECTION.DOME180, PROJECTION_DETAIL[PROJECTION.DOME180], t.projection)}
                                    ${option(PROJECTION.SPHERE360, PROJECTION_DETAIL[PROJECTION.SPHERE360], t.projection)}
                                    ${option(PROJECTION.FISHEYE, PROJECTION_DETAIL[PROJECTION.FISHEYE], t.projection)}
                                </select>
                            </label>

                            <label><span>Stereo layout</span>
                                <select name="stereo">
                                    ${option(STEREO.MONO, STEREO_DETAIL[STEREO.MONO], t.stereo)}
                                    ${option(STEREO.SBS, STEREO_DETAIL[STEREO.SBS], t.stereo)}
                                    ${option(STEREO.TB, STEREO_DETAIL[STEREO.TB], t.stereo)}
                                </select>
                            </label>

                            <label ${isFisheye ? '' : 'hidden'} data-fisheye>
                                <span>Lens FOV</span>
                                <input name="fisheyeFov" type="number" min="100" max="360" value="${t.fisheyeFov ?? 190}" />
                            </label>
                        </div>

                        <label><span>Visibility</span>
                            <select name="visibility">
                                ${option('private', 'Private — only you', t.visibility)}
                                ${option('unlisted', 'Unlisted — anyone with the link', t.visibility)}
                                ${option('public', 'Public — appears in the library', t.visibility)}
                            </select>
                        </label>

                        <div class="editor-actions">
                            <button type="submit" class="btn btn-primary">Save changes</button>
                            <button type="button" class="btn btn-secondary" data-action="delete" data-id="${t.id}">Delete title</button>
                        </div>
                    </form>
                </div>

                <aside class="editor-side">
                    ${this._uploadPanelHtml(t)}
                    ${this._previewHtml(t)}
                </aside>
            </div>
        `;
    }

    _uploadPanelHtml(t) {
        return `
            <section class="panel">
                <h3 class="section-title">Video file</h3>
                ${
                    t.hasSource
                        ? `<p class="muted small">
                               Uploaded${t.sizeBytes ? ` · ${formatBytes(t.sizeBytes)}` : ''}
                               ${t.hasHls ? ' · packaged for adaptive streaming' : ' · not yet packaged'}
                           </p>`
                        : `<p class="muted small">No file yet. Conventional filenames like
                               <code>Name_180x180_3dh_LR.mp4</code> pre-fill the format below.</p>`
                }

                <div class="upload-drop" data-drop>
                    <input type="file" accept="video/*" hidden id="upload-input" />
                    <label for="upload-input" class="btn btn-vr sm">${t.hasSource ? 'Replace file' : 'Choose file'}</label>
                    <span class="muted small">or drop a file here</span>
                </div>

                <div class="upload-progress" data-progress hidden>
                    <div class="bar"><i></i></div>
                    <div class="upload-meta"><span data-progress-text>0%</span>
                        <button class="link" data-action="cancel-upload">Cancel</button></div>
                </div>
            </section>
        `;
    }

    /** Static diagram of how the chosen format will be unpacked. */
    _previewHtml(t) {
        const stereoNote =
            t.stereo === STEREO.SBS
                ? 'Frame is split left | right; each eye gets one half.'
                : t.stereo === STEREO.TB
                  ? 'Frame is split top / bottom; the top half is the left eye.'
                  : 'One image shown to both eyes.';

        const projNote = {
            [PROJECTION.FLAT]: 'Mapped onto a curved cinema screen in front of the viewer.',
            [PROJECTION.DOME180]: 'Wrapped onto a 180° dome; the viewer sits at its centre.',
            [PROJECTION.SPHERE360]: 'Wrapped onto a full sphere around the viewer.',
            [PROJECTION.FISHEYE]: `De-warped from a ${t.fisheyeFov ?? 190}° circular image.`
        }[t.projection];

        return `
            <section class="panel">
                <h3 class="section-title">How this will play</h3>
                <div class="preview-diagram">${previewSvg(t)}</div>
                <p class="muted small"><strong>Projection.</strong> ${projNote}</p>
                <p class="muted small"><strong>Stereo.</strong> ${stereoNote}</p>
            </section>
        `;
    }

    /* -------------------------------------------------------------- go live -- */

    /**
     * The destination the capture app is pointed at.
     *
     * The vocabulary here is not free. Every term on this screen names
     * something the creator will see again in the capture app's own destination
     * editor, and the two used to disagree — this page said "broadcast address"
     * for the whole link and "Server" for the host, where the app says
     * "destination" and "Address". Somebody reading one screen while typing into
     * the other had to translate. Destination, Name, Address, Port, Stream key,
     * Encrypted, Certificate pin: the same words, in the same order, on both
     * sides. docs/LIVE.md carries the table.
     *
     * Nothing is minted on page load, because minting costs a face check and
     * spends a grant the creator may not be ready to use. The button is the
     * point at which they say they are about to go live.
     */
    _broadcastHtml() {
        const d = this.destination;

        // A check in progress, a refusal, or an enrolment - the states the old
        // shell-wide gate used to render, now inside the panel they belong to
        // so the rest of Studio stays usable behind them.
        if (this.broadcastGate) {
            return gatePanel('Go live', gateBody({ ...this.broadcastGate, stub: this._stub }));
        }

        if (this.identity && !this.enrolled) {
            return gatePanel(
                'Go live',
                gateBody({ state: 'enrol', verification: this.identity.verification, stub: this._stub })
            );
        }

        if (!d) {
            return `
                <section class="panel">
                    <h3 class="section-title">Go live</h3>

                    ${
                        // Inline rather than a panel of its own. The commonest
                        // failure here is now "that viewer stopped waiting",
                        // whose only sensible next move is picking another name
                        // off the list - so the list has to still be on screen.
                        this.destinationError
                            ? `<div class="field-error">${escapeHtml(this.destinationError)}</div>`
                            : ''
                    }

                    <p class="muted">
                        Open AVR Capture on your phone. It will ask where to send the broadcast.
                        Name the destination below, choose who is watching, then scan the code that
                        appears with the app — it fills in the address and the stream key for you.
                    </p>

                    <label class="destination-field">
                        <span>Name</span>
                        <input type="text" data-destination-name maxlength="60"
                               placeholder="${escapeAttr(this._defaultDestinationName())}"
                               value="${escapeAttr(this.destinationName ?? '')}">
                        <span class="muted small">
                            What this destination is called in the app's list. The app requires one;
                            leave this blank and it will use your account name.
                        </span>
                    </label>

                    ${this._waitingHtml()}

                    <p class="muted small">
                        Whichever you choose, the link is good for one broadcast and expires in a few
                        minutes — so create it when you are ready to start rather than in advance.
                    </p>
                </section>
            `;
        }

        return `
            <section class="panel">
                <h3 class="section-title">Go live</h3>

                ${this._roomHtml()}

                ${
                    // Said here too, not only at the gate. This is the screen
                    // where the key appears, and it is the one somebody
                    // screenshots into a ticket saying "verification works".
                    this._stub
                        ? `<div class="notice stub-notice">
                               <strong>Issued without an identity check.</strong>
                               No identity provider is configured, so the check that would normally
                               gate this link approved automatically. This key is real and will
                               authorise a broadcast — it just did not verify anybody.
                           </div>`
                        : ''
                }

                <p class="muted">
                    In AVR Capture, add a destination and tap Scan. Point the phone at this code.
                </p>

                ${this._destinationQrHtml(d)}
                ${this._roomWaitingHtml()}

                <div class="destination-expiry" data-expiry data-until="${escapeAttr(this.destinationExpiresAt ?? '')}"></div>

                <div class="destination">
                    <label class="destination-label" for="avr-destination">Destination link</label>
                    <div class="destination-row">
                        <input id="avr-destination" class="destination-url" type="text" readonly
                               value="${escapeAttr(d.url)}" spellcheck="false"
                               onfocus="this.select()">
                        <button class="btn btn-primary" data-action="copy-destination"
                                data-value="${escapeAttr(d.url)}">Copy</button>
                    </div>
                </div>

                <details class="destination-manual">
                    <summary>Type it in by hand instead</summary>
                    <div class="endpoint"><div class="endpoint-label">Name</div><code>${escapeHtml(d.name)}</code></div>
                    <div class="endpoint"><div class="endpoint-label">Address</div><code>${escapeHtml(d.host)}</code></div>
                    <div class="endpoint"><div class="endpoint-label">Port</div><code>${escapeHtml(String(d.port))}</code></div>
                    <div class="endpoint"><div class="endpoint-label">Stream key</div><code>${escapeHtml(d.key)}</code></div>
                    <div class="endpoint"><div class="endpoint-label">Encrypted</div><code>${d.tls ? 'Yes' : 'No'}</code></div>
                    ${d.pin ? `<div class="endpoint"><div class="endpoint-label">Certificate pin</div><code>${escapeHtml(d.pin)}</code></div>` : ''}
                </details>

                ${
                    this.destinationResumeSeconds
                        ? `<p class="muted small">
                               If the connection drops you have ${escapeHtml(String(this.destinationResumeSeconds))}
                               seconds to reconnect before the link has to be created again.
                           </p>`
                        : ''
                }

                <button class="btn btn-secondary sm" data-action="new-destination">Create another</button>
            </section>
        `;
    }

    /**
     * The destination link, as something a camera can read.
     *
     * This replaced a copy-paste that nobody could do without two devices and a
     * messaging app in between - the creator was typing a forty-character key
     * into a phone keyboard, or mailing a live broadcast credential to
     * themselves. Scanning removes both, and it is the reason the five-minute
     * grant is a usable design rather than a punishment.
     *
     * It is worth being plain about what is on screen: a bearer credential,
     * rendered at camera range of everyone in the room. That is defensible
     * precisely because the grant is single-use and expires in minutes. It
     * would not be defensible for a durable key, which is part of why there
     * isn't one - see "Why not a durable key" in docs/IDENTITY.md.
     *
     * Error correction stays at M. H would survive a thumb over the corner, at
     * the cost of a denser code that has to be held closer; M is the level the
     * format is tuned around, and this code is on a clean screen a foot away,
     * not printed on a crate.
     *
     * Failure here is not fatal. The text field below carries the same link,
     * and losing the picture must not lose the broadcast.
     */
    _destinationQrHtml(d) {
        try {
            return `<div class="destination-qr">${qrSvg(d.url, { title: 'Destination link, as a QR code' })}</div>`;
        } catch (err) {
            console.warn('[portal] could not draw the destination code:', err.message);
            return `<p class="muted small">The code could not be drawn. Copy the link below instead.</p>`;
        }
    }

    /**
     * Who is available to broadcast to.
     *
     * A row here is one browser tab with the live monitor open, belonging to a
     * signed-in account. Clicking one is the whole gesture: it mints the
     * destination, opens a room, and puts the code on screen. There is no
     * separate confirm step because there is nothing to confirm - the room
     * costs nothing until a phone connects to it, and picking the wrong person
     * is fixed by picking the right one.
     *
     * The public option stays, below the list and deliberately not first. It is
     * the old behaviour and still the right answer for a LAN test or an open
     * broadcast, but "anyone on this server" should be a thing a creator chooses
     * rather than a thing they get by not reading.
     */
    _waitingHtml() {
        if (this.waitingError) {
            return `
                <div class="waiting">
                    <h4 class="waiting-title">Who is watching</h4>
                    <p class="muted small">The waiting list is unavailable: ${escapeHtml(this.waitingError)}</p>
                    ${this._publicDestinationHtml()}
                </div>
            `;
        }

        const rows = (this.waiting ?? []).map(
            (v) => `
                <button class="waiting-row" data-action="invite" data-viewer="${escapeAttr(v.id)}">
                    <span class="waiting-name">${escapeHtml(v.name)}</span>
                    <span class="waiting-meta">${escapeHtml(v.device)}</span>
                    <span class="waiting-meta">waiting ${escapeHtml(formatWait(v.waitingSeconds))} · ${escapeHtml(v.id)}</span>
                </button>
            `
        );

        return `
            <div class="waiting">
                <h4 class="waiting-title">Who is watching</h4>

                ${
                    rows.length
                        ? `<p class="muted small">
                               Pick one. The broadcast opens on their screen only, and it is not
                               listed for anybody else.
                           </p>
                           <div class="waiting-list">${rows.join('')}</div>`
                        : `<p class="muted small">
                               Nobody is waiting. A viewer appears here once they sign in and open
                               the live page — it refreshes on its own.
                           </p>`
                }

                ${this._publicDestinationHtml()}
            </div>
        `;
    }

    _publicDestinationHtml() {
        return `
            <div class="waiting-public">
                <button class="btn btn-secondary sm" data-action="new-destination">
                    Broadcast to anyone on this server
                </button>
                <span class="muted small">Listed publicly, and joinable by broadcast id.</span>
            </div>
        `;
    }

    /** Who this link was made for, above the code the phone is about to read. */
    _roomHtml() {
        if (!this.room) {
            return `
                <div class="notice room-notice">
                    <strong>Open broadcast.</strong>
                    Anyone on this server can watch this one, and it is listed for them.
                </div>
            `;
        }

        return `
            <div class="notice room-notice room-private">
                <strong>Room ${escapeHtml(this.room.id)}</strong>
                — for ${escapeHtml(this.roomViewer?.name ?? 'the viewer you chose')}
                ${this.roomViewer?.device ? `<span class="muted">(${escapeHtml(this.roomViewer.device)})</span>` : ''}.
                Nobody else can watch it, and it is not in the public list.
            </div>
        `;
    }

    /**
     * What the room is doing, under the code.
     *
     * Only meaningful once a room exists, and it is the half of the handshake
     * the creator cannot otherwise see: their own screen shows a QR code
     * whether or not the phone has read it, and the thing that actually changed
     * is on somebody else's monitor.
     */
    _roomWaitingHtml() {
        if (!this.room) return '';

        if (!this.room.open) {
            return `<p class="room-status muted small">
                        Room ${escapeHtml(this.room.id)} closed${
                            this.roomClosedBecause ? ` — ${escapeHtml(this.roomClosedBecause)}` : ''
                        }. Choose somebody again to open another.
                    </p>`;
        }

        return this.room.sessionId
            ? `<p class="room-status room-live">
                   On air in room ${escapeHtml(this.room.id)} — ${escapeHtml(this.roomViewer?.name ?? 'the viewer')}
                   is watching broadcast ${escapeHtml(this.room.sessionId)}.
               </p>`
            : `<p class="room-status muted small">
                   Room ${escapeHtml(this.room.id)} is open and waiting for the camera. It opens on
                   ${escapeHtml(this.roomViewer?.name ?? 'their')} screen the moment the phone connects.
               </p>`;
    }

    /**
     * Keep the waiting list and the room honest while this panel is open.
     *
     * Only while it is open, and only on the broadcast view - a creator sitting
     * on the dashboard has no use for it, and this is a request every few
     * seconds. Stopped by `_render` switching away and by `close()`.
     */
    _startWaitingPoll() {
        clearTimeout(this._waitingTimer);
        if (!this.visible || this.view !== 'broadcast') return;

        // Immediately the first time the panel is opened, on the normal interval
        // every time after. A tick that changes something re-renders, and a
        // render arms the poll again - so firing a request from inside the arm
        // is how a four-second poll turns into a request per round trip.
        this._waitingTimer = setTimeout(() => this._waitingTick(), this._waitingLoaded ? WAITING_POLL_MS : 0);
    }

    async _waitingTick() {
        if (!this.visible || this.view !== 'broadcast') return;

        // A public link already on screen has nothing to watch: no room to
        // check, and a list that is not being displayed. Stop rather than
        // re-render the QR code every time somebody else opens the live page.
        if (!this.room && this.destination) return;

        this._waitingLoaded = true;
        let changed = false;

        try {
            if (this.room) {
                // Once a room exists the list is irrelevant; what matters is
                // whether the phone has connected to it yet.
                const state = await api.live.room(this.room.id);
                changed = state.room?.sessionId !== this.room.sessionId || state.room?.open !== this.room.open;
                this.room = state.room ?? this.room;
                this.roomClosedBecause = state.closeReason ?? null;
            } else {
                const viewers = await api.live.waiting();

                // Re-rendering on every tick would throw away whatever is being
                // typed in the name field, so only a list that actually changed
                // is worth a redraw.
                const before = JSON.stringify((this.waiting ?? []).map((v) => v.id));
                changed = this.waitingError !== null || before !== JSON.stringify(viewers.map((v) => v.id));
                this.waiting = viewers;
                this.waitingError = null;
            }
        } catch (err) {
            // A room that 404s has been swept; drop back to the list rather than
            // leaving a dead room id on screen.
            if (this.room && err.status === 404) {
                this.room = null;
                this.roomViewer = null;
                changed = true;
            } else if (!this.room) {
                changed = this.waitingError !== err.message;
                this.waitingError = err.message;
            }
        }

        // `_render` arms the next tick itself; scheduling one here as well would
        // leave two loops running against the same timer handle.
        if (changed) {
            this._render();
            return;
        }

        this._waitingTimer = setTimeout(() => this._waitingTick(), WAITING_POLL_MS);
    }

    _defaultDestinationName() {
        return api.user?.displayName || 'ProjectAVR Live';
    }

    /**
     * Mint a destination.
     *
     * This is where the face check lives now. The server decides whether one
     * is needed - a session still holding an unlock from a check minutes ago
     * gets the link in one round trip - and the `status` in the reply says
     * which it chose. Either way the creator is asked at the moment they said
     * they were about to go on air, which is the moment worth asking at.
     */
    async _newDestination(viewerId = null) {
        // Read before the re-render blows the field away.
        const typed = this.body?.querySelector('[data-destination-name]')?.value ?? '';
        this.destinationName = typed.trim();

        // Snapshotted here, from the row that was clicked. The server's reply
        // carries the room but not the person - it has no reason to send a
        // display name back to the browser that just sent it an id - and the
        // creator needs to see whose screen this is about to open.
        this.roomViewer = (this.waiting ?? []).find((v) => v.id === viewerId) ?? null;

        // Remembered so "Try again" after a failed check goes back to the same
        // viewer rather than quietly turning a 1:1 into a public broadcast.
        this._retryViewerId = viewerId;

        this.destination = null;
        this.destinationError = null;
        this.room = null;
        this.broadcastGate = { state: 'starting' };
        this._render();

        try {
            const started = await api.identity.startDestination(
                this.destinationName || undefined,
                viewerId || undefined
            );

            if (started.status === 'approved') {
                this._applyDestination(started);
                return;
            }

            const flow = started.clientUrl
                ? window.open(started.clientUrl, 'avr-face-check', 'width=480,height=720')
                : null;

            this.broadcastGate = { state: 'waiting', clientUrl: started.clientUrl, blocked: !flow };
            this._render();

            const deadline = new Date(started.expiresAt).getTime();

            for (;;) {
                if (!this.visible || this.view !== 'broadcast') return;

                if (Date.now() > deadline) throw new Error('The check expired before it finished.');

                await sleep(2000);

                const result = await api.identity.completeDestination(started.id);
                if (result.status === 'pending') continue;

                flow?.close();

                if (result.status === 'denied') {
                    this.broadcastGate = { state: 'denied', message: result.reason, retry: true };
                    this.roomViewer = null;
                    this._render();
                    return;
                }

                this._applyDestination(result);
                return;
            }
        } catch (err) {
            // A creator with no face on file cannot pass a check, so they are
            // offered the enrolment instead of a retry that can only fail.
            if (err.details?.code === 'verification_required' || err.status === 403) {
                this.enrolled = false;
            }

            this.broadcastGate =
                err.status === 403 && err.details?.reason
                    ? { state: 'denied', message: err.details.reason, retry: true }
                    : errorGate(err);

            this.destinationError = err.status === 403 ? err.details?.reason || err.message : err.message;

            // No room was opened, so nothing on screen should name a person.
            this.roomViewer = null;
            this._render();
        }
    }

    _applyDestination(result) {
        this.broadcastGate = null;
        this.destination = result.destination;
        this.destinationExpiresAt = result.expiresAt ?? null;
        this.destinationResumeSeconds = result.resumeSeconds ?? null;
        this.room = result.room ?? null;
        this.destinationError = null;
        this._render();
    }

    /**
     * Count the link down on screen.
     *
     * A grant that has quietly expired looks exactly like one that has not, and
     * the failure lands on the phone as "the server did not accept this
     * destination's stream key" — which reads as a typo, not as a clock. Saying
     * how long is left turns a confusing rejection into an expected one.
     */
    _startCountdown() {
        clearInterval(this._countdownTimer);

        const el = this.body?.querySelector('[data-expiry]');
        const until = Date.parse(el?.dataset.until ?? '');
        if (!el || !Number.isFinite(until)) return;

        const tick = () => {
            const left = Math.round((until - Date.now()) / 1000);

            if (left <= 0) {
                el.textContent = 'This address has expired. Create a new one.';
                el.classList.add('expired');
                clearInterval(this._countdownTimer);
                return;
            }

            const mm = String(Math.floor(left / 60));
            const ss = String(left % 60).padStart(2, '0');
            el.textContent = `Valid for ${mm}:${ss}`;
            el.classList.remove('expired');
        };

        tick();
        this._countdownTimer = setInterval(tick, 1000);
    }

    _feedHtml() {
        return `
            <section class="panel">
                <h3 class="section-title">Your headset feed</h3>
                <p class="muted">
                    This private URL shows the public library plus your own unpublished titles,
                    so you can check a title in a headset before anyone else sees it.
                    Treat it like a password — anyone with the link can watch your drafts.
                </p>
                <div class="compat-endpoints" data-feed><p class="muted">Loading…</p></div>
                <button class="btn btn-secondary sm" data-action="rotate-feed">Rotate token</button>
            </section>
        `;
    }

    async _loadFeed() {
        try {
            const feed = await api.creator.feed();
            const target = this.body.querySelector('[data-feed]');
            if (!target) return;

            target.innerHTML = `
                ${endpointRow("DeoVR / Play'a", feed.deovr)}
                ${endpointRow('M3U playlist', feed.playlist)}
            `;
        } catch (err) {
            this._renderError(err);
        }
    }

    /* --------------------------------------------------------------- events -- */

    async _onClick(e) {
        const viewBtn = e.target.closest('[data-view]');
        if (viewBtn) {
            // Leaving the Go live panel abandons whatever check was running in
            // it. The server's challenge is superseded by the next one anyway,
            // so the only thing to clean up is what is on screen.
            if (this.view === 'broadcast' && viewBtn.dataset.view !== 'broadcast') this.broadcastGate = null;

            this.view = viewBtn.dataset.view;
            this._render();
            return;
        }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const { action, id } = btn.dataset;

        try {
            switch (action) {
                case 'exit':
                    this.close();
                    window.dispatchEvent(new CustomEvent('avr:exit-portal'));
                    break;

                // The stream checks and the four prices live on the profile
                // page. Studio is where their absence is felt, so Studio is
                // where the door to them is.
                case 'open-profile':
                    this.close();
                    window.dispatchEvent(new CustomEvent('avr:open-profile'));
                    break;

                case 'new': {
                    const title = await this._ask({
                        title: 'New title',
                        body: 'A working name. You can change it, and everything else, on the next screen.',
                        field: { label: 'Title name', placeholder: 'Untitled' },
                        confirm: 'Create'
                    });

                    if (!title?.trim()) return;
                    this.editing = await api.creator.create({ title: title.trim() });
                    this.view = 'edit';
                    await this.refresh();
                    break;
                }

                case 'edit':
                    this.editing = await api.creator.title(id);
                    this.view = 'edit';
                    this._render();
                    break;

                case 'back':
                    this.view = 'titles';
                    this.editing = null;
                    this._render();
                    break;

                case 'publish':
                    await api.creator.publish(id);
                    await this.refresh();
                    break;

                case 'unpublish':
                    await api.creator.unpublish(id);
                    await this.refresh();
                    break;

                case 'delete':
                    if (
                        !(await this._ask({
                            title: 'Delete this title?',
                            body: 'The uploaded video and everything transcoded from it go too. This cannot be undone.',
                            confirm: 'Delete',
                            danger: true
                        }))
                    ) {
                        return;
                    }

                    await api.creator.remove(id);
                    this.editing = null;
                    this.view = 'titles';
                    await this.refresh();
                    break;

                case 'cancel-upload':
                    api.cancelUpload();
                    break;

                case 'rotate-feed':
                    if (
                        !(await this._ask({
                            title: 'Rotate the feed token?',
                            body: 'Every headset link you have already handed out stops working, and you will need to send the new one.',
                            confirm: 'Rotate',
                            danger: true
                        }))
                    ) {
                        return;
                    }

                    await api.post('/api/auth/feed-token/rotate');
                    this._loadFeed();
                    break;

                case 'retry-check':
                    await this._newDestination(this._retryViewerId ?? null);
                    break;

                case 'cancel-check':
                    this.broadcastGate = null;
                    this._render();
                    break;

                case 'enrol':
                    await this._startEnrolment();
                    break;

                case 'new-destination':
                    await this._newDestination();
                    break;

                case 'invite':
                    await this._newDestination(btn.dataset.viewer);
                    break;

                case 'copy-destination':
                    await this._copy(btn);
                    break;
            }
        } catch (err) {
            this._say('That did not work', err.message);
        }
    }

    async _onSubmit(e) {
        const form = e.target.closest('[data-form="metadata"]');
        if (!form) return;

        e.preventDefault();

        const errorEl = form.querySelector('[data-error]');
        const data = Object.fromEntries(new FormData(form));

        errorEl.hidden = true;

        try {
            this.editing = await api.creator.update(this.editing.id, {
                ...data,
                year: data.year || null,
                fisheyeFov: data.fisheyeFov || null
            });

            await this.refresh();
            this.view = 'edit';
            this._render();
        } catch (err) {
            errorEl.textContent = err.message;
            errorEl.hidden = false;
        }
    }

    /**
     * Copy, with a fallback.
     *
     * The async clipboard API needs a secure context, and a creator running
     * this over plain HTTP on a LAN does not have one - so the field is
     * selectable and the failure says "press Ctrl-C" rather than nothing.
     */
    async _copy(btn) {
        const value = btn.dataset.value;
        const original = btn.textContent;

        try {
            await navigator.clipboard.writeText(value);
            btn.textContent = 'Copied';
        } catch {
            this.body.querySelector('.destination-url')?.select();
            btn.textContent = 'Press Ctrl-C';
        }

        setTimeout(() => {
            btn.textContent = original;
        }, 2000);
    }

    /**
     * Enrolment, for a creator with no face on file.
     *
     * Normally this has already happened at registration - the signup dialog
     * runs it, because an account that can broadcast should be one whose
     * holder has been identified before anything else. What is left here is
     * the path for an account that predates that, one that postponed it, and
     * one whose enrolment has to be redone.
     *
     * A passing enrolment mints a portal unlock on the server, because
     * enrolment already is a face check: liveness ran and the face was matched
     * to the document. So the broadcast link that follows is issued without
     * asking for a second selfie thirty seconds after the stronger kind.
     */
    async _startEnrolment() {
        this.view = 'broadcast';
        this.broadcastGate = { state: 'starting' };
        this._render();

        try {
            const consent = await api.identity.consent();
            const started = await api.identity.startEnrolment(consent.version);

            if (started.status === 'verified') {
                await this._enrolled();
                return;
            }

            const flow = started.clientUrl ? window.open(started.clientUrl, 'avr-enrol', 'width=480,height=720') : null;
            this.broadcastGate = {
                state: 'enrolling',
                clientUrl: started.clientUrl,
                blocked: !flow
            };
            this._render();

            for (;;) {
                if (!this.visible) return;

                await sleep(3000);

                const verification = await api.identity.completeEnrolment();
                if (verification.status === 'pending') continue;

                flow?.close();

                if (verification.status !== 'verified') {
                    this.broadcastGate = { state: 'enrol', verification };
                    this._render();
                    return;
                }

                await this._enrolled();
                return;
            }
        } catch (err) {
            this.broadcastGate = errorGate(err);
            this._render();
        }
    }

    /** Back to the Go live panel, now with a face on file. */
    async _enrolled() {
        this.broadcastGate = null;
        this.enrolled = true;
        await this._loadIdentity();
        this._render();
    }

    async _startUpload(file) {
        const wrap = this.body.querySelector('[data-progress]');
        const bar = wrap?.querySelector('.bar > i');
        const text = wrap?.querySelector('[data-progress-text]');

        if (wrap) wrap.hidden = false;

        try {
            const plan = await api.creator.beginUpload(this.editing.id, file);

            // A conventionally-named file already declares its layout; offer it
            // rather than making the creator restate it.
            if (plan.guess && (plan.guess.projection !== 'flat' || plan.guess.stereo !== 'mono')) {
                const form = this.body.querySelector('[data-form="metadata"]');
                if (form) {
                    form.projection.value = plan.guess.projection;
                    form.stereo.value = plan.guess.stereo;
                    if (plan.guess.fisheyeFov && form.fisheyeFov) form.fisheyeFov.value = plan.guess.fisheyeFov;
                }
            }

            await api.uploadFile(plan, file, (pct) => {
                if (bar) bar.style.width = `${pct}%`;
                if (text) text.textContent = `${pct}% · ${formatBytes(file.size)}`;
            });

            if (text) text.textContent = 'Finalising…';
            await api.creator.completeUpload(plan.uploadId);

            this.editing = await api.creator.title(this.editing.id);
            await this.refresh();
            this.view = 'edit';
            this._render();
        } catch (err) {
            if (text) text.textContent = err.message;
            else this._say('The upload did not finish', err.message);
        }
    }
}

/* ---------------------------------------------------------------- helpers -- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Which gate a failed request should render.
 *
 * Read from the server's own code rather than matched against the message
 * text, so rewording an error cannot silently turn a permanent fault back into
 * one the creator is invited to retry forever.
 */
function errorGate(err) {
    switch (err.details?.code) {
        case 'identity_not_configured':
            return { state: 'not_configured' };
        case 'reenrolment_required':
            return { state: 'reenrol' };
        default:
            return { state: 'error', message: err.message, retry: true };
    }
}

/**
 * Every state the face check can be in, as one body of markup.
 *
 * Written as a single function because the states differ only in their words,
 * and eight near-identical templates scattered through the class is how one of
 * them ends up saying something the others do not.
 *
 * It renders inside the Go live panel rather than over the whole portal: the
 * check is about the broadcast, and covering the dashboard with it would say
 * the dashboard was what needed protecting.
 */
function gateBody({ state, message, clientUrl, blocked, verification, retry, stub }) {
    const open = clientUrl
        ? `<p class="muted small">
               Not seeing the camera window?
               <a href="${escapeAttr(clientUrl)}" target="_blank" rel="noopener">Open it here</a>.
           </p>`
        : '';

    const again = retry ? '<button class="btn btn-vr" data-action="retry-check">Try again</button>' : '';

    const back = '<button class="btn btn-secondary sm" data-action="cancel-check">Back</button>';

    // Shown wherever a check is being presented to a human, because the stub
    // approves everyone and a screen that says "confirm it is you" while
    // nothing is confirming anything is the one thing this flow must never do.
    // The window it opens points at `example.invalid`, which is reserved and
    // never resolves - so the failure people actually see is a dead tab.
    const stubNotice = stub
        ? `<div class="notice stub-notice">
               <strong>No identity provider is configured.</strong>
               This server is running the development stub, which approves every document
               and every face without checking anything, and the window it opens
               (<code>example.invalid</code>) is a placeholder that will not load — close it.
               Set <code>AVR_DIDIT_API_KEY</code> and the workflow ids for real checks.
           </div>`
        : '';

    switch (state) {
        case 'starting':
            return gateStep('Starting the check', '<p class="muted">Opening the camera window…</p>');

        case 'waiting':
            return gateStep(
                'Confirm it is you',
                `<p class="muted">
                     Before the broadcast address is issued, take a photo of your face in the window
                     that just opened. It is compared against the photo you enrolled with, so that a
                     stolen password alone cannot put someone else on air as you.
                 </p>
                 ${stubNotice}
                 ${blocked ? '<div class="notice">Your browser blocked the window. Use the link below.</div>' : ''}
                 ${open}
                 ${back}`
            );

        case 'enrolling':
            return gateStep(
                'Verifying your identity',
                `<p class="muted">Follow the steps in the window that just opened.</p>
                 ${stubNotice}
                 ${blocked ? '<div class="notice">Your browser blocked the window. Use the link below.</div>' : ''}
                 ${open}`
            );

        case 'denied':
            return gateStep(
                'That did not match',
                `<p class="muted">${escapeHtml(message || 'The face did not match your enrolled identity.')}</p>
                 <p class="muted small">
                     If this is your account and it keeps failing, try better light and remove glasses.
                     If it is not your account, change your password now.
                 </p>
                 ${again}
                 ${back}`
            );

        case 'enrol':
            return gateStep(
                'Verify your identity first',
                `<p class="muted">
                     Broadcasting needs a one-off identity check: a government document and a photo
                     of your face. The photo is what the check before each broadcast is compared
                     against. Everything else in Studio works without it.
                 </p>
                 ${
                     verification?.declineReason
                         ? `<div class="field-error">${escapeHtml(verification.declineReason)}</div>`
                         : ''
                 }
                 <button class="btn btn-vr" data-action="enrol">Start verification</button>`
            );

        // Distinct from 'error' because retrying cannot fix it and saying
        // "temporarily unavailable, try again" sends whoever reads it looking
        // for a fault at the provider that is not there. No env var names: a
        // creator cannot act on them, and the server names them at startup and
        // in its log for the person who can.
        case 'not_configured':
            return gateStep(
                'Verification is not set up yet',
                `<p class="muted">
                     This server has not finished being configured for identity checks, so there is
                     no way to verify you right now. Nothing is wrong with your account, and trying
                     again will not help until an administrator finishes the setup.
                 </p>`
            );

        // The provider no longer holds the face this creator enrolled, so there
        // is nothing for a selfie to be compared against. Offers enrolment
        // rather than a retry, because a retry is the one thing that cannot
        // work. Deliberately not phrased as a failed match: they did nothing
        // wrong, and telling them their face did not match would be both untrue
        // and alarming.
        case 'reenrol':
            return gateStep(
                'Please verify your identity again',
                `<p class="muted">
                     We can no longer check your face against the identity you enrolled, so you will
                     need to go through verification once more before you can broadcast. This can
                     happen if your details were erased at your request or your verification aged out.
                 </p>
                 <button class="btn btn-vr" data-action="enrol">Start verification</button>`
            );

        default:
            return gateStep('The check could not be completed', `<p class="muted">${escapeHtml(message ?? '')}</p>${again}${back}`);
    }
}

function gateStep(heading, inner) {
    return `<div class="gate-step"><h4 class="gate-heading">${heading}</h4>${inner}</div>`;
}

function gatePanel(heading, inner) {
    return `<section class="panel"><h3 class="section-title">${heading}</h3>${inner}</section>`;
}

function statTile(label, value) {
    return `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
}

/**
 * The four rates on one line, in dollars.
 *
 * Read-only here. Changing them is one click away on the profile page, and two
 * places that both edit the same four numbers is how they end up disagreeing.
 */
function priceSummary(c) {
    const rate = (amount, enabled = true) => (!enabled ? 'off' : amount > 0 ? dollars(amount) : 'free');

    return (
        [
            `Public 2D ${rate(c.public2dPerMin)}`,
            `public 3D ${rate(c.public3dPerMin, c.public3dEnabled)}`,
            `1:1 2D ${rate(c.private2dPerMin)}`,
            `1:1 3D ${rate(c.private3dPerMin, c.private3dEnabled)}`
        ].join(' · ') + ' — a minute'
    );
}

function endpointRow(label, url) {
    return `
        <div class="endpoint">
            <div class="endpoint-label">${label}</div>
            <code>${escapeHtml(url)}</code>
        </div>`;
}

function option(value, label, current) {
    return `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
}

/**
 * The badge in the titles table.
 *
 * The short shape plus the depth tag, because a pill in a table cell has no
 * room for the full layout name — and the editor two clicks away states it in
 * full. Both halves are words that appear elsewhere in the product rather than
 * the `SBS 3D` / `OU 3D` shorthand this used to invent for itself.
 */
function formatLabel(t) {
    const shape =
        t.projection === PROJECTION.FISHEYE && t.fisheyeFov
            ? `${t.fisheyeFov}° fisheye`
            : (PROJECTION_LABELS[t.projection] ?? PROJECTION_LABELS[PROJECTION.FLAT]);

    return `${shape} · ${depthTag(t.stereo)}`;
}

/** Small diagram showing how the source frame maps to what each eye sees. */
function previewSvg(t) {
    const split =
        t.stereo === STEREO.SBS
            ? '<line x1="60" y1="10" x2="60" y2="70" stroke="var(--stereo)" stroke-width="2" stroke-dasharray="4 3"/>'
            : t.stereo === STEREO.TB
              ? '<line x1="10" y1="40" x2="110" y2="40" stroke="var(--stereo)" stroke-width="2" stroke-dasharray="4 3"/>'
              : '';

    const shape = {
        [PROJECTION.FLAT]: '<rect x="140" y="22" width="70" height="40" rx="4" fill="none" stroke="var(--vr)" stroke-width="2"/>',
        [PROJECTION.DOME180]: '<path d="M140 62 A35 35 0 0 1 210 62" fill="none" stroke="var(--vr)" stroke-width="2"/><line x1="138" y1="62" x2="212" y2="62" stroke="var(--vr)" stroke-width="2"/>',
        [PROJECTION.SPHERE360]: '<circle cx="175" cy="40" r="30" fill="none" stroke="var(--vr)" stroke-width="2"/><ellipse cx="175" cy="40" rx="30" ry="11" fill="none" stroke="var(--vr)" stroke-width="1.5"/>',
        [PROJECTION.FISHEYE]: '<circle cx="175" cy="40" r="30" fill="none" stroke="var(--vr)" stroke-width="2"/><circle cx="175" cy="40" r="14" fill="none" stroke="var(--vr)" stroke-width="1.5"/>'
    }[t.projection];

    return `
        <svg viewBox="0 0 230 80" width="100%" height="80" role="img" aria-label="Format preview">
            <rect x="10" y="10" width="100" height="60" rx="4" fill="rgba(255,255,255,0.06)"
                  stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>
            ${split}
            <text x="60" y="79" text-anchor="middle" font-size="8" fill="var(--text-faint)">source frame</text>
            <path d="M118 40 L132 40" stroke="var(--text-faint)" stroke-width="1.5" marker-end="url(#a)"/>
            <defs><marker id="a" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0 0 L6 3 L0 6 z" fill="var(--text-faint)"/></marker></defs>
            ${shape}
            <text x="175" y="79" text-anchor="middle" font-size="8" fill="var(--text-faint)">in headset</text>
        </svg>`;
}

/**
 * How long somebody has been waiting, in the roundest terms that are still true.
 *
 * Seconds for the first minute because that is the interval a creator is
 * actually watching, whole minutes after that because nobody picks a viewer on
 * the strength of thirteen seconds.
 */
function formatWait(seconds) {
    const s = Math.max(0, Math.round(seconds ?? 0));
    if (s < 60) return `${s}s`;

    const mins = Math.round(s / 60);
    return mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const escapeAttr = escapeHtml;
