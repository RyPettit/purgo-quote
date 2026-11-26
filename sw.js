// Purgō Portal service worker: lets the app open and quote with no signal.
// Network first, cache as fallback, so a new release is picked up straight away
// and the last good copy is used when there is no signal.
const VERSION = 'purgo-92446eaf3c';
const SHELL = ['./', 'index.html', 'purgo.css?v=92b4145f25', 'purgo.js?v=62c6d20d7c', 'measure.js?v=f88bc2a42d', 'portfolio.js?v=704c4911e9', 'portal.js?v=4afff4439d', 'accounts.js?v=e22525f38e', 'mail.js?v=d92cda6caf', 'jobs.js?v=4240977ba5', 'invoices.js?v=d29fb10d35', 'reminders.js?v=9c63bead13', 'home.js?v=28795eee1f', 'today.js?v=c2c82dfe9e', 'config.js', 'vendor/supabase-2.117.3.js',
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
  if (req.mode === 'navigate' && !/\/(index\.html)?$/.test(url.pathname)) return; // other pages (e.g. a customer's quote link) aren't the app
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(
    fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key).then(hit => hit || caches.match(req, {ignoreSearch: true})))
  );
});
