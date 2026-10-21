import { EVENTS, regionOf, track } from '../analytics.js';
import { ageOk, ageState } from '../age-state.js';
import { openAgeGate } from './age-gate.js';

/**
 * Nothing decodes video for a visitor who has not been through the gate.
 *
 * Stills and moving pictures are not the same problem, and this is the half
 * where covering does not work. A mosaic over a frame is a real answer for a
 * poster — `services/censor/` draws one, and `docs/CENSOR.md` explains why
 * every failure covers more rather than less. There is no equivalent for a
 * stream: the detector runs at a few frames a second on one server, the
 * material moves, and a cover that lags by half a second is not a cover. So
 * for video the answer is the stricter one David picked on 2026-10-21 —
 * **no playback until verified**.
 *
 * What that means at each surface:
 *
 * - The poster or thumbnail is covered like any other image, because it is
 *   one and goes through the same proxy.
 * - The control that would start playback offers the gate instead.
 * - Nothing is loaded, attached or framed until the answer is yes. Gating
 *   after `load()` would be theatre: the fetch has started and the first
 *   frames are already decoded behind whatever is drawn over them.
 *
 * This is deliberately stricter than {@link module:ui/image-gate}, which lets
 * a visitor decline and carry on looking at a covered page. There is nothing
 * to carry on with here. Declining is still not punished — the page stays
 * where it was and the gate can be opened again from the banner — it just
 * does not produce a video.
 */

/**
 * Whether playback may start right now, without asking anybody anything.
 *
 * For deciding what to *render*. Use {@link allowPlayback} for deciding what
 * to *do* when somebody presses play.
 */
export function playbackAllowed() {
    return ageOk();
}

/**
 * Offer the gate, and report whether playback may now begin.
 *
 * @param {'title'|'recording'|'cam'} surface Which player asked, for the
 *   report. The three convert very differently and a single number for
 *   "someone tried to watch something" would hide that.
 * @returns {Promise<boolean>}
 */
export async function allowPlayback(surface) {
    if (ageOk()) return true;

    const state = ageState();

    // Counted here as well as inside the dialog, the same way the banner is:
    // this is a distinct showing on a distinct surface, and the question it
    // answers — how many people hit the gate by trying to play something — is
    // not answerable from the dialog's own count.
    track(EVENTS.AGE_GATE_SHOWN, {
        region: regionOf(state.jurisdiction),
        asks: state.owes === 'verification' ? 'verification' : 'attestation',
        surface
    });

    await openAgeGate();

    // The shared state rather than the dialog's return value: it resolves
    // false when dismissed, but a visitor who passed in another tab while it
    // was open comes back true, and this is the copy everything else reads.
    return ageOk();
}
