import { BRAND } from '../../brand.js';

/**
 * Where the identity provider sends the browser when a check is over.
 *
 * The check runs in a popup the page opened, and the provider needs somewhere
 * to navigate that popup once the document has been photographed. Pointing it
 * at the app's own front page - which is what this used to do - loads the
 * whole SPA inside a 480x720 window, so for the two or three seconds before
 * the opener's next poll notices and closes it, the person who just finished
 * verifying is looking at a second, broken copy of the site.
 *
 * So the provider returns here instead: one document, no bundle, no session
 * lookup, which closes itself.
 *
 * ## It reports nothing
 *
 * This page is reached by a redirect the browser followed. Anyone can follow
 * it, at any time, with any query string on the end, so nothing it says can be
 * evidence of anything. It therefore says nothing: the `postMessage` it sends
 * the opener carries no status, and the opener treats it only as "stop waiting
 * for the next tick, ask the server now". The verdict still comes from the
 * provider, through `/complete`, exactly as it did before - see the note on
 * `identity` in `src/api/client.js`.
 *
 * That is also why this is a static string with no user input in it. The
 * `flow` parameter is read by the script from `location.search` and echoed
 * only into the message, never into the document.
 */
export const IDENTITY_RETURN_PATH = '/identity/return';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Check complete &mdash; ${BRAND}</title>
<style>
    html { color-scheme: dark; }
    body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem 1.5rem;
        box-sizing: border-box;
        background: #0b0b0f;
        color: #e8e8ee;
        font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        text-align: center;
    }
    p { margin: 0 0 1rem; }
    .quiet { color: #9a9aa8; }
    a { color: #e8e8ee; }
</style>
</head>
<body>
<main>
    <p id="working">Finishing up&hellip;</p>
    <div id="stranded" hidden>
        <p>Your check is complete.</p>
        <p class="quiet">You can close this window and go back to ${BRAND}.</p>
        <p><a href="/">Back to ${BRAND}</a></p>
    </div>
</main>
<script>
(function () {
    var flow = new URLSearchParams(location.search).get('flow') || '';
    if (!/^[a-z][a-z-]{0,31}$/.test(flow)) flow = '';

    // A nudge, not a verdict. The opener polls the server either way; this
    // only saves it the rest of its current wait.
    try {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage(
                { source: 'avr-identity', event: 'returned', flow: flow },
                location.origin
            );
        }
    } catch (err) {
        /* Opener gone, or navigated somewhere this cannot reach. Nothing to do. */
    }

    try {
        window.close();
    } catch (err) {
        /* Refused. The message below is the fallback. */
    }

    // Still here, so the close was refused or this was never a popup - the
    // second happens when the flow was opened from the "Open it here" link,
    // which carries rel="noopener", and on the phones that turn a popup into
    // a tab. Say so rather than leaving a blank window.
    setTimeout(function () {
        document.getElementById('working').hidden = true;
        document.getElementById('stranded').hidden = false;
    }, 500);
})();
</script>
</body>
</html>
`;

/**
 * Mount the return page.
 *
 * Has to be above the SPA catch-all in `server/index.js`, or `app.get('*')`
 * answers with `index.html` and the popup shows the front page again - which
 * is the entire thing this exists to stop.
 *
 * @param {import('express').Express} app
 */
export function mountIdentityReturn(app) {
    app.get(IDENTITY_RETURN_PATH, (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.type('html').send(PAGE);
    });
}
