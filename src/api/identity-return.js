/**
 * The identity popup's way home.
 *
 * A document check runs in a window this app opened and the provider hosts.
 * When it finishes, the provider navigates that window to a URL we gave it,
 * and the window then has to go away. Two halves to that, both here:
 *
 *   `identityReturnUrl` is the URL we hand the provider. It points at a tiny
 *   server-rendered page (`server/identity/return-page.js`) whose whole job is
 *   to call `window.close()`.
 *
 *   `sleepUntilReturn` is what the polling loops wait on instead of a plain
 *   timer, so that the moment that page announces itself they ask the server
 *   for the verdict rather than sitting out the rest of a three-second tick.
 *
 * The announcement is a hint and nothing else. It carries no status, it is not
 * required for correctness, and a flow where it never arrives - popup blocked,
 * opened in a tab with `rel="noopener"`, message lost - behaves exactly as it
 * did before: the next poll picks the result up. The verdict comes from the
 * provider through `/complete`, never from a message a page sent itself.
 */

export const IDENTITY_RETURN_PATH = '/identity/return';

/**
 * @param {'age'|'enrol'} flow which check is being run, for the log and so a
 *   stray message from an unrelated flow cannot cut short this one's wait
 */
export function identityReturnUrl(flow) {
    return `${location.origin}${IDENTITY_RETURN_PATH}?flow=${encodeURIComponent(flow)}`;
}

/**
 * Wait `ms`, or until the return page says the browser came back - whichever
 * happens first.
 *
 * @param {number} ms
 * @param {string} [flow]
 * @returns {Promise<void>}
 */
export function sleepUntilReturn(ms, flow) {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve();
        };

        const onMessage = (event) => {
            // Same-origin only: the provider's own pages are not same-origin
            // with this one, so nothing they post can reach here.
            if (event.origin !== location.origin) return;

            const data = event.data;
            if (!data || data.source !== 'avr-identity' || data.event !== 'returned') return;
            if (flow && data.flow && data.flow !== flow) return;

            finish();
        };

        const timer = setTimeout(finish, ms);
        window.addEventListener('message', onMessage);
    });
}
