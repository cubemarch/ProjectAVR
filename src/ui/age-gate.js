import { brandLockup } from './brand-mark.js';
import { sleepUntilReturn } from '../api/identity-return.js';
import { EVENTS, regionOf, track } from '../analytics.js';
import { setAgeState } from '../age-state.js';
import {
    cameraAvailable,
    cameraProblem,
    declineText,
    frameFrom,
    openSelfieCamera,
    stopSelfieCamera
} from './selfie-capture.js';

/**
 * The gate a signed-out visitor meets, and the banner that invites them to it.
 *
 * `AFFILIATES_ONLY` made the front page a directory of partner covers and
 * live cam thumbnails, shown to everyone. That artwork is what the
 * twenty-seven statutes in `docs/STATE-AGE-LAWS.md` are about, and the gate
 * that was answering for it only works for accounts. This is the half that
 * works without one. The server side, including why a pass is bound to the
 * place it was earned, is `server/identity/visitor-gate.js`.
 *
 * **It asks each state for its own minimum and nothing more.** In the
 * twenty-three that legislate nothing, that is one click. In the
 * twenty-seven, a click is not what the statute says, so there is no click —
 * the visitor is shown which law applies, what it accepts, and the real
 * check, which runs right here.
 *
 * **Nothing here asks anybody to sign in.** The document check used to hand
 * off to the auth modal, because the flow it needed lived behind `requireAuth`.
 * No statute in the table asks for an account, and making somebody register to
 * prove their age collects more identity than the law wants from more people
 * than it wants it from. The check now runs for a visitor who has none.
 *
 * ## This stopped being a blocking interstitial on 2026-10-20
 *
 * It used to be one, and the docstring here used to make a point of it:
 * `main.js` awaited the gate before fetching a single partner row, so a
 * visitor who never passed it never caused a request for adult artwork at
 * all, and dismissing the overlay in dev tools revealed an empty page.
 *
 * That was a real property and it has been given up deliberately, for a
 * better one. The page now renders for everybody with every piece of adult
 * artwork pixelated by `services/censor/`, and this file draws a banner
 * offering the gate rather than a wall demanding it. The trade:
 *
 *   - **What was lost.** The page no longer proves it is empty. An unverified
 *     visitor's browser does now request adult artwork — covered artwork, from
 *     our own origin, but requested.
 *   - **What was gained.** The covering is enforced on the server, per
 *     request, from the cookie, by a route that has no parameter for asking
 *     it not to. "Nothing was fetched" was a stronger claim only while the
 *     overlay held; it was never a claim about the API, which was always open
 *     and always had to answer for itself. Both `routes/cams.js` and
 *     `routes/bang.js` do, now, and that is the check that survives dev tools.
 *   - **Why it is worth it.** A blank page persuades nobody to verify. A
 *     visitor who can see a real shelf with the explicit regions covered knows
 *     exactly what passing the gate buys them, which is the only version of
 *     this that has ever converted.
 *
 * The one thing that must not drift: the banner is an *invitation*, and the
 * covering is not its doing. Deleting this file entirely would leave every
 * visitor looking at mosaics, not at pornography.
 */

const ROOT_ID = 'age-gate-root';
const BANNER_ID = 'age-banner-root';

/** How long the gate keeps asking the server how a document check went. */
const POLL_MS = 3_000;
const POLL_CEILING_MS = 15 * 60_000;

/**
 * Florida's statutory name for the route that keeps nothing, and the only
 * method here that is not a document handed to a popup.
 */
const SELFIE_METHOD = 'anonymous';

/**
 * Find out where this visitor stands and, if they are not through, say so.
 *
 * Awaited by `main.js`, but only for the length of one same-origin fetch — it
 * never waits on the visitor. What the await buys is ordering: the ad modules
 * read `ageOk()` synchronously and must not draw a slot before the answer
 * lands, and the banner should be on the page by the time the first covered
 * row appears under it rather than dropping in afterwards.
 *
 * @returns {Promise<import('../age-state.js').AgeState>}
 */
export async function initAgeGate() {
    // A server that cannot answer is not a reason to show adult material, and
    // it does not need to be: every route that serves artwork makes this same
    // decision for itself, so a failed fetch here costs the banner's accuracy
    // and nothing else. It fails to the attestation because that is the
    // smaller of the two asks to put in front of somebody wrongly.
    const state = (await ask()) ?? { ok: false, owes: 'attestation', jurisdiction: null };

    setAgeState(state);

    // Exactly one `age_gate_passed` per load, whichever way it happened, so
    // the event is a clean count of sessions that saw the site. `stored` is
    // the visitor who was already through and never met the dialog at all;
    // the pass rate worth reading is the other methods over `age_gate_shown`.
    if (state.ok) {
        track(EVENTS.AGE_GATE_PASSED, { method: 'stored', region: regionOf(state.jurisdiction) });
        return state;
    }

    renderBanner(state);

    return state;
}

/**
 * Open the dialog, from the banner or from anywhere else that offers it.
 *
 * Re-asks the server first rather than reusing what {@link initAgeGate}
 * learned. A visitor may have sat on the page for an hour, moved network, or
 * passed the gate in another tab, and the cheap fetch is worth not drawing a
 * document check for somebody who now owes a click.
 *
 * @returns {Promise<boolean>} true if they came out of it verified
 */
export async function openAgeGate() {
    if (document.getElementById(ROOT_ID)) return false;

    const state = (await ask()) ?? { ok: false, owes: 'attestation', jurisdiction: null };

    if (state.ok) {
        // Already through, in another tab or since the page loaded. Counted
        // as a pass because it is one; `render`'s own `done` does the
        // counting on every other path, which is why this is the only
        // `track` call in this function.
        markVerified(state);
        track(EVENTS.AGE_GATE_PASSED, { method: 'recheck', region: regionOf(state.jurisdiction) });
        return true;
    }

    setAgeState(state);

    return new Promise((resolve) => {
        render(state, (ok) => {
            if (ok) markVerified(state);
            resolve(ok === true);
        });
    });
}

/**
 * Take the banner down and tell the page.
 *
 * The artwork does not uncover itself here, and this function deliberately
 * does not try: the covered URLs already on the page were chosen by the
 * server, and rewriting them on the client would be the client deciding what
 * is explicit. `setAgeState` tells whoever is listening — `main.js` re-fetches
 * the rows, which come back uncovered because the cookie is now good.
 *
 * Does not track. Every caller knows how the visitor got through and says so
 * itself, and a pass counted in two places is a pass counted twice.
 */
function markVerified(state) {
    setAgeState({ ...state, ok: true });

    document.getElementById(BANNER_ID)?.remove();
    document.body.classList.remove('has-age-banner');
}

/* ----------------------------------------------------------------- banner -- */

/**
 * The strip along the bottom offering the gate.
 *
 * Bottom rather than top, and `role="region"` rather than `role="dialog"`,
 * because it is not modal and must not read as one: a visitor can scroll the
 * whole page, open a scene panel and use the search box without answering it.
 * Announced politely for the same reason — it is information about what is
 * being shown, not a prompt demanding a response.
 *
 * It says what is actually true, which is the part worth getting right. The
 * page is not partially loaded and is not broken; the images on it have been
 * pixelated, and verifying removes the pixelation. A banner that implied
 * anything else would be read as a dark pattern by the visitor and as a
 * misrepresentation by anybody auditing the site.
 *
 * There is no dismiss button. It is not modal, so it costs a visitor who is
 * ignoring it one strip of screen; a close control on it would mean an
 * unverified visitor browsing a fully covered catalogue with no standing
 * explanation of why every image is a mosaic.
 */
function renderBanner(state) {
    document.getElementById(BANNER_ID)?.remove();

    const policy = state.jurisdiction;
    const verification = state.owes === 'verification';
    const where = policy?.state;

    const root = document.createElement('div');
    root.id = BANNER_ID;
    root.className = 'age-banner';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Age verification');

    root.innerHTML = `
        <div class="age-banner-inner">
            <p class="age-banner-text">
                <strong>Images on this page are blurred.</strong>
                ${
                    verification
                        ? `${escapeHtml(where || 'Your state')} requires us to confirm you are
                           18 or older before showing explicit material.`
                        : 'Confirm you are 18 or older to see them uncovered.'
                }
            </p>
            <button type="button" class="btn btn-primary age-banner-cta" data-verify>
                ${verification ? 'Verify my age' : 'I am 18 or older'}
            </button>
        </div>`;

    root.querySelector('[data-verify]')?.addEventListener('click', () => {
        void openAgeGate();
    });

    document.body.append(root);

    // The class is what gives the page bottom padding, so the banner does not
    // sit on top of the last row of cards for the whole visit.
    document.body.classList.add('has-age-banner');

    track(EVENTS.AGE_GATE_SHOWN, {
        region: regionOf(policy),
        asks: verification ? 'verification' : 'attestation',
        surface: 'banner'
    });
}

async function ask() {
    try {
        const res = await fetch('/api/identity/gate', {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
        });

        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------- view -- */

function render(state, resolve) {
    const policy = state.jurisdiction;
    const verified = state.owes === 'verification';

    // Two parameters on every gate event, because the only interesting
    // question about this dialog is how it performs in the twenty-seven
    // states that make it a document check versus everywhere else.
    const where = { region: regionOf(policy), asks: verified ? 'verification' : 'attestation' };

    // Fired per drawing, not per load: `again` re-renders when the answer
    // changed underneath us, and that genuinely is a second showing.
    track(EVENTS.AGE_GATE_SHOWN, where);

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'age-gate';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Age verification');

    root.innerHTML = `
        <div class="age-gate-box">
            <button type="button" class="age-gate-close" data-close
                    aria-label="Close and keep browsing with images covered">&times;</button>
            <div class="age-gate-mark">${brandLockup({ symbolHeight: 44, wordmarkHeight: 28 })}</div>
            ${verified ? verifiedHtml(state) : attestHtml(policy)}
            <p class="age-gate-foot">
                By continuing you agree to our <a href="/terms">terms</a> and
                <a href="/privacy">privacy policy</a>. This site is a directory of
                paid links to partner sites; it hosts no material of its own. See our
                <a href="/2257">18 U.S.C. 2257 statement</a>.
            </p>
        </div>`;

    document.body.append(root);
    document.body.classList.add('age-gate-open');

    const leave = () => {
        track(EVENTS.AGE_GATE_LEFT, where);

        // Not `history.back()`: a visitor who arrived from a search result has
        // nothing to go back to and would sit on the gate forever.
        window.location.replace('https://www.google.com/');
    };

    root.querySelector('[data-leave]')?.addEventListener('click', leave);

    if (verified) wireVerification(root, state, done, again);

    const enter = root.querySelector('[data-enter]');

    enter?.addEventListener('click', async () => {
        enter.disabled = true;

        const ok = await attest(policy?.attestation?.version);

        if (ok) {
            done('attestation');
            return;
        }

        enter.disabled = false;

        // The only way this fails in practice is the visitor moving between
        // the page load and the click — a VPN toggled, a phone changing
        // network — into a state that wants more than a button. Re-render
        // rather than show an error: the new gate is the answer.
        again();
    });

    // Escape used to do nothing deliberately, and there was no backdrop to
    // click: this was the only thing standing between a minor and the page,
    // so the only ways out of it were through it and away from it.
    //
    // It is dismissible as of 2026-10-20, because that sentence stopped being
    // true. The page behind it is covered by the server whether this dialog
    // is open, closed or deleted, so refusing to close would be theatre —
    // and worse than theatre, since a visitor who opened it from the banner
    // to read which statute applies would be trapped by their own curiosity.
    // Closing returns them to the covered page and the banner, which is
    // exactly where they were.
    const dismiss = () => {
        root.remove();
        document.body.classList.remove('age-gate-open');
        resolve(false);
    };

    root.querySelector('[data-close]')?.addEventListener('click', dismiss);

    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') dismiss();
    });

    // Still trapped while it is open. Dismissible is not the same as porous:
    // tabbing out of a dialog onto the page underneath it is a bug in any
    // dialog, and this one has a document check inside it.
    trapFocus(root);

    /** @param {'attestation' | 'selfie' | 'document' | 'recheck'} method how they got through */
    function done(method) {
        track(EVENTS.AGE_GATE_PASSED, { ...where, method });

        root.remove();
        document.body.classList.remove('age-gate-open');
        resolve(true);
    }

    /** Re-ask and redraw, for when the answer has changed underneath us. */
    async function again() {
        root.remove();
        document.body.classList.remove('age-gate-open');

        const next = (await ask()) ?? { ok: false, owes: 'verification', jurisdiction: null };

        // `done` is not reused here: it would report the jurisdiction of the
        // gate that just turned out to be the wrong one. This pass belongs to
        // wherever the visitor has turned out to be.
        if (next.ok) {
            track(EVENTS.AGE_GATE_PASSED, {
                region: regionOf(next.jurisdiction),
                asks: where.asks,
                method: 'recheck'
            });
            resolve(true);
        } else render(next, resolve);
    }
}

/** Twenty-three states and everywhere outside the US: one click is the law. */
function attestHtml(policy) {
    const text =
        policy?.attestation?.text ||
        'I confirm that I am 18 years of age or older and that I wish to view sexually explicit material.';

    return `
        <h1>Adults only</h1>
        <p class="age-gate-lede">
            This site contains sexually explicit material and is for adults only.
            You must be 18 or older — 21 where that is the local age of majority —
            to continue.
        </p>
        <p class="age-gate-attest">${escapeHtml(text)}</p>
        <div class="age-gate-actions">
            <button type="button" class="btn btn-primary" data-enter>I am 18 or older — enter</button>
            <button type="button" class="btn btn-secondary" data-leave>Leave</button>
        </div>`;
}

/**
 * The twenty-seven.
 *
 * Names the statute. That is not decoration: the honest thing to tell
 * somebody being asked for a document is who is asking, and a citation with a
 * link to the text is the shortest way to say it is not us.
 *
 * Then it runs the check. There is no account step and nothing to sign up
 * for — the only thing between this screen and the site is the document the
 * state asked for.
 */
function verifiedHtml(state) {
    const policy = state.jurisdiction;
    const where = policy?.state || 'your state';

    const documentReady = state.provider?.ready !== false;
    const selfieReady = Boolean(state.selfieConsent) && state.provider?.selfieReady !== false;

    // A method whose route cannot run is shown and disabled rather than
    // dropped. Florida's statute is about what the viewer is *offered*, so
    // quietly removing the anonymous choice because this server is
    // misconfigured would turn a visible fault into an invisible one.
    const choices = (policy?.methods ?? [])
        .filter((m) => m.id !== 'attestation')
        .map((m) => ({
            ...m,
            disabled: m.id === SELFIE_METHOD ? !selfieReady : !documentReady
        }));

    const mustChoose = Boolean(policy?.requiresChoice) && choices.length > 1;
    const first = choices.find((m) => !m.disabled) ?? choices[0];
    const ready = choices.some((m) => !m.disabled);

    return `
        <h1>${escapeHtml(where)} requires a verified adult</h1>
        <p class="age-gate-lede">
            This site contains sexually explicit material. ${escapeHtml(where)} law
            requires us to confirm you are 18 or older before showing any of it,
            using a commercially reasonable method — a self-declaration is not one
            of them, so there is no button here.
        </p>
        ${
            policy?.citation
                ? `<p class="age-gate-cite">${escapeHtml(policy.citation)}${
                      policy.statuteUrl
                          ? ` · <a href="${escapeHtml(policy.statuteUrl)}" target="_blank"
                                 rel="noopener noreferrer">read the statute</a>`
                          : ''
                  }</p>`
                : ''
        }
        ${
            mustChoose
                ? `<fieldset class="age-gate-methods" data-choice>
                       <legend>${escapeHtml(where)} law lets you choose how</legend>
                       ${choices
                           .map(
                               (m) => `
                           <label class="age-gate-method${m.disabled ? ' is-unavailable' : ''}">
                               <input type="radio" name="age-method" value="${escapeHtml(m.id)}"${
                                   m === first ? ' checked' : ''
                               }${m.disabled ? ' disabled' : ''} />
                               <span><strong>${escapeHtml(m.label)}</strong> — ${escapeHtml(m.describe)}${
                                   m.disabled ? ' <em>Not available on this server.</em>' : ''
                               }</span>
                           </label>`
                           )
                           .join('')}
                   </fieldset>`
                : choices.length
                  ? `<ul class="age-gate-methods">${choices
                        .map((m) => `<li><strong>${escapeHtml(m.label)}</strong> — ${escapeHtml(m.describe)}</li>`)
                        .join('')}</ul>`
                  : ''
        }
        <p class="age-gate-note">
            You do not need an account. The check is run by an independent
            verification provider; we are sent a yes or a no, never see your
            document, and keep no record of you${
                policy?.sessionMinutes
                    ? `. ${escapeHtml(where)} caps a verified session at ${policy.sessionMinutes} minutes`
                    : ''
            }.
        </p>
        ${consentHtml('document', state.consent, 'What the provider collects')}
        ${consentHtml(SELFIE_METHOD, state.selfieConsent, 'What happens to the photograph')}
        <div class="age-gate-camera" data-camera hidden>
            <video class="age-gate-cam" data-cam playsinline muted></video>
            <p class="age-gate-camhint">
                Look straight at the camera in even light, with nobody else in shot.
                The photo is sent once and is not saved anywhere.
            </p>
        </div>
        <p class="age-gate-status" data-status role="status" aria-live="polite">${
            ready
                ? ''
                : 'Age verification is not available on this server yet, so there is no way through from ' +
                  escapeHtml(where) +
                  '. Nothing on this site will be shown until there is.'
        }</p>
        <div class="age-gate-actions">
            <button type="button" class="btn btn-primary" data-verify${ready ? '' : ' disabled'}>${
                first?.id === SELFIE_METHOD ? 'Start the camera' : 'Verify my age'
            }</button>
            <button type="button" class="btn btn-secondary" data-leave>Leave</button>
        </div>`;
}

/**
 * One disclosure, hidden until the method it describes is the chosen one.
 *
 * Both are rendered rather than fetched on demand, because a visitor deciding
 * between two routes has to be able to read what each one does *before*
 * picking, and a disclosure that arrives after the choice is not a disclosure.
 * Only the one in play is shown, so the screen does not ask somebody to read
 * two policies to answer one question.
 *
 * Each block carries its own agreement box. Sharing one between them would let
 * a tick against the document disclosure count as agreement to the selfie one,
 * which is the whole thing versioned consent exists to stop.
 */
function consentHtml(kind, consent, summary) {
    if (!consent) return '';

    return `
        <div class="age-gate-disclosure" data-consent-for="${escapeHtml(kind)}" hidden>
            <details class="age-gate-consent">
                <summary>${escapeHtml(summary)}</summary>
                ${consent.text
                    .split('\n\n')
                    .map((para) => `<p>${escapeHtml(para)}</p>`)
                    .join('')}
            </details>
            <label class="age-gate-agree">
                <input type="checkbox" data-consent />
                <span>I have read the above and agree to the check.</span>
            </label>
        </div>`;
}

/* ----------------------------------------------------------- the real check -- */

/**
 * Run the check the visitor chose, for somebody with no account.
 *
 * Two shapes behind one button. The document routes hand off to a popup, wait,
 * and ask the server for a verdict — the same three steps the account flow
 * takes, minus the account, with `sleepUntilReturn` shared so a provider that
 * navigates home early cuts the wait short here too.
 *
 * The anonymous route does none of that. It opens the camera in this page,
 * sends one frame, and is answered in the response: no popup, no polling, no
 * reference to a session, because there is no session. That is what lets the
 * disclosure beside it promise that nothing is kept — see
 * `server/identity/visitor-gate.js` for the half of that promise this page
 * cannot make on its own.
 */
function wireVerification(root, state, done, again) {
    const button = root.querySelector('[data-verify]');
    const status = root.querySelector('[data-status]');
    const camera = root.querySelector('[data-camera]');
    const preview = root.querySelector('[data-cam]');

    if (!button) return;

    const region = regionOf(state.jurisdiction);

    const say = (message) => {
        if (status) status.textContent = message;
    };

    /** @type {MediaStream|null} Non-null only between opening and capturing. */
    let stream = null;
    let armed = false;

    showDisclosure();

    for (const radio of root.querySelectorAll('input[name="age-method"]')) {
        // Changing method closes the camera. Leaving it running behind a
        // disclosure the visitor is no longer agreeing to would be a lit
        // camera light with no consent on screen explaining it.
        radio.addEventListener('change', closeCamera);
    }

    root.querySelector('[data-leave]')?.addEventListener('click', closeCamera);

    button.addEventListener('click', async () => {
        if (armed) {
            await capture();
            return;
        }

        const kind = disclosureKind(root);
        const consent = root.querySelector(`[data-consent-for="${kind}"] [data-consent]`);

        if (consent && !consent.checked) {
            say('Please read and agree to the check first.');
            consent.focus();
            return;
        }

        if (kind === SELFIE_METHOD) await openCamera();
        else await runDocumentCheck();
    });

    /** Show the disclosure for the chosen method, and name the button for it. */
    function showDisclosure() {
        const kind = disclosureKind(root);

        for (const block of root.querySelectorAll('[data-consent-for]')) {
            block.hidden = block.dataset.consentFor !== kind;
        }

        if (!armed) button.textContent = kind === SELFIE_METHOD ? 'Start the camera' : 'Verify my age';
    }

    async function openCamera() {
        if (!cameraAvailable() || !preview) {
            say('This browser will not let the page use a camera. Choose one of the other methods above.');
            return;
        }

        button.disabled = true;
        say('Starting the camera…');

        try {
            stream = await openSelfieCamera(preview);
        } catch (err) {
            button.disabled = false;
            say(cameraProblem(err));
            return;
        }

        if (camera) camera.hidden = false;

        armed = true;
        button.disabled = false;
        button.textContent = 'Take the photo';
        say('When your face fills the frame, take the photo.');
    }

    function closeCamera() {
        stopSelfieCamera(stream, preview);
        stream = null;


        if (camera) camera.hidden = true;

        armed = false;
        showDisclosure();
    }

    async function capture() {
        button.disabled = true;
        say('Checking…');

        const photo = await frameFrom(preview);

        // Closed before the request, not after: the visitor should not be
        // watching themselves on camera while the answer comes back, and the
        // frame we need is already in hand.
        closeCamera();

        if (!photo) {
            button.disabled = false;
            say('The photo could not be taken. Try again.');
            return;
        }

        const verdict = await sendSelfie(photo, state.selfieConsent?.version);

        if (verdict.status === 'verified') {
            done('selfie');
            return;
        }

        if (verdict.recheck) {
            again();
            return;
        }

        // `error` and `rejected` are both reported, and kept apart by the
        // parameter: one is a check that said no and one is a check that did
        // not happen, and conflating them would hide a provider outage inside
        // what looks like a run of under-18 visitors.
        track(EVENTS.AGE_GATE_FAILED, { region, via: 'selfie', outcome: verdict.status });

        button.disabled = false;
        say(verdict.message);
    }

    async function runDocumentCheck() {
        button.disabled = true;
        say('Opening the check…');

        // Opened before the request, not after. A popup opened out of an
        // `await` has lost its user gesture and Safari blocks it; opening it
        // blank first keeps the gesture and gives us a window to point at the
        // provider once we know where they are.
        const popup = window.open('', 'avr-age-check', 'width=480,height=720');

        const started = await start(root, state);

        if (!started.ok) {
            popup?.close();
            button.disabled = false;

            if (started.recheck) {
                again();
                return;
            }

            say(started.message);
            return;
        }

        if (popup) {
            popup.location.href = started.clientUrl;
            say('Waiting for the check to finish. A window has opened — follow it through there.');
        } else {
            // Said before the link is appended, because `say` replaces the
            // text of the element the link goes into.
            say('Your browser blocked the check window. ');
            offerLink(status, started.clientUrl);
        }

        const verdict = await poll(popup);

        if (verdict === 'verified') {
            done('document');
            return;
        }

        track(EVENTS.AGE_GATE_FAILED, { region, via: 'document', outcome: verdict });

        popup?.close();
        button.disabled = false;

        say(
            verdict === 'rejected'
                ? 'The check did not confirm you are 18 or older. Nothing on this site can be shown to you.'
                : 'The check did not finish. You can start it again.'
        );
    }
}

/**
 * Which disclosure belongs with the current choice.
 *
 * Where the state offers no choice there is no fieldset, and the server will
 * never run the anonymous route unasked, so the document one is the answer.
 */
function disclosureKind(root) {
    const picked = root.querySelector('input[name="age-method"]:checked')?.value;
    if (picked) return picked === SELFIE_METHOD ? SELFIE_METHOD : 'document';

    return root.querySelector('[data-consent-for="document"]') ? 'document' : SELFIE_METHOD;
}

/**
 * Send the frame and read the verdict.
 *
 * The consent version travels as a header because the body is the photograph.
 * It is also the only thing making this request impossible to forge from
 * another origin: a custom header forces a preflight, where a form post or an
 * `<img>` would otherwise let any site on the internet quietly mint an age
 * cookie in a visitor's browser.
 */
async function sendSelfie(photo, version) {
    let res;
    try {
        res = await fetch('/api/identity/gate/verify/selfie', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': photo.type || 'image/jpeg',
                Accept: 'application/json',
                'X-AVR-Consent-Version': version ?? ''
            },
            body: photo
        });
    } catch {
        return { status: 'error', message: 'The photo could not be sent. Check your connection and try again.' };
    }

    const body = await res.json().catch(() => ({}));

    if (body.status === 'verified') return { status: 'verified' };

    // The state under this request changed while the camera was open. The new
    // gate is the answer, not an error about the old one.
    if (body.error === 'no_verification_required' || body.error === 'anonymous_verification_not_offered') {
        return { status: 'error', recheck: true };
    }

    if (body.code === 'identity_not_configured') {
        return {
            status: 'error',
            message: 'Anonymous verification is not set up on this server. Choose one of the other methods above.'
        };
    }

    if (res.status === 429) {
        return {
            status: 'error',
            message: 'Too many attempts from this connection. Wait a while, or choose one of the other methods above.'
        };
    }

    if (body.status === 'rejected') return { status: 'rejected', message: declineText(body) };

    return { status: 'error', message: 'The check could not be completed. Please try again in a moment.' };
}

async function start(root, state) {
    const method = root.querySelector('input[name="age-method"]:checked')?.value;

    let res;
    try {
        res = await fetch('/api/identity/gate/verify', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                consent: true,
                consentVersion: state.consent?.version,
                ...(method ? { method } : {})
            })
        });
    } catch {
        return { ok: false, message: 'The check could not be started. Check your connection and try again.' };
    }

    const body = await res.json().catch(() => ({}));

    if (res.status === 201 && body.clientUrl) return { ok: true, clientUrl: body.clientUrl };

    // The state under this request changed between the gate rendering and the
    // button being pressed — a VPN toggled, a phone changing network. The new
    // gate is the answer, not an error message about the old one.
    if (body.error === 'no_verification_required') return { ok: false, recheck: true };

    if (body.error === 'choose_verification_method') {
        return { ok: false, message: 'Choose how you would like to be checked.' };
    }

    // Only reachable from a page older than the server, which is a cached
    // bundle rather than a visitor doing anything wrong. Re-asking draws the
    // gate the current server describes, camera and all.
    if (body.error === 'use_selfie_route') return { ok: false, recheck: true };

    if (body.code === 'identity_not_configured') {
        return { ok: false, message: 'Age verification is not available on this server yet.' };
    }

    return { ok: false, message: 'The check could not be started. Please try again in a moment.' };
}

/**
 * Ask the server, not the popup, how it went.
 *
 * A closed popup is a hint that the visitor gave up, not a verdict — they can
 * close it after the provider has already recorded a pass — so it is worth one
 * more ask before giving up on it.
 */
async function poll(popup) {
    const until = Date.now() + POLL_CEILING_MS;
    let lastChance = true;

    while (Date.now() < until) {
        await sleepUntilReturn(POLL_MS, 'age');

        let res;
        try {
            res = await fetch('/api/identity/gate/verify/complete', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' }
            });
        } catch {
            continue;
        }

        const body = await res.json().catch(() => ({}));

        if (body.status === 'verified') return 'verified';
        if (body.status === 'rejected') return 'rejected';
        if (res.status === 409) return 'abandoned';

        if (popup?.closed) {
            if (!lastChance) return 'abandoned';
            lastChance = false;
        }
    }

    return 'abandoned';
}

/** Popups are blocked more often than not on a phone. Offer the link instead. */
function offerLink(status, url) {
    if (!status) return;

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open the check';
    status.append(link);
}

/**
 * @param {string} [version] the wording the visitor was actually shown
 * @returns {Promise<boolean>}
 */
async function attest(version) {
    try {
        const res = await fetch('/api/identity/gate/attest', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirmed: true, version })
        });

        return res.ok;
    } catch {
        return false;
    }
}

function trapFocus(root) {
    // Rendered, not merely present: the gate carries two disclosures and a
    // camera panel of which at most one is on screen, and tabbing into a
    // hidden one would move focus somewhere the visitor cannot see it.
    const stops = () =>
        [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), summary')].filter(
            (el) => el.getClientRects().length > 0
        );

    stops()[0]?.focus();

    root.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;

        const list = stops();
        if (!list.length) return;

        const first = list[0];
        const last = list[list.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
