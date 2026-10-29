// 离线缓存（network-first，优先取最新代码）
const CACHE = 'tp01-simple-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/native-bridge.js',
  './js/app.js',
  './js/midi-codec.js',
  './js/tp01.js',
  './js/firmware.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() =>
      caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
    )
  );
});
