export const BUILT_IN_CATALOG = [
  {
    id: 'showcase',
    title: 'Open Skies',
    subtitle: 'Streaming showcase · 3 min',
    description: 'A browser-ready showcase source used to test playback before adding your own library.',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    projection: 'flat',
    layout: 'mono',
    streamType: 'file',
    art: 'art-ember',
    tags: ['featured', 'showcase', 'flat', 'mp4'],
    featured: true
  },
  {
    id: 'bunny',
    title: 'Big Buck Bunny',
    subtitle: 'Open movie · 10 min',
    description: 'A public sample stream for regular video playback testing.',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    projection: 'flat',
    layout: 'mono',
    streamType: 'file',
    art: 'art-forest',
    tags: ['animation', 'flat', 'mp4']
  },
  {
    id: 'elephants-dream',
    title: 'Elephant’s Dream',
    subtitle: 'Open movie · 11 min',
    description: 'A public sample stream for regular video playback testing.',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    projection: 'flat',
    layout: 'mono',
    streamType: 'file',
    art: 'art-night',
    tags: ['science fiction', 'flat', 'mp4']
  },
  {
    id: 'vr360-mono-template',
    title: 'Add a 360° film',
    subtitle: 'Equirectangular · Mono',
    description: 'Paste a direct URL or select a local 360° equirectangular video.',
    projection: '360',
    layout: 'mono',
    art: 'art-ocean',
    tags: ['360', 'mono', 'immersive'],
    template: true
  },
  {
    id: 'vr180-sbs-template',
    title: 'Add a VR180 film',
    subtitle: 'Equirectangular · Side-by-side',
    description: 'Paste a direct URL or select a local VR180 side-by-side video.',
    projection: '180',
    layout: 'sbs',
    art: 'art-coral',
    tags: ['180', 'sbs', 'stereo', 'immersive'],
    template: true
  },
  {
    id: 'vr360-tb-template',
    title: 'Add a 360° stereo film',
    subtitle: 'Equirectangular · Top-bottom',
    description: 'Paste a direct URL or select a local top-bottom 360° video.',
    projection: '360',
    layout: 'tb',
    art: 'art-violet',
    tags: ['360', 'top-bottom', 'stereo', 'immersive'],
    template: true
  },
  {
    id: 'hls-template',
    title: 'Connect an HLS stream',
    subtitle: 'Adaptive stream · Any projection',
    description: 'Add an HTTPS .m3u8 manifest with CORS enabled.',
    projection: 'flat',
    layout: 'mono',
    streamType: 'hls',
    art: 'art-gold',
    tags: ['hls', 'adaptive', 'stream'],
    template: true
  },
  {
    id: 'dash-template',
    title: 'Connect a DASH stream',
    subtitle: 'Adaptive stream · Any projection',
    description: 'Add an HTTPS .mpd manifest with CORS enabled.',
    projection: 'flat',
    layout: 'mono',
    streamType: 'dash',
    art: 'art-mint',
    tags: ['dash', 'adaptive', 'stream'],
    template: true
  }
];

export const CATALOG_ROWS = [
  {
    id: 'featured',
    title: 'Featured now',
    subtitle: 'Start here, then connect your own media',
    filter: (item) => item.featured || ['bunny', 'elephants-dream'].includes(item.id)
  },
  {
    id: 'immersive',
    title: 'Immersive cinema',
    subtitle: '180° and 360° · mono and stereoscopic',
    filter: (item) => item.projection !== 'flat'
  },
  {
    id: 'flat',
    title: 'Regular video',
    subtitle: 'MP4, WebM, HLS, and MPEG-DASH',
    filter: (item) => item.projection === 'flat'
  },
  {
    id: 'library',
    title: 'My library',
    subtitle: 'Sources saved in this browser',
    filter: (item) => item.id.startsWith('user-') || item.local
  }
];
