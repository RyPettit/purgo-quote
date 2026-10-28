// Purgō Quote service worker: lets the app open and quote with no signal.
// Network first, cache as fallback, so a new release is picked up straight away
// and the last good copy is used when there is no signal.
const VERSION = 'purgo-8f59eae456';
const SHELL = ['./', 'index.html', 'purgo.css?v=0711ec938f', 'purgo.js?v=51384a5a59', 'measure.js?v=c136250162', 'config.js', 'vendor/supabase-2.117.3.js',
  'postcodes.json', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
  'icons/apple-touch-icon.png', 'fonts/plus-jakarta-sans.woff2', 'brand/emblem-light.png', 'brand/wordmark-light.png',
  'brand/logo-navy.png', 'brand/logo-light.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // database calls go straight to the network
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(
    fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key).then(hit => hit || caches.match(req, {ignoreSearch: true})))
  );
});
