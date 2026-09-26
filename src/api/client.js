/**
 * API client and session state.
 *
 * The access token is held in memory only - never localStorage - so a
 * cross-site scripting bug cannot exfiltrate a durable credential. Durability
 * comes from the refresh cookie, which is httpOnly and therefore invisible to
 * page JavaScript entirely.
 *
 * A 401 triggers one silent refresh and one retry. Concurrent 401s share a
 * single refresh promise, so a page that fires six requests at once after the
 * token expires performs one refresh rather than six.
 */

const PORTAL_UNLOCK_KEY = 'avr_portal_unlock';

class ApiClient extends EventTarget {
    constructor() {
        super();
        this.accessToken = null;
        this.user = null;
        this._refreshing = null;
    }

    get signedIn() {
        return !!this.user;
    }

    /**
     * The creator portal's face-check token.
     *
     * `sessionStorage` rather than `localStorage`, and that is the whole
     * mechanism behind "once per browser session": it dies with the tab, a
     * second browser gets its own check, and it is never shared across a
     * restart. Read through a getter because another tab of the same site can
     * write it, and because a private-mode browser can throw on access.
     */
    get portalUnlock() {
        try {
            return sessionStorage.getItem(PORTAL_UNLOCK_KEY);
        } catch {
            return null;
        }
    }

    set portalUnlock(token) {
        try {
            if (token) sessionStorage.setItem(PORTAL_UNLOCK_KEY, token);
            else sessionStorage.removeItem(PORTAL_UNLOCK_KEY);
        } catch {
            /* Private mode. The portal simply asks for a face check again. */
        }
    }

    get isCreator() {
        return this.user?.role === 'creator' || this.user?.role === 'admin';
    }

    _emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { detail }));
    }

    _setSession({ user, accessToken, ageAssurance, verification, adultConfirmed }) {
        this.user = user ?? null;
        this.accessToken = accessToken ?? null;

        // Every response that establishes a session carries these, so the
        // client never has to ask separately where the account stands - and
        // never renders a catalogue on the assumption that it has passed.
        this.ageAssurance = user ? (ageAssurance ?? null) : null;
        this.verification = user ? (verification ?? null) : null;
        this.adultConfirmed = user ? Boolean(adultConfirmed) : false;

        this._emit('session', this.user);
        return this.user;
    }

    /**
     * Old enough to be here.
     *
     * Not the same question as "passed the age check". A creator establishes
     * their age through the enrolment instead, and the server says so in
     * `adultConfirmed` rather than leaving the page to work it out from two
     * separate blocks. See docs/IDENTITY.md.
     */
    get ageVerified() {
        return this.adultConfirmed || this.ageAssurance?.status === 'verified';
    }

    /** Whether this creator has a face on file at all. */
    get enrolled() {
        return this.verification?.status === 'verified';
    }

    /**
     * Core fetch wrapper.
     *
     * @param {string} path
     * @param {RequestInit & {raw?: boolean, retry?: boolean}} [options]
     */
    async request(path, options = {}) {
        const { raw = false, retry = true, headers = {}, ...rest } = options;

        const finalHeaders = { ...headers };
        if (this.accessToken) finalHeaders.Authorization = `Bearer ${this.accessToken}`;
        if (this.portalUnlock) finalHeaders['X-AVR-Portal-Unlock'] = this.portalUnlock;
        if (rest.body && typeof rest.body === 'string' && !finalHeaders['Content-Type']) {
            finalHeaders['Content-Type'] = 'application/json';
        }

        const res = await fetch(path, { credentials: 'same-origin', ...rest, headers: finalHeaders });

        if (res.status === 401 && retry && this.user) {
            // The token probably just expired. Refresh once, then replay.
            const refreshed = await this._refresh();
            if (refreshed) return this.request(path, { ...options, retry: false });
        }

        if (raw) return res;

        if (res.status === 204) return null;

        const text = await res.text();
        const data = text ? safeJson(text) : null;

        // A 200 that is not JSON is not a success. In practice it is the SPA
        // fallback answering for a route the running server does not have -
        // an old process, or a path that was never mounted - and returning
        // null for it turns a missing endpoint into a TypeError thrown
        // somewhere far away, or a screen that waits for a value forever.
        if (res.ok && text && data === null && text.trim() !== 'null') {
            const error = new Error(`${path} did not return JSON — is the server running the current code?`);
            error.status = res.status;
            throw error;
        }

        if (!res.ok) {
            const error = new Error(data?.error || `Request failed (${res.status})`);
            error.status = res.status;
            error.details = data;
            throw error;
        }

        return data;
    }

    get(path) {
        return this.request(path);
    }

    post(path, body) {
        return this.request(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    }

    patch(path, body) {
        return this.request(path, { method: 'PATCH', body: JSON.stringify(body) });
    }

    del(path) {
        return this.request(path, { method: 'DELETE' });
    }

    /* ------------------------------------------------------------- session -- */

    async _refresh() {
        // Collapse concurrent refreshes into one in-flight request.
        this._refreshing ??= (async () => {
            try {
                const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
                if (!res.ok) throw new Error('refresh failed');

                const data = await res.json();
                this._setSession(data);
                this._scheduleRefresh(data.expiresIn);
                return true;
            } catch {
                this._setSession({ user: null, accessToken: null });
                return false;
            } finally {
                this._refreshing = null;
            }
        })();

        return this._refreshing;
    }

    /** Refresh a minute before expiry so a request never races the deadline. */
    _scheduleRefresh(expiresIn) {
        clearTimeout(this._refreshTimer);
        if (!expiresIn) return;

        const delay = Math.max((expiresIn - 60) * 1000, 30_000);
        this._refreshTimer = setTimeout(() => this._refresh(), delay);
    }

    /**
     * Restore a session on page load.
     *
     * Skips the network entirely when the readable session hint is absent,
     * so an anonymous visitor costs zero auth requests. The hint carries no
     * authority - the httpOnly refresh cookie is still what actually proves
     * anything - it just prevents a guaranteed-401 round trip.
     */
    async restore() {
        if (!document.cookie.split('; ').some((c) => c.startsWith('avr_session='))) {
            return null;
        }

        const ok = await this._refresh();
        return ok ? this.user : null;
    }

    /** The wording the signup form has to show, and the versions it sends back. */
    agreements() {
        return this.get('/api/auth/agreements');
    }

    /**
     * @param {{email: string, password: string, displayName: string, role: string,
     *          tagline?: string, bio?: string,
     *          acceptedTerms: string, acceptedCreatorTerms?: string}} input
     */
    async register(input) {
        const data = await this.post('/api/auth/register', input);
        this._setSession(data);
        this._scheduleRefresh(data.expiresIn);
        return this.user;
    }

    async login({ email, password }) {
        const data = await this.post('/api/auth/login', { email, password });
        this._setSession(data);
        this._scheduleRefresh(data.expiresIn);
        return this.user;
    }

    async logout() {
        clearTimeout(this._refreshTimer);
        await this.request('/api/auth/logout', { method: 'POST', raw: true, retry: false }).catch(() => {});
        this.portalUnlock = null;
        this._setSession({ user: null, accessToken: null });
    }

    /** @param {string} acceptedCreatorTerms the version of the agreement that was shown */
    async becomeCreator(acceptedCreatorTerms) {
        const data = await this.post('/api/auth/become-creator', { acceptedCreatorTerms });
        this._setSession({
            user: data.user,
            accessToken: data.accessToken ?? this.accessToken,
            ageAssurance: data.ageAssurance,
            verification: data.verification,
            adultConfirmed: data.adultConfirmed
        });
        return this.user;
    }

    /* -------------------------------------------------------- viewer state -- */

    async viewerState() {
        if (!this.signedIn) return { progress: {}, myList: [] };
        return this.get('/api/state').catch(() => ({ progress: {}, myList: [] }));
    }

    saveProgress(titleId, position, completed = false) {
        if (!this.signedIn) return Promise.resolve();
        return this.request(`/api/progress/${encodeURIComponent(titleId)}`, {
            method: 'PUT',
            body: JSON.stringify({ position, completed })
        }).catch(() => {});
    }

    setMyList(titleId, member) {
        if (!this.signedIn) return Promise.resolve();
        return this.request(`/api/my-list/${encodeURIComponent(titleId)}`, {
            method: 'PUT',
            body: JSON.stringify({ member })
        }).catch(() => {});
    }

    recordView(titleId, seconds) {
        return this.request(`/api/views/${encodeURIComponent(titleId)}`, {
            method: 'POST',
            body: JSON.stringify({ seconds }),
            raw: true
        }).catch(() => {});
    }

    /* ------------------------------------------------------------- identity -- */

    /**
     * Identity verification.
     *
     * Three separate things, deliberately not merged:
     *
     *   age     one document check per account, viewers included, no selfie
     *   enrol   creators only - document plus a selfie, the face to match later
     *   portal  a selfie against that enrolment, once per browser session
     *
     * Every `complete` is a prompt to go and ask the provider, never a claim
     * about the result. The client cannot report its own verdict.
     */
    identity = {
        consent: () => this.get('/api/identity/consent'),
        status: () => this.get('/api/identity/status'),

        startAge: (consentVersion) =>
            this.post('/api/identity/age', {
                consent: true,
                consentVersion,
                redirectUrl: `${location.origin}${location.pathname}`
            }),
        completeAge: () => this.post('/api/identity/age/complete').then((d) => d.ageAssurance),

        startEnrolment: (consentVersion) =>
            this.post('/api/identity/enrol', {
                consent: true,
                consentVersion,
                redirectUrl: `${location.origin}${location.pathname}`
            }),
        /**
         * Stores the unlock the server sends with a passing verdict, on the
         * same reasoning as `completePortalUnlock` below. Enrolment is itself a
         * face check, so clearing it opens the portal without a second selfie.
         */
        completeEnrolment: async () => {
            const data = await this.post('/api/identity/enrol/complete');
            if (data.unlockToken) this.portalUnlock = data.unlockToken;
            return data.verification;
        },

        startPortalUnlock: () => this.post('/api/identity/portal/unlock'),

        /** Stores the token on success, which is what the header is then read from. */
        completePortalUnlock: async (id) => {
            const data = await this.post(`/api/identity/portal/unlock/${encodeURIComponent(id)}/complete`);
            if (data.status === 'approved') this.portalUnlock = data.unlockToken;
            return data;
        },

        /**
         * @param {string} [name] what the destination should be called in the capture app
         * @param {string} [viewerId] a waiting viewer to make the broadcast private to
         */
        startDestination: (name, viewerId) =>
            this.post('/api/identity/broadcast/destination', { name, viewerId }),
        completeDestination: (id) =>
            this.post(`/api/identity/broadcast/destination/${encodeURIComponent(id)}/complete`),

        events: () => this.get('/api/identity/events').then((d) => d.events),
        forget: () => this.del('/api/identity/me')
    };

    /* ----------------------------------------------------------------- live -- */

    live = {
        /** Who has the monitor page open and is available to be broadcast to. */
        waiting: () => this.get('/api/live/waiting').then((d) => d.viewers),

        register: () => this.post('/api/live/waiting'),

        /** The creator's end: has the camera turned up in the room they opened? */
        room: (roomId) => this.get(`/api/live/rooms/${encodeURIComponent(roomId)}`),

        status: (viewerId, admitToken) =>
            this.post(`/api/live/waiting/${encodeURIComponent(viewerId)}`, { admitToken }),

        /**
         * Leave the waiting list on the way out of the page.
         *
         * `sendBeacon` because `pagehide` is the only event that reliably fires
         * on a phone, and a `fetch` started there is cancelled with the
         * document. It cannot set an Authorization header, which is why the
         * endpoint behind it authorises on the admission secret instead.
         */
        leave(viewerId, admitToken) {
            const body = new Blob([JSON.stringify({ admitToken })], { type: 'application/json' });
            navigator.sendBeacon(`/api/live/waiting/${encodeURIComponent(viewerId)}/leave`, body);
        },

        /** What this broadcast costs, asked before joining rather than after. */
        quote: (sessionId, admit = null) => {
            const query = admit ? `?admit=${encodeURIComponent(admit)}` : '';
            // `oneToOne` rides along because the page needs both answers before
            // it draws anything - what a minute costs, and whether there is a
            // private turn to ask for - and they come from one route.
            return this.get(`/api/live/watch/${encodeURIComponent(sessionId)}${query}`).then((d) => ({
                ...d.quote,
                oneToOne: d.oneToOne ?? null
            }));
        },

        /** Switch between 2D and 3D. Applies from the next minute boundary. */
        mode: (sessionId, mode) => this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/mode`, { mode }),

        /* --------------------------------------------------------- one to one -- */

        /** Ask the creator for a private turn. Asking twice asks once. */
        askPrivate: (sessionId) =>
            this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/private`).then((d) => d.request),

        /**
         * Where my own request stands, and the admission secret if it was taken.
         *
         * The answer normally arrives on the socket, but an acceptance lands in
         * the same instant as the close that evicts everybody watching - so this
         * is the path that is always there.
         */
        privateStatus: (sessionId) =>
            this.get(`/api/live/watch/${encodeURIComponent(sessionId)}/private`).then((d) => d.oneToOne),

        cancelPrivate: (requestId) => this.post(`/api/live/private/${encodeURIComponent(requestId)}/cancel`),

        /** The creator's end: who is asking right now. */
        privateRequests: (sessionId) => this.get(`/api/live/broadcasts/${encodeURIComponent(sessionId)}/requests`),

        acceptPrivate: (requestId) => this.post(`/api/live/private/${encodeURIComponent(requestId)}/accept`),

        declinePrivate: (requestId) => this.post(`/api/live/private/${encodeURIComponent(requestId)}/decline`),

        /** End the turn. Either party may, and it is the same call for both. */
        endPrivate: (sessionId) => this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/private/end`),

        /* ---------------------------------------------------------- recording -- */

        /**
         * Recording a 1:1.
         *
         * Only the creator's side is here, because only the creator's side
         * involves the server: their recording is made by an FFmpeg attached
         * to the live session and contains what the phone sent. The viewer's
         * recording is made in their own browser by `ViewerRecorder` and never
         * leaves it - the only thing these routes do for the viewer is carry
         * the permission question to the creator and the answer back.
         */
        recording: {
            /**
             * Both sides poll this. The creator gets `{mine, available,
             * policy, asked}`; the viewer gets `{viewer, creatorRecording}`.
             */
            state: (sessionId) => this.get(`/api/live/watch/${encodeURIComponent(sessionId)}/recording`),

            start: (sessionId) => this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/recording/start`),

            /** Resolves once FFmpeg has finalised the file, not when it is asked to. */
            stop: (sessionId) => this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/recording/stop`),

            /** Viewer: may I record this? */
            askConsent: (sessionId) =>
                this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/recording/consent`),

            /** Creator: yes or no. */
            answerConsent: (sessionId, allow) =>
                this.post(`/api/live/watch/${encodeURIComponent(sessionId)}/recording/consent/answer`, { allow })
        }
    };

    /* ----------------------------------------------------------- recordings -- */

    /**
     * The recording marketplace.
     *
     * What is on sale is the creator's own recording of a 1:1. There is no
     * call here that uploads one, because the other recording of the same
     * conversation - the viewer's, with both voices in it - is theirs and
     * stays on their disk.
     */
    recordings = {
        /** The creator's own, listed or not, failures included. */
        mine: () => this.get('/api/recordings/mine').then((d) => d.recordings),

        /** @param {{title: string, price: number}} listing price in credits */
        list: (id, listing) => this.post(`/api/recordings/${encodeURIComponent(id)}/list`, listing).then((d) => d.recording),

        unlist: (id) => this.post(`/api/recordings/${encodeURIComponent(id)}/unlist`).then((d) => d.recording),

        /** @param {'2d'|'3d'|null} [tag] filter on what was captured */
        market: (tag = null) => this.get(`/api/recordings/market${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`),

        purchased: () => this.get('/api/recordings/purchased').then((d) => d.recordings),

        /** @throws with `status: 402` and `details.error` of `insufficient_credits` */
        buy: (id) => this.post(`/api/recordings/${encodeURIComponent(id)}/buy`),

        /**
         * Where the bytes are. A plain URL rather than a fetch, so the browser
         * can range-request it into a `<video>` and the file never has to sit
         * in the page's memory. It is checked against the sale on every
         * request; the storage key is never exposed.
         *
         * A `<video>` element cannot carry an Authorization header, so the
         * token rides in the query - which the server accepts on GETs only.
         */
        fileUrl: (id) => {
            const token = this.accessToken ? `?access_token=${encodeURIComponent(this.accessToken)}` : '';
            return `/api/recordings/${encodeURIComponent(id)}/file${token}`;
        }
    };

    /* ------------------------------------------------------------- profiles -- */

    profile = {
        /** Everything the profile page shows: picture, text, credits, pricing. */
        mine: () => this.get('/api/profile'),

        save: (patch) => this.patch('/api/profile', patch).then((d) => d.profile),

        /**
         * Replace the profile picture.
         *
         * The raw file as the body rather than multipart: it is one field, and
         * a multipart parser is a dependency and an attack surface bought to
         * encode a boundary around bytes we already have.
         */
        setAvatar: (file) =>
            this.request('/api/profile/avatar', {
                method: 'PUT',
                body: file,
                headers: { 'Content-Type': file.type }
            }).then((d) => d.profile),

        clearAvatar: () => this.del('/api/profile/avatar').then((d) => d.profile),

        /** Pricing and the 3D switches. Rejects with a 409 if 3D is unproven. */
        saveCreator: (patch) => this.patch('/api/profile/creator', patch),

        /** Somebody else's, public. */
        creator: (id) => this.get(`/api/creators/${encodeURIComponent(id)}`)
    };

    /** Who is on air now, and who is signed in and set up. */
    liveCreators = () => this.get('/api/creators/live').then((d) => d.creators);

    /* -------------------------------------------------------------- credits -- */

    credits = {
        summary: () => this.get('/api/credits'),
        ledger: () => this.get('/api/credits/ledger').then((d) => d.entries),
        purchases: () => this.get('/api/credits/purchases').then((d) => d.purchases),

        /** @param {number} amountCents one of the tiers, or a custom amount */
        buy: (amountCents) => this.post('/api/credits/purchases', { amountCents })
    };

    /* --------------------------------------------------------- setup checks -- */

    checks = {
        state: () => this.get('/api/live/checks').then((d) => d.checks),

        /**
         * The broadcast to show the creator while they run a check, if their
         * camera has connected yet. `{preview: null}` until it has.
         */
        preview: () => this.get('/api/live/checks/preview'),

        /**
         * @param {'standard'|'spatial'} kind
         * @throws with `status: 409` and `details.code` of `no_broadcast` or
         *   `not_stereo` when there was nothing to confirm.
         */
        pass: (kind) => this.post(`/api/live/checks/${kind}`, { confirmed: true }).then((d) => d.checks)
    };

    /* -------------------------------------------------------------- creator -- */

    creator = {
        overview: () => this.get('/api/creator/overview'),
        titles: () => this.get('/api/creator/titles').then((d) => d.titles),
        title: (id) => this.get(`/api/creator/titles/${id}`).then((d) => d.title),
        create: (body) => this.post('/api/creator/titles', body).then((d) => d.title),
        update: (id, body) => this.patch(`/api/creator/titles/${id}`, body).then((d) => d.title),
        publish: (id, visibility) => this.post(`/api/creator/titles/${id}/publish`, { visibility }).then((d) => d.title),
        unpublish: (id) => this.post(`/api/creator/titles/${id}/unpublish`).then((d) => d.title),
        remove: (id) => this.del(`/api/creator/titles/${id}`),
        feed: () => this.get('/api/creator/feed'),

        beginUpload: (titleId, file) =>
            this.post(`/api/creator/titles/${titleId}/upload`, { filename: file.name, size: file.size }),

        completeUpload: (uploadId) => this.post(`/api/creator/uploads/${uploadId}/complete`)
    };

    /**
     * Upload a file with progress.
     *
     * Uses XHR rather than fetch because fetch still has no upload progress
     * event - and for a multi-gigabyte VR master, a progress bar is not
     * optional.
     *
     * @param {object} plan - Result of `beginUpload`.
     * @param {File} file
     * @param {(pct: number, loaded: number, total: number) => void} [onProgress]
     * @returns {Promise<void>}
     */
    uploadFile(plan, file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', plan.url, true);

            // The presigned direct-to-storage URL carries its own auth in the
            // signature; sending our bearer token there would break the
            // signature and leak the token to a third party.
            if (plan.mode === 'proxy' && this.accessToken) {
                xhr.setRequestHeader('Authorization', `Bearer ${this.accessToken}`);
            }
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
                }
            };

            xhr.onload = () =>
                xhr.status >= 200 && xhr.status < 300
                    ? resolve()
                    : reject(new Error(`Upload failed (${xhr.status})`));

            xhr.onerror = () => reject(new Error('Upload failed: network error'));
            xhr.onabort = () => reject(new Error('Upload cancelled'));

            this._activeUpload = xhr;
            xhr.send(file);
        });
    }

    cancelUpload() {
        this._activeUpload?.abort();
    }
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export const api = new ApiClient();
