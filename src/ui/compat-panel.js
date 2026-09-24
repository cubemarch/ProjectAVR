import { icons } from './icons.js';
import { buildConventionalFilename } from '../catalog/media-format.js';

/**
 * "Connect a VR player" panel.
 *
 * Native headset players discover libraries in one of three ways, and this
 * panel surfaces the right endpoint for each:
 *
 *   JSON API    - DeoVR and Play'a read the DeoVR feed format directly
 *   DLNA/UPnP   - SkyBox and Pigasus browse the network for a media server
 *   Plain files - Whirligig and every other player open a URL or playlist, and
 *                 read projection from the filename
 *
 * Nothing here is player-specific magic; it is the same catalog exposed three
 * ways, which is why adding a fourth player rarely means adding a fourth
 * backend.
 */

const PLAYERS = [
    {
        name: "Play'a",
        transport: 'DeoVR JSON feed',
        endpointKey: 'deovr',
        steps: [
            'Open Play\'a and go to the Web / Sites tab.',
            'Choose "Add site" and paste the feed URL below.',
            'The library appears as a browsable site with full 3D metadata.'
        ]
    },
    {
        name: 'DeoVR',
        transport: 'DeoVR JSON feed',
        endpointKey: 'deovr',
        steps: [
            'Open DeoVR and switch to the built-in browser.',
            'Enter the feed URL below in the address bar.',
            'DeoVR reads projection and stereo mode from the feed automatically.'
        ]
    },
    {
        name: 'SkyBox VR Player',
        transport: 'DLNA / UPnP',
        endpointKey: 'dlna',
        steps: [
            'Make sure the headset is on the same network as this server.',
            'In SkyBox open Network → DLNA and pick the server name below.',
            'Projection is read from the filename, which the server already encodes.'
        ]
    },
    {
        name: 'Pigasus VR Player',
        transport: 'DLNA / UPnP',
        endpointKey: 'dlna',
        steps: [
            'Open Pigasus and go to Network → UPnP/DLNA.',
            'Select the server below; browse by shelf just like the web UI.',
            'Pigasus honours the 180/360 and 3dh/3dv tags in each filename.'
        ]
    },
    {
        name: 'Whirligig',
        transport: 'M3U playlist / direct URL',
        endpointKey: 'm3u',
        steps: [
            'In Whirligig open the file browser and choose "Open URL".',
            'Paste the playlist URL below to load the whole library at once.',
            'Whirligig picks up the projection tags from each filename.'
        ]
    }
];

export class CompatPanel {
    /**
     * @param {{items: object[]}} catalog
     */
    constructor(catalog) {
        this.catalog = catalog;
        this.el = null;
        this.origin = location.origin;
    }

    /**
     * A headset cannot reach `localhost`, so URLs copied out of this panel have
     * to carry the machine's LAN address. The server knows it; ask before
     * rendering anything the user is meant to type into another device.
     */
    async _resolveOrigin() {
        if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
            this.origin = location.origin;
            return;
        }

        try {
            const res = await fetch('/api/health');
            const { lan, port } = await res.json();
            if (lan && lan !== '127.0.0.1') {
                this.origin = `${location.protocol}//${lan}:${port}`;
            }
        } catch {
            // No backend (static hosting) - the page origin is the best guess.
        }
    }

    _endpoints() {
        return {
            deovr: `${this.origin}/deovr`,
            dlna: 'ProjectAVR Library',
            m3u: `${this.origin}/playlist.m3u`
        };
    }

    async open() {
        if (!this.el) {
            await this._resolveOrigin();
            this._build();
        }
        this.el.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    close() {
        this.el?.classList.remove('open');
        document.body.style.overflow = '';
    }

    _build() {
        const endpoints = this._endpoints();

        const el = document.createElement('div');
        el.className = 'modal-backdrop compat-backdrop';
        el.innerHTML = `
            <div class="modal compat-modal">
                <div class="compat-head">
                    <button class="modal-close">${icons.close({ size: 18 })}</button>
                    <h2>Connect a VR player</h2>
                    <p>
                        This library is exposed to native headset apps three ways at once.
                        Pick your player below - everything points at the same catalog, so
                        the shelves stay identical wherever you watch.
                    </p>
                </div>

                <div class="compat-endpoints">
                    ${this._endpointRow('DeoVR / Play\'a feed', endpoints.deovr, 'JSON API')}
                    ${this._endpointRow('DLNA server name', endpoints.dlna, 'UPnP', { copy: false })}
                    ${this._endpointRow('Playlist', endpoints.m3u, 'M3U')}
                </div>

                <p class="compat-note">
                    These addresses point at <code>${this.origin}</code>. Your headset must be on
                    the same network, and this server has to stay running while you watch.
                </p>

                <div class="compat-grid">
                    ${PLAYERS.map((p) => this._playerCard(p, endpoints)).join('')}
                </div>

                <div class="compat-naming">
                    <h3>Filename conventions</h3>
                    <p>
                        Players without an API read layout from the filename. The server
                        serves every title under a conventional name, so a file copied to a
                        headset, an SMB share or a USB stick keeps its metadata:
                    </p>
                    <ul>
                        ${this.catalog.items
                            .slice(0, 6)
                            .map(
                                (item) =>
                                    `<li><code>${buildConventionalFilename(item.title, item.format, {
                                        height: item.height
                                    })}</code></li>`
                            )
                            .join('')}
                    </ul>
                </div>
            </div>
        `;

        el.addEventListener('click', (e) => {
            if (e.target === el || e.target.closest('.modal-close')) {
                this.close();
                return;
            }

            const copyBtn = e.target.closest('[data-copy]');
            if (copyBtn) this._copy(copyBtn);
        });

        document.body.appendChild(el);
        this.el = el;
    }

    _endpointRow(label, value, tag, opts = {}) {
        return `
            <div class="endpoint">
                <div class="endpoint-label">
                    <span class="badge vr">${tag}</span>
                    ${label}
                </div>
                <code>${value}</code>
                ${opts.copy === false ? '' : `<button class="btn btn-secondary sm" data-copy="${value}">Copy</button>`}
            </div>
        `;
    }

    _playerCard(player, endpoints) {
        return `
            <article class="compat-card">
                <header>
                    <h3>${player.name}</h3>
                    <span class="badge vr">${player.transport}</span>
                </header>
                <ol>${player.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
                <code>${endpoints[player.endpointKey]}</code>
            </article>
        `;
    }

    async _copy(btn) {
        const text = btn.dataset.copy;

        try {
            await navigator.clipboard.writeText(text);
            const original = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => {
                btn.textContent = original;
            }, 1600);
        } catch {
            // Clipboard access is blocked on insecure origins; selecting the
            // text is the fallback everyone already knows.
            const range = document.createRange();
            range.selectNodeContents(btn.previousElementSibling);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }
}
