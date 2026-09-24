/** Inline SVG icon set. Stroke-based so they inherit `currentColor`. */

const svg = (paths, opts = {}) =>
    `<svg viewBox="0 0 24 24" width="${opts.size || 20}" height="${opts.size || 20}" fill="${opts.fill || 'none'}" ` +
    `stroke="${opts.fill && opts.fill !== 'none' ? 'none' : 'currentColor'}" stroke-width="${opts.w || 2}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const icons = {
    play: (o) => svg('<polygon points="6 3 20 12 6 21 6 3"/>', { fill: 'currentColor', ...o }),
    pause: (o) => svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>', { fill: 'currentColor', ...o }),
    info: (o) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>', o),
    plus: (o) => svg('<path d="M12 5v14M5 12h14"/>', o),
    check: (o) => svg('<path d="M20 6 9 17l-5-5"/>', o),
    chevronLeft: (o) => svg('<path d="m15 18-6-6 6-6"/>', o),
    chevronRight: (o) => svg('<path d="m9 18 6-6-6-6"/>', o),
    close: (o) => svg('<path d="M18 6 6 18M6 6l12 12"/>', o),
    search: (o) => svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', o),
    back: (o) => svg('<path d="M19 12H5M12 19l-7-7 7-7"/>', o),
    volume: (o) => svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>', o),
    mute: (o) => svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/>', o),
    forward10: (o) => svg('<path d="M12 5V2L8 6l4 4V7a6 6 0 1 1-6 6"/><text x="11" y="16" font-size="7" stroke="none" fill="currentColor">10</text>', o),
    back10: (o) => svg('<path d="M12 5V2l4 4-4 4V7a6 6 0 1 0 6 6"/><text x="7" y="16" font-size="7" stroke="none" fill="currentColor">10</text>', o),
    fullscreen: (o) => svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>', o),
    recenter: (o) => svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>', o),
    headset: (o) => svg('<path d="M4 14a8 8 0 0 1 16 0"/><rect x="2" y="13" width="20" height="7" rx="3"/><path d="M9 20v-3M15 20v-3"/>', o),
    cast: (o) => svg('<path d="M2 16a6 6 0 0 1 6 6M2 20a2 2 0 0 1 2 2"/><rect x="2" y="4" width="20" height="12" rx="2"/>', o),
    settings: (o) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"/>', o)
};
