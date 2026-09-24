import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildLibrary } from './library.js';

/**
 * Minimal UPnP/DLNA MediaServer.
 *
 * SkyBox VR Player and Pigasus both discover libraries this way, and neither
 * needs anything beyond the subset implemented here: SSDP discovery, a device
 * description, and the ContentDirectory `Browse` action returning DIDL-Lite.
 *
 * Two details matter more than the protocol plumbing:
 *
 *   - The `res` URL ends in a conventionally-named file, because these players
 *     read 180/360 and 3dh/3dv from the filename rather than from any metadata
 *     field DLNA offers.
 *   - `DLNA.ORG_OP=01` advertises byte-range seeking. Without it players either
 *     refuse to scrub or re-download from zero on every seek.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UUID_FILE = path.join(__dirname, '..', '.dlna-uuid');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const ANNOUNCE_INTERVAL_MS = 30_000;

const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1';
const CD_SERVICE = 'urn:schemas-upnp-org:service:ContentDirectory:1';

/** Stable across restarts so players do not accumulate stale library entries. */
function getUuid() {
    try {
        return fs.readFileSync(UUID_FILE, 'utf8').trim();
    } catch {
        const uuid = crypto.randomUUID();
        try {
            fs.writeFileSync(UUID_FILE, uuid);
        } catch {
            /* read-only deployment - a per-run uuid still works */
        }
        return uuid;
    }
}

/** First non-internal IPv4 address; headsets need this, not 127.0.0.1. */
export function lanAddress() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs || []) {
            if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
    }
    return '127.0.0.1';
}

function xmlEscape(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** DIDL wants H:MM:SS.mmm. */
function didlDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`;
}

export class DlnaServer {
    /**
     * @param {object} opts
     * @param {number} opts.port - HTTP port the Express app listens on.
     * @param {string} [opts.friendlyName]
     */
    constructor({ port, friendlyName = 'ProjectAVR Library' }) {
        this.port = port;
        this.friendlyName = friendlyName;
        this.uuid = getUuid();
        this.udn = `uuid:${this.uuid}`;
        this.socket = null;
        this.timer = null;
    }

    get location() {
        return `http://${lanAddress()}:${this.port}/dlna/device.xml`;
    }

    get baseUrl() {
        return `http://${lanAddress()}:${this.port}`;
    }

    /* --------------------------------------------------------------- ssdp -- */

    start() {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.socket = socket;

        socket.on('error', (err) => {
            console.warn('[dlna] ssdp socket error:', err.message);
        });

        socket.on('message', (msg, rinfo) => this._onSsdpMessage(msg.toString(), rinfo));

        socket.bind(SSDP_PORT, () => {
            try {
                socket.addMembership(SSDP_ADDR);
                socket.setMulticastTTL(4);
            } catch (err) {
                console.warn('[dlna] could not join multicast group:', err.message);
            }

            this._announce('ssdp:alive');
            this.timer = setInterval(() => this._announce('ssdp:alive'), ANNOUNCE_INTERVAL_MS);
            console.log(`[dlna] "${this.friendlyName}" advertising at ${this.location}`);
        });
    }

    stop() {
        clearInterval(this.timer);
        if (this.socket) {
            this._announce('ssdp:byebye');
            this.socket.close();
            this.socket = null;
        }
    }

    _targets() {
        return [
            'upnp:rootdevice',
            this.udn,
            DEVICE_TYPE,
            CD_SERVICE
        ];
    }

    _announce(nts) {
        for (const target of this._targets()) {
            const usn = target === this.udn ? this.udn : `${this.udn}::${target}`;

            const lines = [
                'NOTIFY * HTTP/1.1',
                `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
                `NT: ${target}`,
                `NTS: ${nts}`,
                `USN: ${usn}`
            ];

            if (nts === 'ssdp:alive') {
                lines.push(
                    `LOCATION: ${this.location}`,
                    'CACHE-CONTROL: max-age=1800',
                    `SERVER: ${os.type()}/${os.release()} UPnP/1.0 ProjectAVR/1.0`
                );
            }

            const message = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`);
            this.socket?.send(message, 0, message.length, SSDP_PORT, SSDP_ADDR);
        }
    }

    _onSsdpMessage(message, rinfo) {
        if (!message.startsWith('M-SEARCH')) return;

        const st = /^ST:\s*(.+)$/im.exec(message)?.[1]?.trim();
        if (!st) return;

        const matches = st === 'ssdp:all' || this._targets().includes(st);
        if (!matches) return;

        // MX is the maximum seconds a device may wait before replying; spreading
        // responses out is what keeps a busy network from melting.
        const mx = Math.min(parseInt(/^MX:\s*(\d+)$/im.exec(message)?.[1] || '1', 10) || 1, 5);
        const delay = Math.floor(Math.random() * mx * 1000);

        const target = st === 'ssdp:all' ? DEVICE_TYPE : st;
        const usn = target === this.udn ? this.udn : `${this.udn}::${target}`;

        const response = Buffer.from(
            [
                'HTTP/1.1 200 OK',
                'CACHE-CONTROL: max-age=1800',
                `DATE: ${new Date().toUTCString()}`,
                'EXT:',
                `LOCATION: ${this.location}`,
                `SERVER: ${os.type()}/${os.release()} UPnP/1.0 ProjectAVR/1.0`,
                `ST: ${target}`,
                `USN: ${usn}`,
                ''
            ].join('\r\n') + '\r\n'
        );

        setTimeout(() => {
            this.socket?.send(response, 0, response.length, rinfo.port, rinfo.address);
        }, delay);
    }

    /* --------------------------------------------------------------- http -- */

    /**
     * @param {import('express').Express} app
     */
    mount(app) {
        app.get('/dlna/device.xml', (req, res) => {
            res.type('application/xml').send(this._deviceDescription());
        });

        app.get('/dlna/ContentDirectory.xml', (req, res) => {
            res.type('application/xml').send(CONTENT_DIRECTORY_SCD);
        });

        // UPnP control endpoint. Clients POST a SOAP envelope here.
        app.post('/dlna/control', async (req, res) => {
            const body = req.body?.toString?.('utf8') || '';

            if (!/[<:]Browse[\s>]/.test(body)) {
                // Only Browse is implemented; Search is optional in the spec and
                // no headset player requires it.
                res.status(501).type('application/xml').send(soapFault('Optional action not implemented'));
                return;
            }

            try {
                res.type('application/xml').send(await this._handleBrowse(body));
            } catch (err) {
                console.error('[dlna] browse failed:', err);
                res.status(500).type('application/xml').send(soapFault(err.message));
            }
        });

        app.all('/dlna/events', (req, res) => {
            // GENA subscriptions are accepted and ignored: we never push updates,
            // and players tolerate that far better than a connection refusal.
            res.set('SID', `uuid:${crypto.randomUUID()}`).set('TIMEOUT', 'Second-1800').status(200).end();
        });
    }

    _deviceDescription() {
        return `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>${DEVICE_TYPE}</deviceType>
    <friendlyName>${xmlEscape(this.friendlyName)}</friendlyName>
    <manufacturer>ProjectAVR</manufacturer>
    <modelName>ProjectAVR Media Server</modelName>
    <modelNumber>1.0</modelNumber>
    <UDN>${this.udn}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>
    <serviceList>
      <service>
        <serviceType>${CD_SERVICE}</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <SCPDURL>/dlna/ContentDirectory.xml</SCPDURL>
        <controlURL>/dlna/control</controlURL>
        <eventSubURL>/dlna/events</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
    }

    /**
     * ContentDirectory:Browse.
     *
     * Object ids are flat strings: `0` is the root, `shelf:<n>` is a shelf
     * container, and `item:<id>` is a title. A two-level tree is all these
     * players present anyway.
     */
    async _handleBrowse(body) {
        const objectId = /<ObjectID>(.*?)<\/ObjectID>/s.exec(body)?.[1]?.trim() || '0';
        const browseFlag = /<BrowseFlag>(.*?)<\/BrowseFlag>/s.exec(body)?.[1]?.trim() || 'BrowseDirectChildren';
        const startIndex = parseInt(/<StartingIndex>(\d+)<\/StartingIndex>/s.exec(body)?.[1] || '0', 10);
        const requested = parseInt(/<RequestedCount>(\d+)<\/RequestedCount>/s.exec(body)?.[1] || '0', 10);

        const { items, rows } = await buildLibrary();
        const shelves = this._shelves(items, rows);

        let didlEntries = [];
        let total = 0;

        if (browseFlag === 'BrowseMetadata') {
            didlEntries = [this._containerXml('0', '-1', this.friendlyName, shelves.length)];
            total = 1;
        } else if (objectId === '0') {
            total = shelves.length;
            didlEntries = shelves.map((shelf, i) =>
                this._containerXml(`shelf:${i}`, '0', shelf.title, shelf.items.length)
            );
        } else if (objectId.startsWith('shelf:')) {
            const shelf = shelves[parseInt(objectId.slice(6), 10)];
            const list = shelf ? shelf.items : [];
            total = list.length;

            const slice = requested > 0 ? list.slice(startIndex, startIndex + requested) : list.slice(startIndex);
            didlEntries = slice.map((item) => this._itemXml(item, objectId));
        }

        const didl =
            `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
            `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
            `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
            `xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">${didlEntries.join('')}</DIDL-Lite>`;

        return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:BrowseResponse xmlns:u="${CD_SERVICE}">
      <Result>${xmlEscape(didl)}</Result>
      <NumberReturned>${didlEntries.length}</NumberReturned>
      <TotalMatches>${total}</TotalMatches>
      <UpdateID>1</UpdateID>
    </u:BrowseResponse>
  </s:Body>
</s:Envelope>`;
    }

    _shelves(items, rows) {
        if (rows && rows.length) {
            return rows.map((row) => ({
                title: row.title,
                items: row.items.map((id) => items.find((i) => i.id === id)).filter(Boolean)
            }));
        }

        return [
            { title: 'VR 180', items: items.filter((i) => i.format.projection === 'dome180') },
            { title: '360 Video', items: items.filter((i) => i.format.projection === 'sphere360') },
            { title: 'Fisheye', items: items.filter((i) => i.format.projection === 'fisheye') },
            { title: 'Standard', items: items.filter((i) => i.format.projection === 'flat') },
            { title: 'All Titles', items }
        ].filter((shelf) => shelf.items.length);
    }

    _containerXml(id, parentId, title, childCount) {
        return (
            `<container id="${xmlEscape(id)}" parentID="${xmlEscape(parentId)}" restricted="1" ` +
            `childCount="${childCount}" searchable="0">` +
            `<dc:title>${xmlEscape(title)}</dc:title>` +
            `<upnp:class>object.container.storageFolder</upnp:class>` +
            `</container>`
        );
    }

    _itemXml(item, parentId) {
        // The URL's final segment carries the layout tags, which is the only
        // channel these players actually read them from.
        const url = `${this.baseUrl}/media/by-name/${encodeURIComponent(item.id)}/${encodeURIComponent(
            item.conventionalFilename
        )}`;

        const protocolInfo =
            `http-get:*:${item.mime || 'video/mp4'}:` +
            `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;

        const attrs = [`protocolInfo="${protocolInfo}"`];
        if (item.size) attrs.push(`size="${item.size}"`);
        if (item.duration) attrs.push(`duration="${didlDuration(item.duration)}"`);
        if (item.width && item.height) attrs.push(`resolution="${item.width}x${item.height}"`);

        // Titling with the conventional name (rather than the pretty name) is
        // deliberate: players that sniff the title instead of the URL still get
        // the right projection.
        const displayTitle = item.conventionalFilename.replace(/\.[^.]+$/, '');

        return (
            `<item id="item:${xmlEscape(item.id)}" parentID="${xmlEscape(parentId)}" restricted="1">` +
            `<dc:title>${xmlEscape(displayTitle)}</dc:title>` +
            `<upnp:class>object.item.videoItem</upnp:class>` +
            (item.synopsis ? `<dc:description>${xmlEscape(item.synopsis)}</dc:description>` : '') +
            (item.genre ? `<upnp:genre>${xmlEscape(item.genre)}</upnp:genre>` : '') +
            `<res ${attrs.join(' ')}>${xmlEscape(url)}</res>` +
            `</item>`
        );
    }
}

function soapFault(message) {
    return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><s:Fault>
    <faultcode>s:Client</faultcode>
    <faultstring>UPnPError</faultstring>
    <detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
      <errorCode>401</errorCode><errorDescription>${xmlEscape(message)}</errorDescription>
    </UPnPError></detail>
  </s:Fault></s:Body>
</s:Envelope>`;
}

const CONTENT_DIRECTORY_SCD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action>
      <name>Browse</name>
      <argumentList>
        <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
        <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
        <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
        <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
        <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
        <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
        <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
        <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
      </argumentList>
    </action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType>
      <allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;
