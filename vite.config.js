import { resolve } from 'node:path';

import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * In production the Express server maps `/live` and `/live/:id` onto
 * `live.html`. Vite's dev server only knows about the file, so without this the
 * monitor 404s on reload as soon as it has rewritten the URL to `/live/A1B2C3`.
 */
function liveMonitorRoutes() {
    return {
        name: 'avr-live-routes',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (/^\/live(\/[0-9A-Za-z]*)?$/.test(req.url.split('?')[0])) {
                    req.url = '/live.html';
                }
                next();
            });
        }
    };
}

/**
 * WebXR requires a secure context. `localhost` counts, but a headset on the
 * same LAN reaches this machine by IP - which does not - so dev serves over
 * HTTPS with a self-signed certificate. Accept the browser warning once on the
 * headset and `navigator.xr` becomes available.
 */
export default defineConfig({
    plugins: [basicSsl(), liveMonitorRoutes()],
    server: {
        host: true,
        port: 5173,
        proxy: {
            // The compatibility server owns the catalog API, the DeoVR feed and
            // media byte-range serving; Vite only handles the app bundle.
            '/api': 'http://localhost:8080',
            '/art': 'http://localhost:8080',
            '/deovr': 'http://localhost:8080',
            '/dlna': 'http://localhost:8080',
            '/media': 'http://localhost:8080',
            '/playlist.m3u': 'http://localhost:8080',

            // The live relay. Only the `/live/ws/` prefix is proxied - `/live`
            // itself is the monitor page and is served by Vite above.
            '/live/ws': { target: 'ws://localhost:8080', ws: true }
        }
    },
    build: {
        target: 'es2020',
        outDir: 'dist',
        sourcemap: true,
        // The talkback AudioWorklet is small enough that Vite would inline it
        // as a `data:text/javascript` URL, and `audioWorklet.addModule()` on a
        // data URL is refused outright by some browsers and by any reasonable
        // script CSP. It has to stay a file that is fetched.
        assetsInlineLimit: (filePath) => (filePath.endsWith('-worklet.js') ? false : undefined),
        rollupOptions: {
            // Two documents: the browse/playback SPA, and the live monitor.
            // Keeping them separate means a viewer watching a broadcast never
            // downloads PlayCanvas or the creator portal.
            input: {
                main: resolve(import.meta.dirname, 'index.html'),
                live: resolve(import.meta.dirname, 'live.html')
            },
            output: {
                // The engine is large and changes far less often than app code,
                // so it gets its own long-lived chunk.
                manualChunks(id) {
                    if (id.includes('node_modules/playcanvas')) return 'playcanvas';
                    if (id.includes('node_modules/hls.js')) return 'hls';
                    return undefined;
                }
            }
        }
    }
});
