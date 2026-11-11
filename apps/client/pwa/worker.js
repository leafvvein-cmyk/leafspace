/* Build substitutes these literals. This file is not served from public/. */
const FILES = __PRECACHE_JSON__;
const BUILD = __BUILD_JSON__;
const PREFIX = 'diary-shell-v1:';
const CACHE = PREFIX + BUILD;
// Stored inside this build's cache, never exposed by the fetch allowlist.
const PREDECESSORS = '/__diary_cache_predecessors__';
const ALLOWED = new Set(FILES);
const route = (path) => /^\/(?:today|timeline|calendar|search|tags(?:\/view)?|trash|sync|conflicts\/[a-f0-9-]+|login|register|recover|onboarding\/recovery|settings(?:\/(?:account|devices|about|reminders|privacy|exports|migrate|images|storage))?|entries\/(?:new|[a-f0-9-]+)(?:\/edit)?)?\/?$/.test(path);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const predecessors = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE);
      const cache = await caches.open(CACHE);
      await cache.addAll(FILES.map((path) => new Request(path, { credentials: 'omit', cache: 'reload' })));
      await cache.put(PREDECESSORS, new Response(JSON.stringify(predecessors), { headers: { 'Content-Type': 'application/json' } }));
    } catch (error) { await caches.delete(CACHE); throw error; }
    // Do not skip waiting on install: active editors keep their version.
  })());
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || request.headers.has('Authorization')) return;
  if (request.mode === 'navigate' && route(url.pathname)) {
    event.respondWith((async () => (await caches.open(CACHE)).match('/index.html').then((response) => response || fetch(request)))());
    return;
  }
  if (url.search || (!ALLOWED.has(url.pathname) && !/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2?)$/.test(url.pathname))) return;
  event.respondWith((async () => {
    // Vite preview/CDNs may add `Vary: Origin` to same-origin modules. These
    // paths are immutable build-owned files from our explicit allowlist, so
    // match by pathname rather than letting a request-header variation turn a
    // successfully precached build into a blank offline page.
    const current = await (await caches.open(CACHE)).match(url.pathname, { ignoreVary: true });
    if (current) return current;
    // A tab racing activation may still import its old content-hashed chunks.
    for (const name of await caches.keys()) if (name.startsWith(PREFIX)) {
      const previous = await (await caches.open(name)).match(url.pathname, { ignoreVary: true });
      if (previous) return previous;
    }
    return fetch(request); // No runtime cache writes, including errors/redirects.
  })());
});

async function windows() { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); }
async function cleanUnused() {
  // Only consider caches that predate this installation. An older worker must
  // never remove resources just downloaded by a newer waiting worker.
  let predecessors;
  try { predecessors = await (await (await caches.open(CACHE)).match(PREDECESSORS))?.json(); }
  catch { return; }
  if (!Array.isArray(predecessors) || predecessors.some((name) => typeof name !== 'string' || !name.startsWith(PREFIX))) return;
  const clients = await windows();
  const versions = await Promise.all(clients.map((client) => new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 1500);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data?.buildId); };
    client.postMessage({ type: 'DIARY_BUILD_QUERY' }, [channel.port2]);
  })));
  // Unknown/starting tabs prevent cleanup. Never delete another app's caches.
  if (versions.some((id) => typeof id !== 'string' || !/^[a-z0-9-]{6,80}$/.test(id))) return;
  const keep = new Set([CACHE, ...versions.map((id) => PREFIX + id)]);
  for (const name of predecessors) if (!keep.has(name)) await caches.delete(name);
}
self.addEventListener('message', (event) => {
  if (event.data?.type === 'DIARY_CLEAN_BUILDS') { event.waitUntil(cleanUnused()); return; }
  if (event.data?.type !== 'DIARY_ACTIVATE_UPDATE' || !event.ports[0]) return;
  event.waitUntil((async () => {
    const clients = await windows();
    if (clients.length !== 1 || clients[0].id !== event.source?.id) {
      event.ports[0].postMessage({ ok: false, message: '请先关闭其他日记窗口，再保存并更新。' }); return;
    }
    event.ports[0].postMessage({ ok: true });
    await self.skipWaiting();
  })());
});
