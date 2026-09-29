/**
 * The destination string a creator pastes into the capture app.
 *
 * This is the whole interface between the two products. The web app knows who
 * somebody is; the phone knows how to point a camera at an address. Neither
 * needs to know anything else about the other, and the only thing that crosses
 * between them is one URL that the creator carries by hand.
 *
 * That is deliberate. The capture app has no account, no sign-in, no identity
 * check and no knowledge that verification exists - so there is nothing in the
 * iOS binary that is about who may broadcast, only about where to send video.
 * Everything that decides *whether* a creator may go on air happens in the
 * browser, before this URL exists.
 */

import { LIVE_DESTINATION_NAME } from '../../brand.js';
import { tlsPinBase64 } from './tls.js';

const LIVE_PORT = Number(process.env.AVR_LIVE_PORT || 8081);

/**
 * The address the phone should dial.
 *
 * Not the hostname the browser happens to be on: the portal may sit behind a
 * CDN or a reverse proxy on 443 while the ingest listener is a raw TCP socket
 * on another host entirely. When it is unset we fall back to the request's own
 * hostname, which is right for the common single-box deployment and wrong in a
 * way that is immediately visible for any other - the creator sees the address
 * in the confirmation sheet before anything connects.
 */
function ingestHost(req) {
    const configured = process.env.AVR_PUBLIC_INGEST_HOST;
    if (configured) return configured.trim();

    return req?.hostname || 'localhost';
}

/**
 * The name the destination will carry in the capture app's list.
 *
 * The app requires one - it is the first field of its destination editor and it
 * refuses to save without it - so the link has to supply it or the creator gets
 * a destination called after its IP address. There was a longer-standing bug
 * here than the missing field: the two call sites read `req.user.displayName`,
 * but `req.user` is a raw database row whose column is `display_name`, so the
 * name was silently `undefined` and every destination this server has ever
 * issued was called after the fallback - "ProjectAVR Live" at the time, now
 * `LIVE_DESTINATION_NAME`.
 *
 * Order: what the creator typed, then their account name, then the fallback.
 *
 * Sanitised the same way the phone sanitises it on the way in - control
 * characters and bidi overrides stripped, length capped - because it is
 * displayed in a list the operator reads before going on air, and a name
 * containing a right-to-left override can make one row impersonate another.
 * Doing it here as well means the *stored* value is clean, not just the
 * rendered one.
 *
 * @param {string|undefined|null} requested - what the creator typed, if anything
 * @param {{display_name?: string}|undefined|null} user - the row from `loadFullUser`
 * @returns {string}
 */
export function destinationName(requested, user) {
    const clean = (value) =>
        String(value ?? '')
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, '')
            .trim()
            .slice(0, NAME_MAX_LENGTH);

    return clean(requested) || clean(user?.display_name) || LIVE_DESTINATION_NAME;
}

/** Matches `DestinationLimits.nameMaxLength` in the capture app. */
const NAME_MAX_LENGTH = 60;

/**
 * Build the destination link and its parts.
 *
 * `avr://` rather than `https://` for the canonical form, because on a phone it
 * opens the capture app directly and on a desktop it does nothing - which is
 * the correct behaviour in both places. The app also accepts the same query on
 * an `https://` URL, for the creator who copies the visible text instead of
 * following the link.
 *
 * The `avr://pair` path is unchanged and deliberately so. It is a wire format:
 * every link already issued, every saved QR code and the app's own URL handler
 * are keyed on it, and renaming it to match the prose would break all of them to
 * fix nothing a user can see. The words around it are what got aligned.
 *
 * The key rides in the query string, which for a bearer credential normally
 * wants an argument. This one is generated for one person, displayed once,
 * spendable once, and dead in minutes; it is never a link anyone navigates a
 * browser to, so it does not enter a referer header, a browser history or an
 * intermediary's access log. It also has to survive being read off a screen and
 * scanned by a camera, and a query string is the form both the URL handler and
 * the QR decoder already understand.
 *
 * @param {object} opts
 * @param {import('express').Request} [opts.req]
 * @param {string} opts.key - the freshly minted stream key
 * @param {string} [opts.name] - what the destination should be called in the app
 * @returns {{url: string, webUrl: string, host: string, port: number,
 *            key: string, name: string, tls: boolean, pin: string|null}}
 */
export function buildPairingUrl({ req, key, name = LIVE_DESTINATION_NAME }) {
    const host = ingestHost(req);
    const pin = tlsPinBase64();

    const params = new URLSearchParams({
        host,
        port: String(LIVE_PORT),
        key,
        name
    });

    // Only advertised when the listener actually has TLS configured. A phone
    // told to expect TLS by a server that is not speaking it fails closed, and
    // "the app says my server is misconfigured" is a better outcome than a
    // silent downgrade - but it is a bad outcome to cause by accident.
    if (pin) {
        params.set('tls', '1');
        params.set('pin', pin);
    }

    const query = params.toString();

    return {
        url: `avr://pair?${query}`,
        webUrl: `https://${req?.get?.('host') || host}/pair?${query}`,
        host,
        port: LIVE_PORT,
        key,
        name,
        tls: Boolean(pin),
        pin
    };
}
