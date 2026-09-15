/* ═══════════════════════════════════════════
   IMPOSTOR GAME — Service worker

   This exists so the page is installable as a PWA. The game itself is live
   Socket.IO and cannot work offline; the cache is only a shell so a cold
   launch on a flaky connection still paints the login screen.

   Two things this file must never intercept:
     /socket.io/  — polling fallback is HTTP. Caching or failing it looks
                    like "Unable to reconnect" to every player on a phone.
     /qr/         — per-room, Host-dependent. A cached code from a previous
                    origin would send joiners to the wrong place.

   Bump CACHE when you want installed clients to drop a stale shell. The
   page also network-fetches JS first, and handleStaleClient() in app.js
   unregisters this worker if PROTOCOL moves.
   ═══════════════════════════════════════════ */

const CACHE = 'impostor-shell-v1';

const PRECACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function shouldBypass(url) {
    return url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/qr/');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch { return; }
    if (url.origin !== self.location.origin) return;
    if (shouldBypass(url)) return;

    event.respondWith((async () => {
        try {
            const fresh = await fetch(req);
            if (fresh && fresh.ok) {
                const cache = await caches.open(CACHE);
                cache.put(req, fresh.clone());
            }
            return fresh;
        } catch {
            const cached = await caches.match(req);
            if (cached) return cached;
            if (req.mode === 'navigate') {
                const shell = await caches.match('/index.html');
                if (shell) return shell;
            }
            throw new Error('offline');
        }
    })());
});
