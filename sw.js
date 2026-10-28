// Purgō Quote service worker: lets the app open and quote with no signal.
// Bump VERSION whenever app files change so phones pick up the update.
const VERSION = 'purgo-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'vendor/supabase-2.117.3.js',
  'postcodes.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
  'icons/apple-touch-icon.png', 'fonts/plus-jakarta-sans.woff2', 'brand/emblem-light.png', 'brand/wordmark-light.png',
  'brand/logo-navy.png', 'brand/logo-light.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // database calls go straight to the network
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { caches.open(VERSION).then(c => c.put('index.html', r.clone())); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, {ignoreSearch: true});
    const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
