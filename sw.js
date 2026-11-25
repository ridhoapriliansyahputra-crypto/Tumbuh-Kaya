/* Service worker - Tumbuh Kaya
 * Tujuan: aplikasi bisa dibuka & dipakai input OFFLINE (GitHub Pages / hosting https lain).
 * Data input tetap disimpan oleh aplikasi sendiri (localStorage/IndexedDB) dan disinkron saat online lagi.
 * Kalau kamu ubah index.html, naikkan angka VERSION di bawah supaya semua HP ambil versi baru.
 */
const VERSION = 'v1';
const CORE_CACHE = 'tk-core-' + VERSION;      // file aplikasi
const LIB_CACHE  = 'tk-lib-'  + VERSION;      // Firebase SDK + font Google

// File milik aplikasi (satu folder dengan sw.js). index.html WAJIB ada, sisanya opsional.
const CORE_REQUIRED = ['./index.html'];
const CORE_OPTIONAL = [
  './manifest.json',
  './icon-192.png', './icon-512.png',
  './icon-maskable-192.png', './icon-maskable-512.png'
];

// Library luar yang dipakai index.html — di-cache supaya aplikasi tetap jalan tanpa internet
const LIBS = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const core = await caches.open(CORE_CACHE);
    await core.addAll(CORE_REQUIRED.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    await Promise.all(CORE_OPTIONAL.map(function (u) { return core.add(u).catch(function () {}); }));

    // Skrip lintas-domain (opaque) tidak bisa pakai cache.add -> fetch lalu put
    const lib = await caches.open(LIB_CACHE);
    await Promise.all(LIBS.map(async function (u) {
      try {
        const res = await fetch(new Request(u, { mode: 'no-cors' }));
        await lib.put(u, res);
      } catch (e) { /* kalau gagal sekarang, nanti ke-cache otomatis saat dipakai online */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keep = [CORE_CACHE, LIB_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (k) { return k.indexOf('tk-') === 0 && keep.indexOf(k) < 0; })
                          .map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

// Ambil dari jaringan dulu (biar update cepat), kalau gagal/lama -> pakai cache
function networkFirst(request, cacheName, fallbackUrl, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const cachePromise = caches.open(cacheName);
    function useCache() {
      return cachePromise.then(function (c) {
        return c.match(request, { ignoreSearch: true }).then(function (r) {
          return r || (fallbackUrl ? c.match(fallbackUrl) : undefined);
        });
      });
    }
    const timer = setTimeout(function () {
      useCache().then(function (r) { if (r && !done) { done = true; resolve(r); } });
    }, timeoutMs);
    fetch(request).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) {
        const copy = res.clone();
        cachePromise.then(function (c) { c.put(request, copy); });
      }
      if (!done) { done = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      useCache().then(function (r) { if (!done) { done = true; resolve(r || Response.error()); } });
    });
  });
}

// Cache dulu, sambil diam-diam diperbarui di belakang (untuk library & font)
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      const update = fetch(request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || update;
    });
  });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POST/PATCH (sinkron Drive/Firestore) tidak disentuh
  const url = new URL(req.url);

  // 1) Halaman utama (dibuka / di-refresh)
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, CORE_CACHE, './index.html', 3500));
    return;
  }

  // 2) File aplikasi satu domain (index.html, manifest, ikon)
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, CORE_CACHE, null, 3500));
    return;
  }

  // 3) Firebase SDK + font Google
  if (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0) {
    event.respondWith(staleWhileRevalidate(req, LIB_CACHE));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, LIB_CACHE));
    return;
  }

  // 4) Selain itu (API Google Drive, Firestore, login) -> langsung internet, tidak di-cache
});
