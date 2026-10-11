import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BRAND, DLNA_FRIENDLY_NAME } from '../brand.js';
import { buildLibrary, localPathFor, MEDIA_DIR } from './library.js';
import { getDb, sessions } from './db/index.js';
import { getStorage, assertSafeKey } from './storage/index.js';
import { attachUser } from './auth/middleware.js';
import { mountAuth } from './auth/routes.js';
import { configureSuperuser } from './auth/superuser.js';
import { assertSigningKeyConfigured } from './auth/tokens.js';
import { mountIdentity } from './identity/routes.js';
import { mountIdentityReturn } from './identity/return-page.js';
import { assertIdentityConfigured, getProvider, identityEnforced, identityGaps } from './identity/providers.js';
import { jurisdictionBanner } from './identity/jurisdiction.js';
import { runIdentitySweep } from './identity/retention.js';
import { mountCreator } from './routes/creator.js';
import { mountViewer } from './routes/viewer.js';
import { mountProfiles } from './routes/profiles.js';
import { mountChannels } from './routes/channels.js';
import { mountRecordings } from './routes/recordings.js';
import { mountCredits } from './credits/index.js';
import { paymentsBanner } from './credits/providers.js';
import { mountUnsubscribe } from './mail/unsubscribe.js';
import { mailBanner } from './mail/providers.js';
import { mountDeoVR } from './deovr.js';
import { mountPlaylist } from './playlist.js';
import { mountArt } from './art.js';
import { DlnaServer, lanAddress } from './dlna.js';
import { queueStats } from './media/jobs.js';
import { mountLive, startLive, stopLive, liveBanner, sessions as liveSessions } from './live/index.js';
import { recorders } from './live/recording.js';
import {
    mountTranscode,
    startTranscode,
    stopTranscode,
    transcodeBanner
} from './transcode/index.js';

/**
 * ProjectAVR application server.
 *
 * Stateless by construction: no sessions in memory, no catalog owned by a
 * particular node, no upload state that only one machine knows about. Any
 * request can be served by any node, which is the precondition for scaling
 * horizontally rather than buying a bigger box.
 *
 * See the README's scaling section for what that does and does not buy you.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = process.env.AVR_TRUST_PROXY ?? '1';

/**
 * DLNA binds UDP port 1900 for SSDP, which exactly one process can own.
 *
 * Under the cluster supervisor only the first worker advertises; the rest serve
 * HTTP only. All workers can still answer the DLNA HTTP routes, because those
 * are stateless and the load balancer (or the OS, for cluster) spreads them.
 */
const ENABLE_DLNA = process.env.AVR_DLNA !== '0' && (process.env.AVR_WORKER_INDEX ?? '0') === '0';

const app = express();

app.disable('x-powered-by');

// Behind a load balancer, req.ip and req.protocol are only correct with this
// set - and the rate limiter keys on req.ip, so getting it wrong would bucket
// every user together under the balancer's address.
app.set('trust proxy', TRUST_PROXY === '0' ? false : TRUST_PROXY);

// Compress JSON and manifests. Video is already compressed, and running it
// through gzip would burn CPU for nothing.
app.use(
    compression({
        filter: (req, res) => {
            const type = res.getHeader('Content-Type') ?? '';
            if (/^(video|image)\//.test(String(type))) return false;
            return compression.filter(req, res);
        }
    })
);

app.use(cookieParser());

app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Range, Content-Type, SOAPAction, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.set('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});

// SOAP bodies arrive as XML; keep them raw for the DLNA control endpoint.
app.use('/dlna/control', express.raw({ type: () => true, limit: '512kb' }));

// Every route below can read req.auth; none of them require it.
app.use(attachUser);

// Fail fast on misconfiguration rather than at the first sign-in.
assertSigningKeyConfigured();
assertIdentityConfigured();
getDb();

// After `getDb()`, because it writes to the users table, and at boot because
// the environment is the only place this role can come from.
configureSuperuser();

/* --------------------------------------------------------------- streaming -- */

/**
 * The delivery path.
 *
 * With remote storage this is a 302 to a CDN edge or a presigned bucket URL,
 * and the app is out of the data path for the rest of the stream - that is the
 * property that makes concurrency someone else's problem.
 *
 * With local storage it falls back to serving the bytes itself, which works but
 * puts a hard ceiling on concurrent viewers equal to what one machine's disk
 * and NIC can sustain.
 */
app.get('/stream/*', async (req, res) => {
    const key = decodeURIComponent(String(req.params[0] ?? ''));

    try {
        assertSafeKey(key);
    } catch {
        res.status(400).send('Bad key');
        return;
    }

    const storage = getStorage();

    if (storage.isRemote) {
        // Short cache so the redirect itself is cheap but a signed URL never
        // outlives its signature in a shared cache.
        res.set('Cache-Control', 'private, max-age=60');
        res.redirect(302, storage.deliveryUrl(key));
        return;
    }

    const file = storage.localPath(key);

    if (!file || !fs.existsSync(file)) {
        res.status(404).send('Not found');
        return;
    }

    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(file, { acceptRanges: true });
});

/* ------------------------------------------------------------------- media -- */

/**
 * Byte-range serving for the filesystem library.
 *
 * Range support is not optional: every native VR player seeks by requesting
 * byte ranges, and one that gets a 200 with the whole file will either refuse
 * to scrub or restart the download on every seek.
 */
app.use(
    '/media',
    express.static(MEDIA_DIR, {
        acceptRanges: true,
        cacheControl: true,
        maxAge: '1h',
        dotfiles: 'ignore'
    })
);

/**
 * Alias presenting a file under its conventional name, so SkyBox, Pigasus and
 * Whirligig can read the layout from the last path segment.
 *
 * `?rendition=<name>` picks one rung of the packaged ladder. The filename in
 * the path is decoration for the player's benefit and is never resolved against
 * the filesystem - which is also what keeps this route from being a traversal
 * primitive. Without it, the request means the whole title, as before.
 */
app.get('/media/by-name/:id/:filename', async (req, res) => {
    const { items } = await buildLibrary();
    const item = items.find((i) => i.id === req.params.id);

    if (!item) {
        res.status(404).send('Not found');
        return;
    }

    const wanted = req.query.rendition ? String(req.query.rendition) : null;
    if (wanted) {
        const codec = req.query.codec ? String(req.query.codec) : null;
        const rendition = (item.renditions ?? []).find(
            (r) => r.name === wanted && (!codec || r.codec === codec)
        );
        const url = rendition?.mp4 || rendition?.hls;

        if (!url) {
            res.status(404).send('No such rendition');
            return;
        }

        res.redirect(302, url);
        return;
    }

    if (!item.local || !item.filename) {
        res.redirect(302, item.src);
        return;
    }

    const file = localPathFor(item);
    if (!file || !fs.existsSync(file)) {
        res.status(404).send('Not found');
        return;
    }

    res.sendFile(file, { acceptRanges: true, headers: { 'Content-Type': item.mime || 'video/mp4' } });
});

/* --------------------------------------------------------------------- api -- */

mountAuth(app);
mountIdentity(app);
mountViewer(app);
mountCreator(app);
mountProfiles(app);
mountChannels(app);
mountCredits(app);
mountRecordings(app);
mountLive(app);

// Claims `/live/hls` and `/live/transcode`, so it has to come before the
// `/live/:sessionId` monitor route further down or the catch-all takes them.
mountTranscode(app);

app.get('/api/health', async (req, res) => {
    const { items } = await buildLibrary();

    res.json({
        ok: true,
        lan: lanAddress(),
        port: PORT,
        pid: process.pid,
        titles: items.length,
        storage: getStorage().isRemote ? 's3' : 'local',
        dlna: ENABLE_DLNA,
        live: liveSessions.size,
        worker: queueStats(),
        uptime: Math.round(process.uptime())
    });
});

mountArt(app);
mountDeoVR(app);
mountPlaylist(app);

// Where the identity provider returns the popup. Not under `/api`, and like
// DLNA below it has to claim its path before the SPA fallback - if the
// catch-all answers it with index.html the popup shows the front page, which
// is the bug this page exists to fix.
mountIdentityReturn(app);

// The unsubscribe link in a marketing email. Also not under `/api`, because
// it is a URL a mail client opens rather than something the app calls, and
// also above the fallback for the same reason.
mountUnsubscribe(app);

// DLNA must claim its routes before the SPA fallback, or the catch-all answers
// device discovery with index.html.
const dlna = ENABLE_DLNA ? new DlnaServer({ port: PORT }) : null;
dlna?.mount(app);

/* -------------------------------------------------------------- static app -- */

const DIST = path.join(ROOT, 'dist');

if (fs.existsSync(DIST)) {
    // Hashed asset filenames are safe to cache forever; index.html never is.
    app.use(
        express.static(DIST, {
            setHeaders(res, filePath) {
                if (/\/assets\//.test(filePath)) {
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                } else {
                    res.setHeader('Cache-Control', 'no-cache');
                }
            }
        })
    );
    app.use(express.static(path.join(ROOT, 'public')));

    // The live monitor is its own document rather than a route inside the SPA:
    // it holds WebCodecs decoders and a WebGL context that have nothing to do
    // with the browse experience, and a viewer watching a broadcast should not
    // be carrying the catalog, the portal and PlayCanvas along with it.
    app.get(['/live', '/live/:sessionId'], (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(DIST, 'live.html'));
    });

    app.get('*', (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(DIST, 'index.html'));
    });
} else {
    app.use(express.static(path.join(ROOT, 'public')));
}

/* ------------------------------------------------------------ error handler -- */

app.use((err, req, res, next) => {
    if (res.headersSent) {
        next(err);
        return;
    }

    console.error('[error]', req.method, req.path, err.message);

    // Never leak internals to the client; the log above has the detail.
    res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal server error' });
});

/* ------------------------------------------------------------------- start -- */

export function start() {
    // No host, so the bind is dual-stack: a headset or a phone that resolves
    // this machine over IPv6 reaches the same listener as one using the LAN
    // IPv4. Binding `0.0.0.0` refuses the IPv6 half outright.
    const server = app.listen(PORT, async () => {
        const lan = lanAddress();
        const { items } = await buildLibrary();
        const storage = getStorage();

        // Probes for FFmpeg and starts watching the session registry. Awaited
        // here only so the banner can report what it found.
        await startTranscode();

        // The recorder needs the same binary and its own scratch directory.
        // Sweeping is safe here and only here: nothing is recording yet, so
        // anything left behind is an unfinalised file from a crash.
        await recorders.probeFfmpeg();
        await recorders.sweepScratch();

        console.log(`\n  ${BRAND}  (pid ${process.pid})`);
        console.log(`  ─────────────────────────────────────────────`);
        console.log(`  Library      ${items.length} title${items.length === 1 ? '' : 's'}`);
        console.log(`  Storage      ${storage.isRemote ? 's3 / cdn (bytes bypass this process)' : 'local disk (bytes proxied)'}`);
        console.log(`  Worker       ${queueStats().workerEnabled ? 'enabled in-process' : 'disabled (external worker expected)'}`);
        console.log(`  Web app      http://${lan}:${PORT}/`);
        console.log(`  Creators     http://${lan}:${PORT}/creator`);
        console.log(`  DeoVR/Play'a http://${lan}:${PORT}/deovr`);
        console.log(`  Playlist     http://${lan}:${PORT}/playlist.m3u`);
        if (ENABLE_DLNA) console.log(`  DLNA         "${DLNA_FRIENDLY_NAME}" (SkyBox, Pigasus)`);
        // Deliberately localhost rather than the LAN address every other line
        // uses. The monitor decodes with WebCodecs, which browsers expose only
        // in a secure context, so `http://<lan>:<port>/live` fails with an
        // unsupported-browser-looking error even on this machine. localhost is
        // treated as secure; watching from another device needs HTTPS.
        console.log(`  Live monitor http://localhost:${PORT}/live  (localhost: WebCodecs needs a secure context)`);
        for (const [label, value] of liveBanner()) {
            console.log(`  ${label.padEnd(12)} ${value}`);
        }
        for (const line of transcodeBanner()) console.log(line);

        // Said out loud, every start. A stub that approves every document and
        // every face is indistinguishable from a working identity gate from
        // the outside - that is the whole reason it is useful in tests, and
        // the whole reason running one unannounced is dangerous.
        const provider = getProvider();
        console.log(
            `  Identity     ${provider.name}${identityEnforced() ? ', enforced' : ''}` +
                (provider.isMock ? '  ⚠ STUB — approves every document and every face' : '')
        );
        if (provider.isMock) {
            console.log(`               set AVR_PERSONA_API_KEY + template ids for real checks; see docs/IDENTITY.md`);
        }
        for (const gap of identityGaps()) {
            console.log(`               ⚠ ${gap} is not set — that check cannot run`);
        }

        // Which viewers get a document check and which get a button, said out
        // loud for the third time on the same reasoning: a deployment with no
        // geolocation in front of it looks, from in here, exactly like one that
        // has it and is seeing only traffic from states with no statute.
        console.log(`  ${jurisdictionBanner()}`);

        // Same reasoning, for the same reason: a payment provider that grants
        // credits without taking money looks exactly like one that works.
        console.log(`  ${paymentsBanner()}`);

        // And again: a mailer that delivers nothing reports every send as a
        // success, so the only way to notice is to be told at boot.
        console.log(`  ${mailBanner()}`);

        console.log('');
    });

    // Long-lived video responses must not be cut off mid-stream by a short
    // default timeout.
    server.requestTimeout = 0;
    server.headersTimeout = 65_000;
    server.keepAliveTimeout = 61_000;

    dlna?.start();

    // The relay attaches to this server's `upgrade` event, so it can only be
    // started once the server exists.
    startLive(server);

    // Housekeeping. Safe to run on every node; the delete is idempotent.
    const prune = setInterval(() => {
        try {
            sessions.pruneExpired();
            runIdentitySweep();
        } catch (err) {
            console.warn('[prune] failed:', err.message);
        }
    }, 3600_000);
    prune.unref();

    const shutdown = () => {
        dlna?.stop();
        stopTranscode();
        stopLive();

        // Every recording in progress is finished rather than dropped. FFmpeg
        // writes the MP4 index on its way out, so a killed recorder costs the
        // creator the whole file - a deploy should not do that.
        recorders.stopAll().catch(() => {});
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return server;
}

// Start when this module is the entry point. The cluster supervisor forks this
// same file, so workers take this branch too; importing it for tests does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    start();
}

export { app };
