/* Service Worker：应用壳离线缓存 + 地图瓦片有限缓存
 * 发版说明：每次发布新版本必须将 VERSION 递增（如 tf-v2 -> tf-v3），
 * 已安装用户启动时检测到 sw.js 变化即自动更新到新版本。 */
const VERSION = 'tf-v12';
const PRECACHE = [
  './',
  'index.html',
  'css/style.css',
  'js/pois.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'
];
const TILE_CACHE = 'tf-tiles-v1';
const MAX_TILES = 400;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION && k !== TILE_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 接收客户端"清除缓存并刷新"指令
self.addEventListener('message', function (e) {
  if (e.data === 'clear-and-reload') {
    e.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).then(function () {
        return self.skipWaiting();
      }).then(function () {
        // 通知所有客户端刷新
        return self.clients.matchAll({ includeUncontrolled: true });
      }).then(function (clients) {
        clients.forEach(function (c) { c.postMessage('reload'); });
      })
    );
  }
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(tileFetch(e.request));
    return;
  }

  // version.json 始终走网络，不经过缓存
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('version.json')) {
    e.respondWith(
      fetch(e.request).catch(function () { return new Response('{}', { status: 503 }); })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res && res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, clone); });
        }
        return res;
      }).catch(function () {
        // 离线时导航回退到应用壳
        if (e.request.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});

async function tileFetch(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const keys = await cache.keys();
      if (keys.length >= MAX_TILES) await cache.delete(keys[0]);
      await cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'No network' });
  }
}
