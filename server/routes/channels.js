import express from 'express';

import { describeSession, rooms, sessions } from '../live/index.js';
import { reserveName, resolveChannel, unreserveName } from '../channels/index.js';
import { loadFullUser, requireRole } from '../auth/middleware.js';
import { profileView } from './profiles.js';
import { profiles, reservedSlugs } from '../db/index.js';
import { viewFor } from '../media/view.js';

/**
 * Channel pages: `/<name>`, the one address a creator can write on a poster.
 *
 * Everything else that identifies a broadcast is temporary by construction. A
 * session id names a socket on one process and is minted fresh every time
 * somebody goes on air; a broadcast grant is spent on the connection it opened
 * and is behind a face check besides. So neither can be the thing a creator
 * hands to an audience, and this is: a name that belongs to the channel,
 * resolves to whatever is live on it right now, and still means something when
 * nothing is.
 *
 * The page itself is the SPA - `server/index.js` already serves `index.html`
 * for any path it does not recognise, so no route here renders HTML. What this
 * module provides is the lookup behind it.
 */

export function mountChannels(app) {
    const router = express.Router();
    const json = express.json({ limit: '4kb' });

    /**
     * Who is at this address, and are they on air?
     *
     * Public and unauthenticated: a channel page that needed an account to
     * look at would not be an address you could hand to anybody. It therefore
     * reports exactly what the public catalogue already reports and nothing
     * more - in particular a private broadcast is reported as *offline*, the
     * same way it is absent from `/api/live/sessions`. The relay's admission
     * secret is the control; this is about not advertising the target.
     *
     * `canonical` is how an alias resolves. A creator who renames keeps every
     * old name working, so this reports the name the site should actually be
     * showing and the page replaces its own URL with it - one channel at one
     * address, without breaking the link somebody saved two years ago.
     */
    router.get('/:slug', (req, res) => {
        const found = resolveChannel(req.params.slug);

        if (!found) {
            res.status(404).json({ error: 'no such channel', code: 'no_such_channel' });
            return;
        }

        const live = sessions
            .list()
            .find((s) => s.creatorId === found.user.id && !rooms.isPrivate(s));

        // No-store rather than a short cache: whether a channel is live is the
        // one fact on this response that changes without warning, and a stale
        // "offline" is the failure the whole page exists to avoid.
        res.set('Cache-Control', 'no-store');

        // Already `no-store` above, so only the avatar changes with the gate.
        // A channel page answers to anybody and the picture on it is one a
        // creator uploaded — see `avatarUrl` in `routes/profiles.js`.
        res.json({
            slug: found.slug,
            canonical: found.canonical,
            channel: profileView(found.user, profiles.byId(found.user.id), {
                covered: viewFor(req).covered
            }),
            live: live ? describeSession(live) : null
        });
    });

    app.use('/api/channels', router);

    /* -------------------------------------------------------- reservations -- */

    /**
     * The editable half of the reserved list.
     *
     * The other half is in `server/channels/slug.js` and is not editable from
     * anywhere, because it is the set of names the router itself answers to -
     * a console that could release `api` or `login` would be a console that
     * could break the site from a text field. This list is for the names a
     * deployment decides it wants to hold: a campaign it has not announced, a
     * term it does not want a channel called, a performer's stage name
     * somebody keeps trying to squat.
     */
    const superuser = express.Router();

    superuser.get('/reserved', requireRole('superuser'), (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ reserved: reservedSlugs.list() });
    });

    superuser.post('/reserved', requireRole('superuser'), loadFullUser, json, (req, res) => {
        const result = reserveName({
            user: req.user,
            slug: req.body?.slug,
            reason: req.body?.reason
        });

        if (!result.ok) {
            res.status(result.code === 'forbidden' ? 403 : 400).json(result);
            return;
        }

        res.status(201).json(result);
    });

    superuser.delete('/reserved/:slug', requireRole('superuser'), loadFullUser, (req, res) => {
        const result = unreserveName({ user: req.user, slug: req.params.slug });

        if (!result.ok) {
            res.status(result.code === 'forbidden' ? 403 : 404).json(result);
            return;
        }

        res.status(204).end();
    });

    app.use('/api/superuser', superuser);
}
