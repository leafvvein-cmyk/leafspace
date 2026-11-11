import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const prefix = 'diary-shell-v1:';
const source = readFileSync(new URL('../../apps/client/pwa/worker.js', import.meta.url), 'utf8');
function harness({ build = 'build-new', windows = [], failInstall = false } = {}) {
  const handlers = new Map(), stores = new Map();
  const key = (value) => new URL(typeof value === 'string' ? value : value.url, 'https://diary.test').href;
  const caches = {
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name) => stores.delete(name)),
    open: vi.fn(async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const values = stores.get(name);
      return {
        match: async (request) => values.get(key(request))?.clone(),
        put: async (request, response) => values.set(key(request), response.clone()),
        addAll: vi.fn(async (requests) => {
          expect(requests.every((request) => request.credentials === 'omit')).toBe(true);
          if (failInstall) throw new Error('download failed');
          for (const request of requests) values.set(key(request), new Response(`asset:${new URL(request.url).pathname}`));
        }),
      };
    }),
  };
  const self = {
    location: { origin: 'https://diary.test' },
    addEventListener: (name, handler) => handlers.set(name, handler),
    clients: { matchAll: vi.fn(async () => windows), claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(async () => {}),
  };
  const fetch = vi.fn(async () => new Response('network'));
  class RelativeRequest extends Request {
    constructor(path, options) { super(new URL(path, self.location.origin), options); }
  }
  class Channel {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      this.port2 = { postMessage: (data) => this.port1.onmessage?.({ data }) };
    }
  }
  runInNewContext(source.replace('__PRECACHE_JSON__', JSON.stringify(['/index.html', '/assets/app-new.js']))
    .replace('__BUILD_JSON__', JSON.stringify(build)), {
    self, caches, fetch, URL, Request: RelativeRequest, Response, MessageChannel: Channel, setTimeout, clearTimeout,
  });
  const dispatch = async (type, props = {}) => {
    let result;
    handlers.get(type)({ ...props, waitUntil: (promise) => { result = promise; }, respondWith: (promise) => { result = promise; } });
    return result;
  };
  const request = (path, { mode = 'cors', method = 'GET', headers = {} } = {}) => ({
    url: new URL(path, self.location.origin).href, mode, method, headers: new Headers(headers),
  });
  const seed = async (name, path = '/index.html', body = name) => (await caches.open(name)).put(path, new Response(body));
  return { dispatch, request, seed, stores, caches, self, fetch };
}
afterEach(() => vi.useRealTimers());
const tab = (id, buildId) => ({ id, postMessage: (_data, ports) => ports[0].postMessage({ buildId }) });

describe('production service worker policy', () => {
  it('precache failure removes only the candidate build and never activates it', async () => {
    const h = harness({ failInstall: true });
    await h.seed(prefix + 'build-old'); await h.seed('unrelated');
    await expect(h.dispatch('install')).rejects.toThrow('download failed');
    expect([...h.stores.keys()]).toEqual([prefix + 'build-old', 'unrelated']);
    expect(h.self.skipWaiting).not.toHaveBeenCalled();
  });
  it.each([
    ['/api/v1/entries', {}], ['/api/v1/auth/login', { method: 'POST' }],
    ['/assets/app-new.js', { headers: { Authorization: 'Bearer secret' } }],
    ['https://other.test/assets/app-new.js', {}], ['/uploads/private.jpg', {}],
    ['/assets/app-new.js?token=secret', {}], ['/unknown', { mode: 'navigate' }],
  ])('does not intercept private or unsupported request %s', async (path, options) => {
    const h = harness();
    expect(await h.dispatch('fetch', { request: h.request(path, options) })).toBeUndefined();
    expect(h.caches.open).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('serves known routes offline from the static shell without fetching diary data', async () => {
    const h = harness(); await h.dispatch('install');
    const result = await h.dispatch('fetch', { request: h.request('/entries/abc-def/edit', { mode: 'navigate' }) });
    expect(await result.text()).toBe('asset:/index.html');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('keeps old hashed chunks readable but does not cache network misses', async () => {
    const h = harness(); await h.seed(prefix + 'build-old', '/assets/old.js', 'old chunk');
    await h.dispatch('install');
    expect(await (await h.dispatch('fetch', { request: h.request('/assets/old.js') })).text()).toBe('old chunk');
    expect(await (await h.dispatch('fetch', { request: h.request('/assets/missing.js') })).text()).toBe('network');
    expect(h.stores.get(prefix + 'build-new').has('https://diary.test/assets/missing.js')).toBe(false);
  });
  it.each([[[], 'one', false], [[tab('one', 'build-old'), tab('two', 'build-old')], 'one', false], [[tab('one', 'build-old')], 'other', false], [[tab('one', 'build-old')], 'one', true]])(
    'activates only for the sole requesting window (%j)', async (windows, sender, allowed) => {
      const h = harness({ windows }); const postMessage = vi.fn();
      await h.dispatch('message', { data: { type: 'DIARY_ACTIVATE_UPDATE' }, source: { id: sender }, ports: [{ postMessage }] });
      expect(postMessage.mock.calls[0][0].ok).toBe(allowed);
      expect(h.self.skipWaiting).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });
  it('garbage collection preserves a newer waiting build and unrelated caches', async () => {
    const h = harness({ windows: [tab('one', 'build-new')] });
    await h.seed(prefix + 'build-old'); await h.seed('unrelated');
    await h.dispatch('install');
    // Another version can finish downloading before this worker receives cleanup.
    await h.seed(prefix + 'build-waiting');
    await h.dispatch('message', { data: { type: 'DIARY_CLEAN_BUILDS' } });
    expect([...h.stores.keys()].sort()).toEqual([prefix + 'build-new', prefix + 'build-waiting', 'unrelated'].sort());
  });
  it('preserves predecessor caches still used by another window', async () => {
    const h = harness({ windows: [tab('one', 'build-old')] });
    await h.seed(prefix + 'build-old'); await h.dispatch('install');
    await h.dispatch('message', { data: { type: 'DIARY_CLEAN_BUILDS' } });
    expect(h.stores.has(prefix + 'build-old')).toBe(true);
  });
  it('does not clean caches when a starting window has not reported a version', async () => {
    vi.useFakeTimers(); const h = harness({ windows: [{ id: 'one', postMessage() {} }] });
    await h.seed(prefix + 'build-old'); await h.dispatch('install');
    const run = h.dispatch('message', { data: { type: 'DIARY_CLEAN_BUILDS' } });
    await vi.advanceTimersByTimeAsync(1500); await run;
    expect(h.stores.has(prefix + 'build-old')).toBe(true);
  });
});
