/**
 * What each headset can actually play.
 *
 * Every delivery surface - the DeoVR/Play'a feed, DLNA, the M3U export, the
 * browser player - offers the same packaged renditions. What differs is which
 * of them a given client is *told about*, and that is the whole job of this
 * table.
 *
 * Offering a rung a headset cannot decode is not a harmless extra choice. DeoVR
 * and Play'a put every `videoSources` entry in the quality menu, so an 8K rung
 * on a Quest 2 is a menu item that produces a black screen; DLNA players often
 * take the *first* `<res>` they are given and nothing else. The ceiling has to
 * be applied where the list is built.
 *
 * ## Where these numbers come from, and how confident they are
 *
 * They are deliberately conservative hardware-decode ceilings, not marketing
 * maxima, and they are stated per codec because that is what the ceiling
 * actually depends on. A Quest 3 decodes 8K HEVC and does *not* decode 8K
 * H.264 - the limit is the H.264 decoder's, around 4096 wide, not the SoC's.
 * Since the default ladder is H.264 only (see `AVR_PACKAGE_CODECS`), the
 * practical effect today is that every standalone headset is capped near 4K and
 * the 8K rungs are reachable only by PC players. Turning on the HEVC ladder is
 * what lifts that, and the `codecs` field below is what then routes it.
 *
 * Anything here can be overridden per deployment with `AVR_DEVICE_PROFILES`, a
 * JSON object of `{ "<id>": { "maxHeight": n, "maxBitrateKbps": n } }`, because
 * these are judgement calls about other people's hardware and a self-hoster who
 * has measured their own fleet knows better than this file does.
 */

/**
 * @typedef {object} DeviceProfile
 * @property {string} id
 * @property {string} label
 * @property {Record<string, number>} maxHeight - Ceiling per codec.
 * @property {number} maxBitrateKbps - Sustained ceiling over Wi-Fi.
 * @property {string[]} codecs - Best first.
 * @property {'hls'|'progressive'} container - What the client prefers to be handed.
 * @property {RegExp|null} match - User-Agent test.
 * @property {string} note
 */

/** @type {DeviceProfile[]} */
const BUILT_IN = [
    {
        id: 'visionpro',
        label: 'Apple Vision Pro',
        maxHeight: { hevc: 4320, h264: 2160 },
        maxBitrateKbps: 80_000,
        codecs: ['hevc', 'h264'],
        container: 'hls',
        // visionOS Safari reports itself as a Mac unless the site is asked for
        // the mobile view, so both spellings have to be caught.
        match: /Vision\s?Pro|visionOS/i,
        note: 'Native HLS. HEVC in hvc1 is the first-class path; H.264 is the fallback and is the one that caps at 4K.'
    },
    {
        id: 'quest3',
        label: 'Meta Quest 3 / 3S',
        maxHeight: { hevc: 4320, h264: 2160 },
        maxBitrateKbps: 60_000,
        codecs: ['hevc', 'h264'],
        container: 'hls',
        match: /Quest\s?3/i,
        note: 'Snapdragon XR2 Gen 2. 8K HEVC decodes; 8K H.264 does not. 60 Mbps is what clears the 8K HEVC rung, which encodes at around 58.'
    },
    {
        id: 'quest2',
        label: 'Meta Quest 2 / Quest Pro',
        maxHeight: { hevc: 2880, h264: 2160 },
        maxBitrateKbps: 35_000,
        codecs: ['hevc', 'h264'],
        container: 'hls',
        match: /Quest\s?(2|Pro)|Quest(?!\s?3)/i,
        // 35 rather than 25: the 4K stereo rung encodes at about 29 Mbps, and a
        // ceiling under that would have made the rung most of these headsets
        // are actually for unreachable on the commonest headset there is. A
        // Quest 2 on 5 GHz holds well past this for a stored file.
        note: 'XR2 Gen 1. Comfortably 4K; 5.7K HEVC only at 30 fps, so bitrate is the binding ceiling above 4K rather than resolution.'
    },
    {
        id: 'pico4',
        label: 'Pico 4 / Pico 4 Ultra',
        maxHeight: { hevc: 2880, h264: 2160 },
        maxBitrateKbps: 35_000,
        codecs: ['hevc', 'h264'],
        container: 'hls',
        match: /Pico\s?(4|Neo)/i,
        note: 'XR2 Gen 1, same envelope as Quest 2.'
    },
    {
        id: 'pcvr',
        label: 'PC VR (Whirligig, DeoVR desktop, SteamVR)',
        maxHeight: { hevc: Infinity, h264: Infinity },
        maxBitrateKbps: Infinity,
        codecs: ['hevc', 'h264'],
        container: 'progressive',
        match: /Whirligig|DeoVR.*Windows|Windows NT.*VR/i,
        // A desktop GPU will decode anything in the ladder, and these players
        // seek by byte range in a local-network file rather than by segment.
        note: 'No practical ceiling. Prefers a single progressive file it can scrub with byte ranges.'
    },
    {
        id: 'generic',
        label: 'Unknown client',
        maxHeight: { hevc: 2160, h264: 1440 },
        maxBitrateKbps: 16_000,
        codecs: ['h264', 'hevc'],
        container: 'hls',
        match: null,
        // H.264 first, and lower: an unidentified client is as likely to be a
        // phone browser or a smart TV as a headset, and the failure mode of
        // offering too little is a soft picture rather than a black one.
        note: 'The floor everything unrecognised gets. Errs low on purpose.'
    }
];

let overridden = null;

function overrides() {
    if (overridden) return overridden;

    overridden = BUILT_IN;

    const raw = process.env.AVR_DEVICE_PROFILES;
    if (!raw) return overridden;

    try {
        const patch = JSON.parse(raw);
        overridden = BUILT_IN.map((profile) => {
            const p = patch[profile.id];
            if (!p) return profile;

            return {
                ...profile,
                maxHeight:
                    typeof p.maxHeight === 'number'
                        ? Object.fromEntries(Object.keys(profile.maxHeight).map((c) => [c, p.maxHeight]))
                        : { ...profile.maxHeight, ...(p.maxHeight ?? {}) },
                maxBitrateKbps: p.maxBitrateKbps ?? profile.maxBitrateKbps,
                codecs: p.codecs ?? profile.codecs,
                container: p.container ?? profile.container
            };
        });
    } catch (err) {
        console.warn(`[delivery] ignoring malformed AVR_DEVICE_PROFILES: ${err.message}`);
    }

    return overridden;
}

/** Testing seam; also what picks up an env change between runs. */
export function resetProfiles() {
    overridden = null;
}

export function listProfiles() {
    return overrides();
}

export function profileById(id) {
    return overrides().find((p) => p.id === id) ?? null;
}

export function genericProfile() {
    return profileById('generic');
}

/**
 * Identify the client.
 *
 * An explicit `?device=` always wins. It is not a hack around bad sniffing: a
 * creator checking how a title will look on a Quest 2 from their desk needs a
 * way to ask, and a player whose User-Agent this build has never seen needs a
 * way to say so.
 *
 * @param {import('express').Request} req
 * @returns {DeviceProfile}
 */
export function profileFor(req) {
    const asked = req?.query?.device;
    if (asked) {
        const found = profileById(String(asked));
        if (found) return found;
    }

    const ua = String(req?.headers?.['user-agent'] ?? '');
    return overrides().find((p) => p.match && p.match.test(ua)) ?? genericProfile();
}

/**
 * The best codec both sides have.
 *
 * @param {DeviceProfile} profile
 * @param {string[]} available - Codecs the title was actually packaged in.
 * @returns {string|null}
 */
export function bestCodec(profile, available) {
    return profile.codecs.find((codec) => available.includes(codec)) ?? available[0] ?? null;
}

/**
 * Narrow a title's renditions to the ones this client can play, highest first.
 *
 * Never returns an empty list for a title that has any renditions at all. A
 * client under every ceiling still has to be given *something*, and the
 * smallest rung is a better answer than a quality menu with nothing in it -
 * both DeoVR and SkyBox treat an empty source list as a broken title rather
 * than as an unsupported one.
 *
 * @param {object[]} renditions
 * @param {DeviceProfile} profile
 * @param {{codec?: string}} [opts]
 * @returns {object[]}
 */
export function selectRenditions(renditions, profile, { codec } = {}) {
    const all = (renditions ?? []).filter(Boolean);
    if (!all.length) return [];

    const wanted = codec ?? bestCodec(profile, [...new Set(all.map((r) => r.codec ?? 'h264'))]);
    const sameCodec = all.filter((r) => (r.codec ?? 'h264') === wanted);
    const pool = sameCodec.length ? sameCodec : all;

    const ordered = [...pool].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

    const ceiling = profile.maxHeight[wanted] ?? profile.maxHeight.h264 ?? Infinity;
    const playable = ordered.filter((r) => (r.height ?? 0) <= ceiling && (r.bitrate ?? 0) <= profile.maxBitrateKbps);

    return playable.length ? playable : [ordered[ordered.length - 1]];
}

/**
 * The single rendition to hand a surface that can only carry one URL.
 *
 * @param {object[]} renditions
 * @param {DeviceProfile} profile
 * @returns {object|null}
 */
export function preferredRendition(renditions, profile) {
    return selectRenditions(renditions, profile)[0] ?? null;
}
