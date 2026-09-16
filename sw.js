'use strict';
const VERSION = '1.1.6';
const APP_CACHE = `scanbox-app-v${VERSION}`;
const RUNTIME_CACHE = `scanbox-runtime-v${VERSION}`;
const APP_SHELL = [
  './','./index.html','./theme-init.js','./styles.css','./app.js','./secure-runtime.js','./pdf-engine.js',
  './vendor/jszip/jszip.min.js','./manifest.webmanifest',
  './icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(APP_CACHE).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('scanbox-') && ![APP_CACHE, RUNTIME_CACHE].includes(k))
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 제3자 요청은 Service Worker가 가로채거나 캐시하지 않습니다.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res?.ok) (await caches.open(APP_CACHE)).put('./index.html', res.clone()).catch(() => {});
        return res;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res?.ok && !url.pathname.includes('/__runtime/')) {
      (await caches.open(APP_CACHE)).put(req, res.clone()).catch(() => {});
    }
    return res;
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'PREPARE_OFFLINE') return;
  event.waitUntil(prepareAppShell());
});

async function prepareAppShell() {
  const cache = await caches.open(APP_CACHE);
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  const post = data => clients.forEach(c => c.postMessage(data));
  const failures = [];

  for (let i = 0; i < APP_SHELL.length; i++) {
    const url = APP_SHELL[i];
    try {
      const res = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await cache.put(url, res.clone());
    } catch (err) {
      failures.push(url);
      console.warn('App shell cache failed:', url, err);
    }
    post({ type: 'OFFLINE_PROGRESS', percent: Math.round(((i + 1) / APP_SHELL.length) * 18), label: `앱 파일 ${i + 1} / ${APP_SHELL.length}` });
  }
  post({ type: 'OFFLINE_DONE', failures: failures.length });
}
