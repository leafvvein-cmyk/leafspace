import { describe, it, expect, vi } from 'vitest';
import { createAuthClient, validateCredentials, apiBase } from '../../apps/client/src/services/auth-client.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const credentials = (username = 'alice') => ({ username, password: 'a very long password', confirmation: 'a very long password' });
const session = (id = A) => ({ user: { id, username: id === A ? 'alice' : 'bravo', displayName: '', revision: '1' }, session: { id: crypto.randomUUID() }, accessToken: `token.${id}`, accessExpiresAt: new Date(Date.now() + 900000).toISOString(), refreshToken: 'a'.repeat(43) });
const response = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(status >= 400 ? { error: data } : { data }), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function harness({ native = false, shared, secrets } = {}) {
  const values = shared?.values ?? new Map();
  const metadata = { getSetting: async (key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback), setSetting: async (key, value) => { values.set(key, structuredClone(value)); } };
  let queue = Promise.resolve(), cookieUser = A, handler;
  const locks = shared?.locks ?? { request: (_name, task) => { const run = queue.catch(() => {}).then(task); queue = run; return run; } };
  const invalidated = vi.fn();
  const secretStore = secrets ?? { read: vi.fn(async () => null), write: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
  const calls = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    calls.push({ path, ...options });
    if (handler) { const result = await handler(path, options); if (result !== undefined) return result; }
    if (path === '/auth/csrf') return response({ csrfToken: 'safe.ascii' });
    if (path.endsWith('/login') || path.endsWith('/register')) {
      cookieUser = JSON.parse(options.body).username === 'bravo' ? B : A;
      return response(session(cookieUser));
    }
    if (path.endsWith('/refresh')) return response(session(cookieUser));
    if (path === '/auth/logout') return response(null, 204);
    if (path === '/me') return response({ ...session(options.headers.get('Authorization').includes(B) ? B : A).user, ...JSON.parse(options.body ?? '{}') });
    return response({ ok: true });
  };
  const client = createAuthClient({ baseUrl: 'https://diary.test/api/v1', native, platform: native ? 'android' : 'web', metadata, secrets: secretStore, locks, fetcher, onInvalidated: invalidated });
  return { client, values, metadata, locks, calls, invalidated, secretStore, handle: (value) => { handler = value; } };
}

describe('account credentials and transport', () => {
  it('normalizes the username but never trims a password or adds OTP fields', () => {
    expect(validateCredentials({ username: ' Alice ', password: ' 密码 ' })).toEqual({ username: 'alice', password: ' 密码 ' });
    expect(() => validateCredentials({ ...credentials(), confirmation: 'different' }, { register: true })).toThrow();
    expect(() => validateCredentials({ ...credentials(), username: '中文' })).toThrow();
  });
  it('enforces same-origin Web and HTTPS-only native API configuration', () => {
    expect(apiBase({ native: false, origin: 'https://diary.test' })).toBe('https://diary.test/api/v1');
    expect(() => apiBase({ native: false, configured: 'https://other.test', origin: 'https://diary.test' })).toThrow();
    expect(() => apiBase({ native: true, configured: 'http://example.test' })).toThrow();
    expect(() => apiBase({ native: true })).toThrow();
  });
  it('keeps tokens out of metadata and Chinese out of Headers', async () => {
    const h = harness(); await h.client.login(credentials());
    await h.client.updateProfile({ displayName: '中文昵称', baseRevision: '1' });
    expect(JSON.stringify([...h.values])).not.toContain('token.');
    expect(JSON.stringify([...h.values])).not.toContain(credentials().password);
    const patch = h.calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch.body).displayName).toBe('中文昵称');
    expect([...patch.headers.values()].every((value) => /^[\x20-\x7e]*$/.test(value))).toBe(true);
    expect(patch.credentials).toBe('include');
  });
  it('uploads image bytes with an ASCII content type and without putting a token in the signed URL request', async () => {
    const h = harness(); await h.client.login(credentials());
    const bytes = new Uint8Array([1, 2, 3]);
    await h.client.upload('/assets/11111111-1111-4111-8111-111111111111/source?ticket=safe.ticket', { mimeType: 'image/webp', bytes });
    const call = h.calls.at(-1);
    expect(call.method).toBe('PUT'); expect(call.body).toBe(bytes);
    expect(call.headers.get('Content-Type')).toBe('image/webp'); expect(call.headers.has('Authorization')).toBe(false);
  });
  it('downloads only bounded WebP bytes from a signed image path', async () => {
    const h = harness(); await h.client.login(credentials());
    h.handle((path) => path.includes('/assets/') ? new Response(new Uint8Array([4, 5, 6]), { headers: { 'Content-Type': 'image/webp', 'Content-Length': '3' } }) : undefined);
    const bytes = await h.client.download('/assets/11111111-1111-4111-8111-111111111111/file?ticket=safe.ticket');
    expect(Array.from(bytes)).toEqual([4, 5, 6]);
  });
  it('checks an account-deletion receipt without reusing a login credential', async () => {
    const h = harness();
    const receiptToken = 'r'.repeat(43);
    h.handle((path) => path === `/account-deletions/${A}`
      ? response({ deletionId: A, status: 'processing' })
      : undefined);
    await expect(h.client.deletionStatus(A, receiptToken)).resolves.toMatchObject({ status: 'processing' });
    const call = h.calls.at(-1);
    expect(call.method).toBe('GET');
    expect(call.headers.get('X-Deletion-Receipt')).toBe(receiptToken);
    expect(call.headers.has('Authorization')).toBe(false);
    expect(call.credentials).toBe('include');
  });
  it('rejects a malformed deletion receipt before making a request', async () => {
    const h = harness();
    await expect(h.client.deletionStatus(A, '中文')).rejects.toMatchObject({ code: 'INVALID_DELETION_RECEIPT' });
    expect(h.calls).toHaveLength(0);
  });
  it('stores a native refresh credential only in the guarded secret adapter', async () => {
    const h = harness({ native: true }); await h.client.login(credentials());
    expect(h.secretStore.write).toHaveBeenCalledWith({ userId: A, refreshToken: 'a'.repeat(43) });
    expect(h.calls.every((call) => call.credentials === 'omit')).toBe(true);
    expect(h.calls.some((call) => call.path === '/auth/csrf')).toBe(false);
    expect(JSON.stringify([...h.values])).not.toContain('a'.repeat(43));
  });
});

describe('account transition safety', () => {
  it('never resends an old account mutation using a newly logged in account', async () => {
    const h = harness(); await h.client.login(credentials());
    const entered = deferred(), finish = deferred();
    h.handle(async (path) => { if (path === '/entries') { entered.resolve(); return finish.promise; } });
    const operation = h.client.request('/entries', { method: 'POST', body: { title: 'Alice private text' } });
    const rejected = expect(operation).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    await entered.promise; await h.client.login(credentials('bravo'));
    finish.resolve(response({ code: 'SESSION_INVALID', message: 'expired' }, 401));
    await rejected;
    expect(h.calls.filter((call) => call.path === '/entries')).toHaveLength(1);
    expect(h.calls.find((call) => call.path === '/entries').headers.get('Authorization')).toContain(A);
    expect(h.client.view().user.id).toBe(B);
  });
  it('rejects a stale successful profile response without corrupting the new account', async () => {
    const h = harness(); await h.client.login(credentials());
    const entered = deferred(), finish = deferred();
    h.handle(async (path) => { if (path === '/me') { entered.resolve(); return finish.promise; } });
    const operation = h.client.updateProfile({ displayName: 'Alice private' });
    const rejected = expect(operation).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    await entered.promise; await h.client.login(credentials('bravo'));
    finish.resolve(response({ ...session(A).user, displayName: 'Alice private' }));
    await rejected;
    expect(h.client.view().user.id).toBe(B);
    expect(h.values.get('auth-context').user.id).toBe(B);
  });
  it('marks uncertainty before HTTP can mutate cookies; lost responses never keep the old account online', async () => {
    const h = harness(); await h.client.login(credentials());
    h.handle((path) => {
      if (path === '/auth/login') {
        expect(h.values.get('auth-context').refreshPending).toBe(true);
        expect(h.client.view().status).not.toBe('online');
        throw new Error('response lost after Set-Cookie');
      }
    });
    await expect(h.client.login(credentials('bravo'))).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    expect(h.client.view().status).toBe('expired');
    expect(h.values.get('auth-context').refreshPending).toBe(true);
    await expect(h.client.request('/entries')).rejects.toMatchObject({ code: 'AUTH_UNCERTAIN' });
  });
  it('fails closed if native secure storage rejects a new session', async () => {
    const h = harness({ native: true }); await h.client.login(credentials());
    h.secretStore.write.mockRejectedValueOnce(new Error('keystore locked'));
    await expect(h.client.login(credentials('bravo'))).rejects.toThrow('keystore locked');
    expect(h.client.view().status).toBe('expired');
    expect(h.values.get('auth-context').refreshPending).toBe(true);
  });
  it('converges a persisted uncertain native restart to expired without replaying refresh', async () => {
    const h = harness({ native: true });
    h.values.set('auth-context', { epoch: crypto.randomUUID(), user: session(A).user, refreshPending: true });
    const state = await h.client.initialize();
    expect(state.status).toBe('expired'); expect(state.offlineEligible).toBe(true); expect(h.calls).toHaveLength(0);
    expect(h.invalidated).toHaveBeenCalled();
  });
  it('marks a saved identity as an offline candidate only for an ambiguous connection failure', async () => {
    const h = harness();
    h.values.set('auth-context', { epoch: crypto.randomUUID(), user: session(A).user, sessionId: crypto.randomUUID(), refreshPending: false, signedOut: false });
    h.handle((path) => { if (path === '/auth/refresh') throw new Error('offline'); });
    const state = await h.client.initialize();
    expect(state).toMatchObject({ status: 'expired', reason: 'NETWORK_UNAVAILABLE', offlineEligible: true, user: { id: A } });
    expect(h.values.get('auth-context').refreshPending).toBe(true);
  });
  it('never offers offline account access after the server explicitly rejects the session', async () => {
    const h = harness();
    h.values.set('auth-context', { epoch: crypto.randomUUID(), user: session(A).user, sessionId: crypto.randomUUID(), refreshPending: false, signedOut: false });
    h.handle((path) => path === '/auth/refresh' ? response({ code: 'SESSION_INVALID', message: 'revoked' }, 401) : undefined);
    const state = await h.client.initialize();
    expect(state.status).toBe('expired'); expect(state.offlineEligible).toBe(false);
    expect(h.values.get('auth-context').signedOut).toBe(true);
  });
  it('honors a same-epoch signed-out marker even before BroadcastChannel delivery', async () => {
    const h = harness(); await h.client.login(credentials());
    h.values.set('auth-context', { ...h.values.get('auth-context'), signedOut: true });
    const before = h.calls.length;
    await expect(h.client.request('/entries')).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(h.calls).toHaveLength(before); expect(h.client.view().status).toBe('expired');
  });
  it('uses exactly one refresh and retry for a still-current account', async () => {
    const h = harness(); await h.client.login(credentials());
    let count = 0;
    h.handle((path) => path === '/entries' && ++count === 1 ? response({ code: 'SESSION_INVALID' }, 401) : undefined);
    await expect(h.client.request('/entries')).resolves.toEqual({ ok: true });
    expect(h.calls.filter((call) => call.path === '/auth/refresh')).toHaveLength(1);
    expect(h.calls.filter((call) => call.path === '/entries')).toHaveLength(2);
  });
  it('does not replay a refresh after an ambiguous network failure', async () => {
    const h = harness(); await h.client.login(credentials());
    h.handle((path) => {
      if (path === '/entries') return response({ code: 'SESSION_INVALID' }, 401);
      if (path === '/auth/refresh') throw new Error('lost response');
    });
    await expect(h.client.request('/entries')).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    await expect(h.client.request('/entries')).rejects.toMatchObject({ code: 'AUTH_UNCERTAIN' });
    expect(h.calls.filter((call) => call.path === '/auth/refresh')).toHaveLength(1);
  });
  it('does not present an uncertain logout as guest or erase any diary content', async () => {
    const h = harness(); await h.client.login(credentials()); h.values.set('diary-fixture', 'keep');
    h.handle((path) => { if (path === '/auth/logout') throw new Error('lost logout'); });
    await expect(h.client.logout()).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    expect(h.client.view().status).toBe('expired');
    expect(h.values.get('auth-context').refreshPending).toBe(true);
    expect(h.values.get('diary-fixture')).toBe('keep');
  });
  it('confirmed logout persists a signed-out marker and clears native refresh storage', async () => {
    const h = harness({ native: true }); await h.client.login(credentials());
    expect((await h.client.logout()).status).toBe('guest');
    expect(h.values.get('auth-context').signedOut).toBe(true);
    expect(h.secretStore.clear).toHaveBeenCalledTimes(1);
    expect((await h.client.initialize()).user).toBeNull();
  });
  it('a delayed password-reset cleanup cannot erase a different tab new account', async () => {
    const h = harness(); await h.client.login(credentials());
    const initiating = h.client.view();
    const sibling = harness({ shared: h }); await sibling.client.login(credentials('bravo'));
    await expect(h.client.forgetRevokedSession({ expectedEpoch: initiating.epoch, expectedUserId: A })).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(h.values.get('auth-context').user.id).toBe(B);
    expect(h.values.get('auth-context').signedOut).toBe(false);
  });
});
