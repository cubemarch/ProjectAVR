# ProjectAVR — working notes

Two tiers in this repository: transcode and packaging on a server, dual delivery
over a WebSocket relay and HLS. `server/` and `src/` are Node and browser
JavaScript. There is no native code here.

## The capture app is not in this repository

Contribution encode happens in **VRecord**, an iPhone app that now lives and
ships on its own, in its own repository, with its own brief, audit, test plan
and App Store submission pack. It was split out because it is a content-neutral
professional camera tool that stands as a product by itself, and keeping it here
tied its App Store position to this one's.

What that means when working here:

- **Do not add anything to this repository that assumes the iPhone app.** The
  ingest end must work for any client that speaks the protocol; the app is one
  such client, not a required component.
- **The wire protocol is now a contract across a repository boundary.** A change
  to framing, the handshake, track types, discovery or the `avr://` pairing URL
  is a breaking change for a codebase that is not in this tree and will not fail
  this build. [`docs/LIVE.md`](docs/LIVE.md) is the shared specification; treat
  it as the interface, and version anything incompatible.
- Nothing here imports the app and nothing in the app imports this. Keep it
  that way.

## Building and testing

```sh
npm test                                   # server and web, node --test
```

## Other docs

| | |
| --- | --- |
| [`docs/LIVE.md`](docs/LIVE.md) | The live pipeline end to end, including the ingest protocol the capture app speaks |
| [`docs/DELIVERY.md`](docs/DELIVERY.md) | The bitrate ladder, the burned-in watermark, and which renditions each headset is offered |
| [`docs/IDENTITY.md`](docs/IDENTITY.md) | Age assurance, creator enrolment, the portal face check, and how the pasteable destination URL is issued |
| [`docs/STATE-AGE-LAWS.md`](docs/STATE-AGE-LAWS.md) | The twenty-seven states that require a verified adult, the button everywhere else, how a request's state is resolved, and the signed-out gate that needs no account |
| [`docs/CENSOR.md`](docs/CENSOR.md) | Pixelating partner artwork for visitors who have not verified, the jurisdiction split, and why every failure covers more rather than less |
| [`docs/MONETISATION.md`](docs/MONETISATION.md) | Credits and the ledger, creator pricing, profiles, the stream setup checks and the 3D gate |
| [`docs/EMAIL.md`](docs/EMAIL.md) | What the server sends, the three categories, the marketing opt-in and the delivery log |
| [`docs/COMIC.md`](docs/COMIC.md) | Lusty X: how a strip publishes itself from its date and its art, where it appears, and the season's canon calls and real-figure rules |
| [`docs/SEARCH.md`](docs/SEARCH.md) | The declarations, the crawlable fallback, the sitemap and policy pages, and why paid search is closed to this domain |
