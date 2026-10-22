/**
 * The greeting a browser meets once, on its first visit.
 *
 * ## What this is, and what it is deliberately not
 *
 * A greeting and nothing else. No consent is taken here, nothing is counted,
 * and dismissing it changes nothing about what the visitor is then shown —
 * which is the whole reason it can be a plain closeable box rather than
 * another thing standing between somebody and the page.
 *
 * In particular it is **not** an age surface and must never be mistaken for
 * one. The gate, its banner and the image interstitial all draw above this
 * one; see the z-index note beside `.welcome-modal` in `styles/netflix.css`.
 * A greeting is the least important thing that can be in front of somebody,
 * and the one thing it must never cover is the gate.
 *
 * ## Once per browser, not once per load
 *
 * "First enters the page" is remembered in `localStorage`, so a visitor who
 * dismisses it and then navigates does not meet it again.
 *
 * Storage that throws — private mode, a locked-down browser — is read as
 * "not seen yet". That shows the greeting again rather than never, which is
 * the right way round for this: a greeting shown twice is a small annoyance,
 * one that silently never appears is a bug nobody would notice until
 * somebody asked why it was missing.
 *
 * ## The shape
 *
 * `shouldGreet` takes its storage rather than reaching for `localStorage`,
 * and `initWelcomeModal` takes its text and its key. That is the same
 * arrangement as `ui/covered-image.js`: the decision is pure and tested
 * directly, and the part that can only be checked against a real DOM is kept
 * small enough that pinning it against its source is honest.
 */

/** Remembers that this browser has been greeted. Namespaced like `avr:mylist`. */
export const SEEN_KEY = 'avr:welcome-seen';

/** The one element id, so a second call cannot stack a second copy. */
const ROOT_ID = 'welcome-modal';

/** What the box says. */
export const WELCOME_TEXT = 'Hello WeCamgirls';

/**
 * Whether this browser still owes a greeting.
 *
 * @param {{getItem: (k: string) => string|null}|null} store
 * @param {string} [key]
 * @returns {boolean}
 */
export function shouldGreet(store, key = SEEN_KEY) {
    try {
        return store?.getItem(key) !== '1';
    } catch {
        // See the header: unreadable storage means greet, not stay quiet.
        return true;
    }
}

function remember(store, key) {
    try {
        store?.setItem(key, '1');
    } catch {
        /* Nothing to do, and nothing worth saying about it. */
    }
}

/**
 * Draw the greeting, if this browser has not had it.
 *
 * Safe to call more than once and safe to call on a page that already has
 * one: the id is the guard both times.
 *
 * @param {{text?: string, key?: string, store?: object}} [opts]
 * @returns {HTMLElement|null} the dialog, or `null` if it was not drawn
 */
export function initWelcomeModal({ text = WELCOME_TEXT, key = SEEN_KEY, store } = {}) {
    if (typeof document === 'undefined') return null;
    if (document.getElementById(ROOT_ID)) return null;

    const storage = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!shouldGreet(storage, key)) return null;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'welcome-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', text);

    root.innerHTML =
        '<div class="welcome-modal-box">' +
        '<button type="button" class="welcome-modal-close" data-close aria-label="Close">&times;</button>' +
        '<p class="welcome-modal-text"></p>' +
        '</div>';

    // Assigned, not interpolated. The text is a constant today, so the markup
    // above would be safe either way — but this is the single line that would
    // carry a caller's string into the DOM, and `textContent` costs nothing
    // to make that unconditional rather than true-for-now.
    root.querySelector('.welcome-modal-text').textContent = text;

    // Whatever had focus before the box opened, so closing gives it back
    // rather than dropping the visitor at the top of the document.
    const previous = document.activeElement;

    function onKey(event) {
        if (event.key === 'Escape') close();
    }

    function close() {
        // Remembered on dismissal rather than on display. A visitor who
        // closed the tab without seeing it has not been greeted.
        remember(storage, key);

        document.removeEventListener('keydown', onKey);
        root.remove();

        if (previous && typeof previous.focus === 'function') previous.focus();
    }

    root.querySelector('[data-close]').addEventListener('click', close);

    // The backdrop is the root itself, so a click has to be tested rather
    // than merely heard: one that lands on the box bubbles to here too, and
    // closing on it would make the box dismiss itself when read.
    root.addEventListener('click', (event) => {
        if (event.target === root) close();
    });

    document.addEventListener('keydown', onKey);
    document.body.append(root);

    // Focus the only control in it. Without this the Escape handler is the
    // sole keyboard route out, and the tab order still starts behind the
    // backdrop on the page the visitor cannot click.
    root.querySelector('[data-close]').focus();

    return root;
}
