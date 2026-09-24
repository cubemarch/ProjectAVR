import dgram from 'node:dgram';

import { lanAddress } from '../dlna.js';

/**
 * Discovery beacon, so the phone does not have to be told an IP address.
 *
 * The app already speaks SSDP for DLNA, and the obvious move would be to reuse
 * it - but SSDP means claiming UDP 1900, which exactly one process on a machine
 * can do, and the DLNA server already has it. Bonjour would mean a dependency
 * and an mDNS responder fighting the one macOS and iOS already run.
 *
 * So: a two-line request/response on its own port. The phone broadcasts a probe
 * and every ProjectAVR server on the subnet answers with where to connect. It
 * is a LAN convenience feature, and it deliberately does *not* hand out the
 * stream key - discovery tells you the door exists, pairing gives you the key.
 */

const DISCOVERY_PORT = Number(process.env.AVR_LIVE_DISCOVERY_PORT || 8082);

/** Probe body the phone sends. Anything else on the port is ignored. */
const PROBE = 'AVR-DISCOVER/1';

export class DiscoveryBeacon {
    /**
     * @param {object} opts
     * @param {number} opts.httpPort
     * @param {number} opts.ingestPort
     * @param {string} [opts.name]
     */
    constructor({ httpPort, ingestPort, name = 'ProjectAVR' }) {
        this.httpPort = httpPort;
        this.ingestPort = ingestPort;
        this.name = name;
        this.socket = null;
    }

    start() {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.socket = socket;

        socket.on('message', (message, remote) => {
            if (!message.toString('utf8').startsWith(PROBE)) return;

            const reply = Buffer.from(
                JSON.stringify({
                    name: this.name,
                    host: lanAddress(),
                    httpPort: this.httpPort,
                    ingestPort: this.ingestPort
                })
            );

            socket.send(reply, remote.port, remote.address, (err) => {
                if (err) console.warn(`[live] discovery reply to ${remote.address} failed: ${err.message}`);
            });
        });

        socket.on('error', (err) => {
            console.warn(`[live] discovery beacon unavailable: ${err.message}`);
            this.stop();
        });

        socket.bind(DISCOVERY_PORT, () => {
            try {
                socket.setBroadcast(true);
            } catch {
                /* not fatal - directed probes still work */
            }
        });

        // Discovery must never be the reason the process stays alive.
        socket.unref();

        return socket;
    }

    stop() {
        try {
            this.socket?.close();
        } catch {
            /* already closed */
        }
        this.socket = null;
    }
}

export { DISCOVERY_PORT, PROBE };
