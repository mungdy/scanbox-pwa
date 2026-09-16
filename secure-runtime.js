(function (global) {
  'use strict';

  const VERSION = '1.1.3';
  const RUNTIME_CACHE = `scanbox-runtime-v${VERSION}`;
  const PIN_PREFIX = `scanbox.vendor-pin.v${VERSION}.`;
  const MAX_ASSET_BYTES = 32 * 1024 * 1024;
  const ALLOWED_HOSTS = new Set(['cdn.jsdelivr.net']);
  const sessionPins = new Map();
  const verified = new Set();
  let storagePersistent = true;

  function validateRemoteUrl(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
      throw new Error('허용되지 않은 외부 엔진 주소입니다.');
    }
    return u;
  }

  function virtualUrl(path) {
    const clean = String(path || '').replace(/^\/+/, '');
    return new URL(`./__runtime/v${VERSION}/${clean}`, location.href).href;
  }

  async function sha256Hex(bytes) {
    if (!global.crypto?.subtle) throw new Error('이 브라우저에서는 SHA-256 무결성 검증을 사용할 수 없습니다.');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = new Uint8Array(await global.crypto.subtle.digest('SHA-256', data));
    return [...digest].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function readPin(name) {
    try {
      const raw = localStorage.getItem(PIN_PREFIX + name);
      if (raw) return JSON.parse(raw);
    } catch {
      storagePersistent = false;
    }
    return sessionPins.get(name) || null;
  }

  function writePin(name, record) {
    sessionPins.set(name, record);
    try {
      localStorage.setItem(PIN_PREFIX + name, JSON.stringify(record));
    } catch {
      storagePersistent = false;
    }
  }

  async function ensureServiceWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('보안 런타임 캐시는 Service Worker가 필요합니다.');
    if (!(location.protocol === 'https:' || location.hostname === 'localhost')) {
      throw new Error('보안 런타임은 HTTPS에서만 사용할 수 있습니다.');
    }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Service Worker가 현재 화면을 아직 제어하지 않습니다. 앱을 한 번 다시 열어 주세요.')), 4000);
        const done = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); };
        navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      });
    }
  }

  async function getCachedVirtual(path) {
    await ensureServiceWorker();
    const req = new Request(virtualUrl(path), { credentials: 'same-origin' });
    const cache = await caches.open(RUNTIME_CACHE);
    const res = await cache.match(req);
    if (!res) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, response: res };
  }

  async function storeVirtual(path, bytes, contentType, metadata) {
    await ensureServiceWorker();
    const cache = await caches.open(RUNTIME_CACHE);
    const headers = new Headers({
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-ScanBox-SHA256': metadata.hash,
      'X-ScanBox-Source': metadata.source,
      'X-Content-Type-Options': 'nosniff'
    });
    await cache.put(new Request(virtualUrl(path)), new Response(bytes.slice(), { status: 200, headers }));
  }

  async function fetchRemoteBytes(remoteUrl, onProgress) {
    validateRemoteUrl(remoteUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(remoteUrl, {
        mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow',
        referrerPolicy: 'no-referrer', signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`외부 엔진 다운로드 실패 (HTTP ${res.status})`);
      // redirect 최종 목적지도 동일한 allowlist/HTTPS 규칙을 통과해야 합니다.
      validateRemoteUrl(res.url || remoteUrl);
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
        throw new Error('외부 엔진 응답이 실행 파일이 아니라 HTML입니다. 다운로드를 중단했습니다.');
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_ASSET_BYTES) throw new Error('외부 엔진 파일이 허용 크기를 초과했습니다.');

      if (!res.body?.getReader) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_ASSET_BYTES) throw new Error('외부 엔진 파일이 허용 크기를 초과했습니다.');
        onProgress?.(1);
        return bytes;
      }

      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_ASSET_BYTES) { try { await reader.cancel(); } catch {} throw new Error('외부 엔진 파일이 허용 크기를 초과했습니다.'); }
          chunks.push(value);
          if (declared) onProgress?.(Math.min(1, total / declared));
        }
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      onProgress?.(1);
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureAsset({ name, remoteUrl, virtualPath, contentType, onProgress }) {
    if (!name || !remoteUrl || !virtualPath) throw new Error('보안 런타임 자산 정의가 잘못되었습니다.');
    const source = validateRemoteUrl(remoteUrl).href;
    const key = `${name}|${source}|${virtualPath}`;
    const pin = readPin(name);

    const cached = await getCachedVirtual(virtualPath);
    if (cached) {
      const bytes = cached.bytes;
      const headerHash = cached.response.headers.get('X-ScanBox-SHA256') || '';
      let hash = headerHash;
      if (!verified.has(key) || !hash) hash = await sha256Hex(bytes);
      if (pin && (pin.source !== source || pin.sha256 !== hash)) {
        const cache = await caches.open(RUNTIME_CACHE);
        await cache.delete(new Request(virtualUrl(virtualPath)));
      } else {
        if (!pin) writePin(name, { source, sha256: hash });
        verified.add(key);
        onProgress?.(1);
        return { url: virtualUrl(virtualPath), sha256: hash, bytes, cached: true };
      }
    }

    const bytes = await fetchRemoteBytes(source, onProgress);
    const hash = await sha256Hex(bytes);
    const current = readPin(name);
    if (current && (current.source !== source || current.sha256 !== hash)) {
      throw new Error(`보안 검사 실패: ${name} 엔진 파일이 이전에 잠근 SHA-256과 다릅니다. 실행을 중단했습니다.`);
    }
    if (!current) writePin(name, { source, sha256: hash });
    await storeVirtual(virtualPath, bytes, contentType, { hash, source });
    verified.add(key);
    return { url: virtualUrl(virtualPath), sha256: hash, bytes, cached: false };
  }

  async function loadScript(asset) {
    const result = await ensureAsset(asset);
    if (asset.globalCheck?.()) return result;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = result.url;
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`${asset.name} 실행 파일을 불러오지 못했습니다.`));
      document.head.appendChild(script);
    });
    if (asset.globalCheck && !asset.globalCheck()) throw new Error(`${asset.name} 초기화에 실패했습니다.`);
    return result;
  }

  async function loadModule(asset) {
    const result = await ensureAsset({ ...asset, contentType: asset.contentType || 'text/javascript; charset=utf-8' });
    const mod = await import(result.url);
    return { ...result, module: mod };
  }

  async function warmAssets(assets, onProgress) {
    const list = assets || [];
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const base = i / Math.max(1, list.length);
      const span = 1 / Math.max(1, list.length);
      const result = await ensureAsset({ ...item, onProgress: p => onProgress?.(base + span * (p || 0), item) });
      results.push(result);
      onProgress?.(base + span, item);
    }
    return results;
  }

  async function clearRuntimeCache() {
    await caches.delete(RUNTIME_CACHE);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PIN_PREFIX)) localStorage.removeItem(key);
    }
    sessionPins.clear();
    verified.clear();
  }

  function status() {
    let pinCount = sessionPins.size;
    try {
      pinCount = 0;
      for (let i = 0; i < localStorage.length; i++) {
        if (localStorage.key(i)?.startsWith(PIN_PREFIX)) pinCount++;
      }
    } catch { storagePersistent = false; }
    return { version: VERSION, cacheName: RUNTIME_CACHE, persistentPins: storagePersistent, pinCount };
  }

  global.ScanBoxRuntime = Object.freeze({
    version: VERSION, runtimeCache: RUNTIME_CACHE, virtualUrl, ensureAsset, loadScript, loadModule,
    warmAssets, clearRuntimeCache, status, sha256Hex
  });
})(typeof window !== 'undefined' ? window : globalThis);
