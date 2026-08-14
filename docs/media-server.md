# Media-server requirements

Immersive streaming is only as reliable as the media origin. A video may play in a native `<video>` element yet fail as a WebGL texture or in a native VR player if headers are incomplete.

## Recommended HTTP behavior

For widest browser and native-player compatibility, let a direct MP4/WebM source answer metadata probes such as `HEAD`:

```http
HEAD /media/Example_180_LR.mp4 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: 123456789
Accept-Ranges: bytes
Access-Control-Allow-Origin: https://your-projectavr.example
```

Playback itself depends on ranged `GET`, so this behavior is essential even when a particular player never sends `HEAD`:

```http
GET /media/Example_180_LR.mp4 HTTP/1.1
Range: bytes=1048576-2097151

HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Length: 1048576
Content-Range: bytes 1048576-2097151/123456789
Accept-Ranges: bytes
Access-Control-Allow-Origin: https://your-projectavr.example
```

Use `Access-Control-Allow-Origin: *` only for intentionally public, credential-free media. If credentials are required, return the exact approved origin, add `Vary: Origin`, and design authentication separately. Do not put reusable secrets in query strings saved to a browser catalog.

HLS and DASH require CORS on the manifest and every referenced playlist, segment, key, subtitle, and initialization object.

## Application-host security headers

The ProjectAVR HTML, JavaScript, manifest, and service worker should be served with production security headers. These are application-host controls; configure the media origin separately using the CORS and Range guidance above.

The following baseline supports the current pinned jsDelivr modules, user-entered HTTPS media, HLS/DASH fetches, blob-backed local files, WebXR, fullscreen, and the hls.js worker:

```http
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob:; media-src 'self' https: blob:; connect-src 'self' https:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), fullscreen=(self), xr-spatial-tracking=(self)
```

Narrow `connect-src` and `media-src` when users cannot add arbitrary origins, and self-host the pinned JavaScript modules if the deployment needs `script-src 'self'` or deterministic offline startup. Test the policy in report-only mode before enforcing it.

GitHub Pages on GitHub.com does not offer per-repository custom response headers. A CSP meta element can cover many fetch directives, but not `frame-ancestors`, and it cannot provide the other headers. Use a configurable CDN/reverse proxy or a static host with response-header support when those controls are required. GitHub Enterprise Server administrators can configure Pages headers at the instance level.

## Nginx starting point

```nginx
location /media/ {
    add_header Access-Control-Allow-Origin "https://your-projectavr.example" always;
    add_header Access-Control-Expose-Headers "Accept-Ranges, Content-Length, Content-Range" always;
    add_header X-Content-Type-Options "nosniff" always;
    types {
        video/mp4 mp4 m4v;
        video/webm webm;
        application/vnd.apple.mpegurl m3u8;
        application/dash+xml mpd;
        text/vtt vtt;
    }
}
```

Nginx serves static-file ranges by default. Confirm the CDN, object store, reverse proxy, and authentication layer preserve `Range` and `206` rather than assuming the origin setting survives the full path.

## Conservative transcode fallback

Keep the original master. A broadly compatible SDR fallback can be prepared with FFmpeg:

```bash
ffmpeg -i input.mov \
  -map 0:v:0 -map 0:a:0? \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -level 5.2 \
  -crf 18 -preset slow \
  -c:a aac -b:a 192k -ac 2 \
  -movflags +faststart \
  output_180_LR.mp4
```

Choose a level, frame size, frame rate, and bitrate supported by the actual headset matrix. The example does not mean every device can decode every resolution at H.264 level 5.2. Do not resize an immersive master without preserving its projection and stereo packing.

## Spherical metadata

Some native players use filenames or manual settings; others inspect spherical MP4 metadata. ProjectAVR keeps projection explicit in its catalog but does not rewrite the media container. Inject standardized spherical metadata during your packaging pipeline when target players require it, and verify the result on-device.

## Production checklist

- [ ] HTTPS certificate trusted by the headset
- [ ] Stable absolute media URL
- [ ] Correct MIME type and `X-Content-Type-Options: nosniff`
- [ ] `Range`, `206`, `Content-Length`, and `Content-Range`; `HEAD` if the target player or delivery layer probes it
- [ ] CORS on video, manifests, segments, keys, and subtitles
- [ ] Fast-start MP4
- [ ] Explicit ProjectAVR projection and stereo values
- [ ] Conservative H.264/AAC fallback rendition
- [ ] No browser-only DRM assumed to work in native players
- [ ] Tested seeking, pause/resume, eye order, horizon, and audio on each target device
