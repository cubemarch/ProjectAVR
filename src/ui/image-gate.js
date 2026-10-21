import { EVENTS, regionOf, track } from '../analytics.js';
import { ageOk, ageState } from '../age-state.js';
import { coveredPicture, isPlainLeftClick } from './covered-image.js';
import { openAgeGate } from './age-gate.js';

/**
 * The overlay a visitor meets when they click a covered picture.
 *
 * The banner at the foot of the page explains why everything is mosaiced and
 * offers the gate, and it converts the visitors who were going to read it. This
 * catches the other kind: somebody who ignores the banner, sees something they
 * want and clicks it. At that moment they have told us what passing the gate is
 * worth to them, which is the only time this question has ever been easy to
 * answer, so it is the moment to ask.
 *
 * ## It is not a wall
 *
 * Cancelling goes through to wherever the picture led, with the covering still
 * on (David, 2026-10-21). That is the whole design and the thing not to
 * "improve" later: a visitor who declines keeps browsing a censored site, and
 * nothing here withholds a page. Refusing to verify is a choice this gate
 * respects, because the covering is already doing the legal work — see
 * `docs/CENSOR.md` and `docs/STATE-AGE-LAWS.md`. An interstitial that trapped
 * people would be collecting identity by attrition, from visitors no statute
 * asks us to check, and the twenty-seven states that *do* require a verified
 * adult are handled server-side where a dialog cannot be dismissed past.
 *
 * So there is no close cross and no third outcome. Every way out of this
 * overlay — the button, Escape, the backdrop — either verifies or continues,
 * and continuing is not punished.
 *
 * ## What counts as "an image"
 *
 * Whatever the server covered, and nothing else — `ui/covered-image.js` has
 * the rule and the reasoning. It fires on partner artwork and cam tiles, and
 * not on the logo, an icon, an avatar the server decided needed no covering,
 * or an ad creative. Clicking an advert has to reach the advertiser; that is
 * what was sold, and an interstitial in front of it would be us inserting
 * ourselves into a click we were paid for.
 */

const ROOT_ID = 'image-gate-root';

/**
 * Set for the length of the replayed click.
 *
 * The visitor's original click is cancelled and re-fired once they have
 * answered, which would otherwise be caught by this same handler and ask them
 * again forever.
 */
let replaying = false;

/**
 * Start watching for clicks on covered artwork.
 *
 * One listener for the whole page, in the capture phase so it runs before the
 * card's own handler and can stop the scene panel opening underneath the
 * overlay. Idempotent.
 */
export function initImageGate() {
    if (initImageGate.installed) return;
    initImageGate.installed = true;

    document.addEventListener(
        'click',
        (event) => {
            if (replaying || ageOk()) return;
            if (!isPlainLeftClick(event)) return;
            if (document.getElementById(ROOT_ID)) return;

            const start = event.target instanceof Element ? event.target : null;
            const picture = coveredPicture(start, document.body);
            if (!picture) return;

            event.preventDefault();
            event.stopPropagation();

            open(picture.closest('a[href]') || picture);
        },
        true
    );
}

/**
 * Draw the overlay over one clicked picture.
 *
 * @param {Element} origin The anchor the click was headed for, or the picture
 *   itself when it was not inside one.
 */
function open(origin) {
    const state = ageState();
    const policy = state.jurisdiction;
    const asks = state.owes === 'verification' ? 'verification' : 'attestation';
    const where = policy?.state;

    const href = origin.getAttribute?.('href') || '';
    const newTab = origin.getAttribute?.('target') === '_blank';

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'image-gate';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', `${ROOT_ID}-title`);

    root.innerHTML = `
        <div class="image-gate-backdrop" data-continue></div>
        <div class="image-gate-panel">
            <h2 class="image-gate-title" id="${ROOT_ID}-title">This image is covered</h2>
            <p class="image-gate-text">
                ${
                    asks === 'verification'
                        ? `${escapeHtml(where || 'Your state')} requires us to confirm you are 18
                           or older before showing explicit material.`
                        : 'Confirm you are 18 or older to see this and the rest of the page uncovered.'
                }
            </p>
            <div class="image-gate-actions">
                <button type="button" class="btn btn-primary" data-verify>
                    ${asks === 'verification' ? 'Verify my age' : 'I am 18 or older'}
                </button>
                <button type="button" class="btn ghost" data-continue>
                    Continue without verifying
                </button>
            </div>
            <p class="image-gate-note">
                You can keep browsing either way. Without verifying, images stay covered.
            </p>
        </div>`;

    let settled = false;

    /** Let the original click happen after all. */
    const go = () => {
        if (settled) return;
        settled = true;

        root.remove();
        document.removeEventListener('keydown', onKey, true);

        // Replay rather than navigate, so a card that opens a panel on this
        // page still opens its panel and an outbound anchor still carries its
        // `rel`. Both run inside the button's own click, so the new tab is a
        // user gesture and not a blocked popup.
        if (origin.isConnected) {
            replaying = true;
            try {
                origin.click();
            } finally {
                replaying = false;
            }
            return;
        }

        // Verification re-fetched the rows and the card we were called from is
        // no longer in the document. Fall back to the address it had.
        if (!href || href.startsWith('#')) return;

        if (newTab) {
            const opened = window.open(href, '_blank', 'noopener,noreferrer');
            if (opened) return;
        }

        window.location.href = href;
    };

    const onKey = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            go();
        }
    };

    for (const el of root.querySelectorAll('[data-continue]')) {
        el.addEventListener('click', (event) => {
            // The backdrop is the whole screen; a click that started on the
            // panel and drifted onto it is not a dismissal.
            if (event.target === el) go();
        });
    }

    root.querySelector('[data-verify]')?.addEventListener('click', async () => {
        // Deliberately not awaited before the overlay goes: the gate draws its
        // own dialog and two stacked modals trap focus in the wrong one.
        root.remove();
        document.removeEventListener('keydown', onKey, true);

        await openAgeGate();

        // Either way. Verified, the replay opens an uncovered card; declined,
        // it opens a covered one. Nothing here is a dead end.
        settled = false;
        go();
    });

    document.addEventListener('keydown', onKey, true);
    document.body.append(root);

    root.querySelector('[data-verify]')?.focus();

    track(EVENTS.AGE_GATE_SHOWN, { region: regionOf(policy), asks, surface: 'image' });
}

function escapeHtml(str) {
    return String(str).replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
}
