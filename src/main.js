import * as pc from 'playcanvas';

import './styles/netflix.css';

import { createEngine, createCameraRig, MagicWindowControls } from './app/engine.js';
import { loadCatalog } from './catalog/catalog.js';
import { AFFILIATES_ONLY } from './site-mode.js';
import { isImmersive, PROJECTION } from './catalog/media-format.js';
import { VideoSource } from './player/video-source.js';
import { ImmersivePlayer } from './player/immersive-player.js';
import { BrowseUI } from './ui/browse.js';
import { PlayerUI } from './ui/player-ui.js';
import { VrUI } from './ui/vr-ui.js';
import { CompatPanel } from './ui/compat-panel.js';
import { api } from './api/client.js';
import { authModal } from './ui/auth-modal.js';
import { CreatorPortal } from './ui/creator/portal.js';
import { ProfilePage } from './ui/profile.js';
import { initAgeGate } from './ui/age-gate.js';
import { initImageGate } from './ui/image-gate.js';
import { allowPlayback } from './ui/video-gate.js';
import { onAgeChange } from './age-state.js';

/**
 * Application shell.
 *
 * Three presentation modes share one video element and one catalog:
 *
 *   browse    - the DOM library
 *   flat      - a plain <video>, used when the title is 2D rectilinear and we
 *               are not in a headset (native controls, PiP, casting all work)
 *   rendered  - the PlayCanvas surface, used for any immersive projection and
 *               for everything once an XR session starts
 *
 * Switching between flat and rendered never reloads the media, so a viewer can
 * drop into VR mid-scene and come back out without losing their place.
 */

const MODE = { BROWSE: 'browse', FLAT: 'flat', RENDERED: 'rendered' };

/**
 * Paths this document owns. Everything else at the root is a channel name.
 *
 * The same rule lives on the server, in the `routes` group of
 * `server/channels/slug.js`, which is what stops a name here being issued in
 * the first place. Both have to change when a route is added - this one so the
 * page does not look the route up as a channel, that one so nobody is holding
 * the name by the time it exists.
 */
const APP_PATHS = new Set(['/', '/index.html', '/creator', '/profile']);

async function boot() {
    const canvas = document.getElementById('render-canvas');
    const browseMount = document.getElementById('browse-root');
    const playerShell = document.getElementById('player-shell');

    const app = createEngine(canvas);
    const { root: cameraRoot, camera } = createCameraRig(app);
    const magicWindow = new MagicWindowControls(app, camera);

    const caps = { xrSupported: false };

    // Restoring the session runs alongside the catalog fetch rather than
    // blocking it: the library renders for signed-out visitors just the same,
    // and personalisation is layered on when it arrives.
    // Affiliate-only mode renders none of the library, and a catalogue that is
    // fetched but not drawn is still a catalogue handed to anybody who opens
    // the network tab. Hiding it in the DOM is not the same as not sending it.
    const [catalog] = await Promise.all([
        AFFILIATES_ONLY ? Promise.resolve({ items: [], rows: [] }) : loadCatalog(),
        detectXr(app, caps),
        api.restore().catch(() => null)
    ]);

    const video = new VideoSource(app);
    playerShell.appendChild(video.element);

    const immersivePlayer = new ImmersivePlayer(app, video, cameraRoot, camera);
    immersivePlayer.setActive(false);

    const browse = new BrowseUI(browseMount, catalog, caps);
    const playerUI = new PlayerUI(playerShell, video, caps);
    const vrUI = new VrUI(app, video, camera);
    const compat = new CompatPanel(catalog);
    const portal = new CreatorPortal(document.getElementById('portal-root'));
    const profile = new ProfilePage(document.getElementById('profile-root'));

    browse.renderAccount(api.user);

    // Awaited, and before either fetch below — but it no longer waits on the
    // visitor, only on one same-origin fetch. This used to block the page
    // until the gate was passed; it now resolves as soon as the server says
    // where the visitor stands, draws a banner if they are not through, and
    // lets the page render with every piece of adult artwork covered. The
    // trade is written up at the head of `src/ui/age-gate.js`.
    //
    // Still awaited, for two orderings that matter. `adsEnabled()` reads the
    // answer synchronously and must have it before a slot is drawn — an ad is
    // the one thing on this page that cannot be covered, so it is withheld
    // instead. And the banner should be on the page before the first covered
    // row appears beneath it rather than dropping in on top of it.
    await initAgeGate();

    // One delegated listener, installed once, that offers the same gate when a
    // covered picture is clicked. After the banner rather than before it only
    // because it reads the state the banner just settled; it is inert for a
    // visitor who is already through.
    initImageGate();

    // Not awaited: these are other people's servers, and a slow partner must
    // not hold up the page. Called here and nowhere else — the partner rows
    // are the same for every visitor, signed in or not, so no session change
    // can alter them.
    browse.refreshAffiliates();

    // Same reasoning, separately: the cam feed goes through our own server and
    // is fetched on every load rather than cached, so chaining it behind the
    // partner rows would make a cold affiliate fetch delay a live shelf.
    browse.refreshCams();

    // Passing the gate changes what every row on the page is allowed to show,
    // and the rows are already drawn by then. Re-fetching is what uncovers
    // them: the server picks covered or uncovered per request from the
    // cookie, so the same two calls now come back with the partner's own
    // artwork. Deliberately not a `location.reload()` — a visitor who has
    // just verified should not lose their scroll position and their search as
    // the reward, and nothing here needs a fresh document.
    onAgeChange((age) => {
        if (!age.ok) return;

        browse.refreshAffiliates();
        browse.refreshCams();
    });

    await syncViewerState();

    const state = {
        mode: MODE.BROWSE,
        item: null,
        format: null
    };

    /* ------------------------------------------------------- transitions -- */

    function setMode(mode) {
        state.mode = mode;

        document.body.classList.toggle('is-playing', mode !== MODE.BROWSE);
        document.body.classList.toggle('is-immersive', mode === MODE.RENDERED);

        browse.setVisible(mode === MODE.BROWSE);
        if (mode === MODE.BROWSE) browse.startCreatorPolling();
        else browse.stopCreatorPolling();
        immersivePlayer.setActive(mode === MODE.RENDERED);
        magicWindow.setEnabled(mode === MODE.RENDERED && !app.xr.active);
    }

    /**
     * Start a title.
     *
     * @param {object} item
     * @param {{enterVr?: boolean}} [opts]
     */
    async function playItem(item, opts = {}) {
        // Before `load()`, which is the whole point: it starts the fetch and
        // decodes the first frames, so a check after it would be a cover over
        // a video that is already playing. See `ui/video-gate.js`.
        if (!(await allowPlayback('title'))) return;

        state.item = item;
        state.format = { ...item.format };

        await video.load(item);

        // Resume where the viewer left off, but not within the last 15 seconds -
        // that just replays the credits.
        const resume = browse.getProgress(item.id);
        if (resume > 5 && video.duration - resume > 15) {
            video.seekTo(resume);
        }

        applyFormat(state.format);
        playerUI.setItem(item, state.format);
        vrUI.setItem(item, state.format);

        setMode(isImmersive(state.format) ? MODE.RENDERED : MODE.FLAT);

        magicWindow.reset();
        await video.play();

        if (opts.enterVr) enterVr();
    }

    /** Rebuild the playback surface for a (possibly overridden) format. */
    function applyFormat(format) {
        state.format = format;
        immersivePlayer.setItem(state.item, format);

        const needsRenderer = isImmersive(format) || app.xr.active;
        if (state.mode !== MODE.BROWSE) {
            setMode(needsRenderer ? MODE.RENDERED : MODE.FLAT);
        }
    }

    function enterVr() {
        if (!caps.xrSupported) {
            toast('No WebXR headset detected on this device.');
            return;
        }

        // Immersive sessions always use the rendered surface, even for flat
        // titles - a flat title becomes a cinema screen rather than a DOM video.
        setMode(MODE.RENDERED);
        immersivePlayer.setItem(state.item, state.format);

        app.xr.start(camera.camera, pc.XRTYPE_VR, pc.XRSPACE_LOCALFLOOR, {
            optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
            callback: (err) => {
                if (err) {
                    toast(`Could not enter VR: ${err.message}`);
                    setMode(isImmersive(state.format) ? MODE.RENDERED : MODE.FLAT);
                    return;
                }

                playerUI.setImmersive(true);
                magicWindow.setEnabled(false);
                immersivePlayer.recenter();
            }
        });
    }

    function exitPlayback() {
        if (app.xr.active) {
            app.xr.end();
        }

        if (state.item) {
            browse.saveProgress(state.item.id, video.currentTime);
        }

        // One view event per session, with however much was actually watched.
        if (state.item && video.currentTime > 5) {
            api.recordView(state.item.id, video.currentTime);
        }

        video.pause();
        setMode(MODE.BROWSE);
        playerUI.setImmersive(false);
    }

    /* ------------------------------------------------------------ wiring -- */

    browse.on('play', (item) => playItem(item));
    browse.on('enterVr', (item) => playItem(item, { enterVr: true }));
    browse.on('showCompat', () => compat.open());
    browse.on('notice', (message) => toast(message));

    /**
     * Going to watch a creator.
     *
     * A separate document, because the live path carries its own decoders and
     * has nothing to do with the catalogue. Only fired for a creator who is
     * actually on air - one who is not opens their page inside browse, which
     * is where the prices are.
     */
    browse.on('watchCreator', (creator) => {
        if (creator.live?.sessionId) {
            location.href = `/live/${encodeURIComponent(creator.live.sessionId)}`;
            return;
        }

        // The list moved on between the render and the click.
        toast(`${creator.name} has just gone off air.`);
        browse.refreshCreators();
    });

    // Only while the browse view is actually on screen. Polling behind a player
    // is a request every fifteen seconds for a list nobody can see.
    browse.startCreatorPolling();

    /* ------------------------------------------------------------ account -- */

    /**
     * Pull server-side progress and My List over the local copies.
     *
     * Signed out, the app keeps using localStorage - which is why the library
     * stays fully usable without an account. Signing in promotes that state to
     * something that follows you onto a headset.
     */
    async function syncViewerState() {
        if (!api.signedIn) return;

        const state = await api.viewerState();

        for (const [titleId, entry] of Object.entries(state.progress ?? {})) {
            browse.progress[titleId] = entry.position;
        }
        for (const id of state.myList ?? []) browse.myList.add(id);
    }

    browse.on('signIn', async () => {
        const user = await authModal.open('login');
        if (!user) return;

        browse.renderAccount(user);
        await syncViewerState();
        browse._applyFilter('all');
        toast(`Signed in as ${user.displayName}`);
    });

    browse.on('signUp', async () => {
        const user = await authModal.open('register');
        if (!user) return;

        browse.renderAccount(user);
        await syncViewerState();
        browse._applyFilter('all');
        toast(`Welcome, ${user.displayName}`);
    });

    browse.on('signOut', async () => {
        await api.logout();
        browse.renderAccount(null);
        toast('Signed out');
    });

    // The publisher agreement and the one-time ID check, then Studio. The
    // dialog owns both, because they are the same two steps a creator signup
    // runs - only the account already exists.
    browse.on('becomeCreator', async () => {
        const user = await authModal.openBecomeCreator();
        if (!api.isCreator) return;

        browse.renderAccount(user ?? api.user);
        toast('Creator account enabled. Opening Studio…');
        history.pushState({ portal: true }, '', '/creator');
        portal.open();
    });

    browse.on('openProfile', async () => {
        if (!api.signedIn) {
            const user = await authModal.open('login', 'Sign in to see your profile.');
            if (!user) return;
            browse.renderAccount(user);
        }

        history.pushState({ profile: true }, '', '/profile');
        await profile.open();
    });

    window.addEventListener('avr:exit-profile', () => {
        profile.close();
        history.pushState({}, '', '/');
        browse.refreshCreators();
        // Something may have been listed or taken down while they were in there.
        browse.refreshRecordings();
    });

    browse.on('openStudio', () => openStudio());

    async function openStudio() {
        if (!api.signedIn) {
            const user = await authModal.open('login', 'Sign in to open Creator Studio.');
            if (!user) return;
            browse.renderAccount(user);
        }

        if (!api.isCreator) {
            toast('This account is not a creator account yet.');
            return;
        }

        history.pushState({ portal: true }, '', '/creator');
        portal.open();
    }

    // Studio and the profile page each hold half of what going live needs —
    // Studio the titles and the feed, the profile page the checks and the
    // prices — so each has a door to the other rather than a trip through home.
    window.addEventListener('avr:open-profile', async () => {
        history.pushState({ profile: true }, '', '/profile');
        await profile.open('going-live');
    });

    window.addEventListener('avr:open-studio', () => {
        profile.close();
        openStudio();
    });

    window.addEventListener('avr:exit-portal', () => {
        history.pushState({}, '', '/');
        if (AFFILIATES_ONLY) return;

        // A newly published title should show up immediately on return.
        loadCatalog()
            .then((fresh) => {
                catalog.items = fresh.items;
                catalog.rows = fresh.rows;
                browse.catalog = fresh;
                browse._applyFilter('all');
            })
            .catch(() => {});
    });

    /* ------------------------------------------------------------ routing -- */

    /**
     * Open a channel by the name in the URL.
     *
     * The address a creator actually hands out. When they are on air it goes
     * to the broadcast; when they are not it opens their page, which is where
     * the prices are - the same two outcomes as clicking them on the home
     * page, because it has to mean the same thing however somebody arrived.
     */
    async function openChannel(slug) {
        let found;

        try {
            found = await api.channels.lookup(slug);
        } catch {
            toast(`There is no channel at /${slug}.`);
            history.replaceState({}, '', '/');
            return;
        }

        if (found.live?.sessionId) {
            location.href = `/live/${encodeURIComponent(found.live.sessionId)}`;
            return;
        }

        // An alias resolves to the canonical name. Replacing rather than
        // pushing: the old link worked, and a back button that walks through
        // the redirect is a back button that cannot leave.
        if (found.canonical && found.canonical !== slug) {
            history.replaceState({ channel: found.canonical }, '', `/${found.canonical}`);
        }

        browse.openCreatorDetails({ ...found.channel, status: 'ready', live: null });
    }

    /**
     * Is this path a channel name, or one of the app's own pages?
     *
     * The shape test is the client half of `validateSlug`; the reserved list
     * is the server's business, because a name that got past it there is a
     * name that exists. Anything this does not recognise falls through to the
     * catalogue, which is what the SPA did before names existed.
     */
    function channelSlugFrom(pathname) {
        if (APP_PATHS.has(pathname)) return null;

        const match = /^\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/?$/.exec(pathname.toLowerCase());
        return match ? match[1] : null;
    }

    function route() {
        if (location.pathname === '/creator') openStudio();
        else portal.close();

        if (location.pathname === '/profile') profile.open();
        else profile.close();

        const slug = channelSlugFrom(location.pathname);
        if (slug) openChannel(slug);
        else browse.closeDetails();
    }

    // Closing the channel card puts the URL back, so the address bar and what
    // is on screen do not disagree.
    browse.on('detailsClosed', () => {
        if (channelSlugFrom(location.pathname)) history.replaceState({}, '', '/');
    });

    window.addEventListener('popstate', route);

    api.addEventListener('session', (e) => {
        browse.renderAccount(e.detail);
        // Signing in or out changes both what the market route will answer and
        // which of those recordings this account already owns.
        browse.refreshRecordings();
    });

    playerUI.on('back', exitPlayback);
    playerUI.on('enterVr', enterVr);
    playerUI.on('recenter', () => immersivePlayer.recenter());
    playerUI.on('formatChange', (format) => {
        applyFormat(format);
        vrUI.setItem(state.item, format);
    });

    vrUI.on('exitVr', () => app.xr.end());
    vrUI.on('back', exitPlayback);
    vrUI.on('recenter', () => immersivePlayer.recenter());
    vrUI.on('formatChange', (format) => {
        applyFormat(format);
        playerUI.setItem(state.item, format);
    });

    app.xr.on('end', () => {
        playerUI.setImmersive(false);
        // Flat titles go back to the DOM player; immersive ones stay on the
        // rendered surface as a magic window.
        setMode(isImmersive(state.format) ? MODE.RENDERED : MODE.FLAT);
        magicWindow.setEnabled(isImmersive(state.format));
    });

    video.on('ended', () => {
        if (!state.item) return;
        browse.saveProgress(state.item.id, 0);
        api.recordView(state.item.id, video.duration);
    });

    video.on('error', (message) => toast(`Playback error - ${message}`));

    // Save resume position periodically and on unload rather than every tick.
    setInterval(() => {
        if (state.mode !== MODE.BROWSE && state.item && !video.paused) {
            browse.saveProgress(state.item.id, video.currentTime);
        }
    }, 5000);

    window.addEventListener('pagehide', () => {
        if (state.item) browse.saveProgress(state.item.id, video.currentTime);
    });

    /* ------------------------------------------------------------- frame -- */

    app.on('update', (dt) => {
        if (state.mode === MODE.RENDERED || app.xr.active) {
            video.updateTexture();
            immersivePlayer.update(dt);
            magicWindow.update(dt);
            vrUI.update(dt);
        }
    });

    app.start();

    route();

    // Deep link: /?play=<id> jumps straight into a title, which is how the
    // compatibility panel's QR codes get you into the right video.
    const params = new URLSearchParams(location.search);
    const deepLink = params.get('play');
    if (deepLink) {
        const item = catalog.items.find((i) => i.id === deepLink);
        if (item) {
            // Autoplay policy still applies, so this needs one gesture.
            toast(`Tap anywhere to start "${item.title}"`);
            window.addEventListener(
                'pointerdown',
                () => playItem(item, { enterVr: params.get('vr') === '1' }),
                { once: true }
            );
        }
    }
}

/**
 * Probe for an immersive-vr capable device.
 *
 * @param {pc.Application} app
 * @param {{xrSupported: boolean}} caps
 */
async function detectXr(app, caps) {
    if (!app.xr.supported) return;

    caps.xrSupported = app.xr.isAvailable(pc.XRTYPE_VR);

    // Availability can resolve after boot when a headset is connected later.
    app.xr.on('available:immersive-vr', (available) => {
        caps.xrSupported = available;
    });
}

let toastTimer = null;
function toast(message) {
    let el = document.querySelector('.toast');
    if (!el) {
        el = document.createElement('div');
        el.className = 'toast';
        document.body.appendChild(el);
    }

    el.textContent = message;
    el.classList.add('show');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

boot().catch((err) => {
    console.error(err);
    document.body.innerHTML = `<div class="empty-state"><h2>Failed to start</h2><p>${err.message}</p></div>`;
});
