import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';
import { config as defaults } from '../../apps/api/src/config.js';
import { createPool } from '../../apps/api/src/db.js';
import { migrate } from '../../apps/api/src/migrate.js';

let admin, pool, server, origin, vaultService;
const databaseName = `diary_vault_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
const config = { ...defaults, secret: 'vault-integration-test-secret-not-for-production', authIpLimit: 10000 };

beforeAll(async () => {
  const url = new URL(defaults.databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329' || !/^diary_vault_test_[0-9a-f_]+$/.test(databaseName)) throw new Error('Vault integration tests require the dedicated loopback PostgreSQL instance.');
  url.pathname = '/postgres'; admin = createPool(url.href); await admin.query(`CREATE DATABASE "${databaseName}"`);
  url.pathname = `/${databaseName}`; pool = createPool(url.href); await migrate(pool);
  const app = createApp({ pool, config, imageStorage: { remove: async () => {} }, exportStorage: { remove: async () => {} } });
  vaultService = app.locals.vault;
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await pool?.end();
  if (admin && /^diary_vault_test_[0-9a-f_]+$/.test(databaseName)) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin?.end();
});

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, json: text ? JSON.parse(text) : null };
}
async function register() {
  const response = await request('/auth/native/register', { method: 'POST', body: { username: `vault_${randomUUID().slice(0, 18)}`,
    password: 'vault-test-password-2026!', device: { installationId: randomUUID(), platform: 'android', name: '密码本测试设备' } } });
  expect(response.status).toBe(201); return response.json.data;
}
const blob = (seed, length = 48) => Buffer.alloc(length, seed).toString('base64url');
const configBody = (requestId = randomUUID(), baseRevision = '0') => ({ requestId, baseRevision,
  kdf: { algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, hashLength: 32 },
  salt: blob(1, 16), wrappedKey: blob(2, 48), wrapNonce: blob(3, 12), cryptoVersion: 1,
  recoveryWrappedKey: blob(20, 48), recoveryNonce: blob(21, 12), recoveryVersion: 1 });
const itemBody = (requestId = randomUUID(), baseRevision = '0', seed = 4) => ({ requestId, baseRevision,
  ciphertext: blob(seed, 80), nonce: blob(seed + 1, 12), cryptoVersion: 1 });

describe('password vault ciphertext API', () => {
  it('stages and atomically commits a complete data-key rotation with idempotent requests', async () => {
    const owner = await register(), startRequestId = randomUUID();
    expect((await request('/vault/config', { method: 'PUT', token: owner.accessToken, body: configBody() })).status).toBe(200);
    const expiredId = randomUUID();
    await pool.query(`INSERT INTO vault_key_rotations(user_id,id,base_config_revision,expected_item_count,new_config,expires_at)
      VALUES($1,$2,1,0,'{}',now()-interval '1 hour')`, [owner.user.id, expiredId]);
    expect(await vaultService.expire()).toBe(1);
    const firstId = randomUUID(), secondId = randomUUID();
    expect((await request(`/vault/items/${firstId}`, { method: 'PUT', token: owner.accessToken, body: itemBody(randomUUID(), '0', 30) })).status).toBe(200);
    expect((await request(`/vault/items/${secondId}`, { method: 'PUT', token: owner.accessToken, body: itemBody(randomUUID(), '0', 32) })).status).toBe(200);
    const removed = await request(`/vault/items/${secondId}?baseRevision=1`, { method: 'DELETE', token: owner.accessToken,
      headers: { 'Idempotency-Key': randomUUID() } });
    expect(removed.status).toBe(200);

    const startBody = { ...configBody(startRequestId, undefined), baseRevision: undefined, baseConfigRevision: '1', itemCount: 2,
      salt: blob(40, 16), wrappedKey: blob(41, 48), wrapNonce: blob(42, 12), recoveryWrappedKey: blob(43, 48), recoveryNonce: blob(44, 12) };
    const started = await request('/vault/key-rotations', { method: 'POST', token: owner.accessToken, body: startBody });
    expect(started.status).toBe(201); expect(started.json.data.rotation).toMatchObject({ expectedItemCount: 2, uploadedItemCount: 0, status: 'staging' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM vault_key_rotations WHERE user_id=$1 AND id=$2', [owner.user.id, expiredId])).rows[0].count).toBe(0);
    const replayedStart = await request('/vault/key-rotations', { method: 'POST', token: owner.accessToken, body: startBody });
    expect(replayedStart.json.data).toMatchObject({ replayed: true, rotation: { id: started.json.data.rotation.id } });

    const batchRequestId = randomUUID(), rotationId = started.json.data.rotation.id;
    const batchBody = { requestId: batchRequestId, items: [
      { id: firstId, ...itemBody(undefined, '1', 50), requestId: undefined, baseRevision: '1' },
      { id: secondId, ...itemBody(undefined, '2', 52), requestId: undefined, baseRevision: '2' },
    ] };
    const staged = await request(`/vault/key-rotations/${rotationId}/items`, { method: 'PUT', token: owner.accessToken, body: batchBody });
    expect(staged.status).toBe(200); expect(staged.json.data.rotation.uploadedItemCount).toBe(2);
    expect((await request(`/vault/key-rotations/${rotationId}/items`, { method: 'PUT', token: owner.accessToken, body: batchBody })).json.data.replayed).toBe(true);

    const commitBody = { requestId: randomUUID() };
    const committed = await request(`/vault/key-rotations/${rotationId}/commit`, { method: 'POST', token: owner.accessToken, body: commitBody });
    expect(committed.status).toBe(200);
    expect(committed.json.data).toMatchObject({ rotation: { status: 'completed', uploadedItemCount: 2 }, config: { revision: '2', salt: blob(40, 16) } });
    expect(committed.json.data.items.map((item) => [item.id, item.revision, Boolean(item.deletedAt)])).toEqual([
      [firstId, '2', false], [secondId, '3', true],
    ].sort((a, b) => a[0].localeCompare(b[0])));
    expect((await request(`/vault/key-rotations/${rotationId}/commit`, { method: 'POST', token: owner.accessToken, body: commitBody })).json.data.replayed).toBe(true);
  });

  it('rejects a stale staged rotation without partially changing the config or other ciphertext', async () => {
    const owner = await register();
    await request('/vault/config', { method: 'PUT', token: owner.accessToken, body: configBody() });
    const id = randomUUID(); await request(`/vault/items/${id}`, { method: 'PUT', token: owner.accessToken, body: itemBody(randomUUID(), '0', 60) });
    const started = await request('/vault/key-rotations', { method: 'POST', token: owner.accessToken,
      body: { ...configBody(undefined, undefined), requestId: randomUUID(), baseRevision: undefined, baseConfigRevision: '1', itemCount: 1,
        salt: blob(61, 16), wrappedKey: blob(62, 48), wrapNonce: blob(63, 12), recoveryWrappedKey: blob(64, 48), recoveryNonce: blob(65, 12) } });
    const rotationId = started.json.data.rotation.id;
    await request(`/vault/key-rotations/${rotationId}/items`, { method: 'PUT', token: owner.accessToken,
      body: { requestId: randomUUID(), items: [{ id, ...itemBody(undefined, '1', 66), requestId: undefined }] } });
    const concurrent = await request(`/vault/items/${id}`, { method: 'PUT', token: owner.accessToken, body: itemBody(randomUUID(), '1', 70) });
    expect(concurrent.status).toBe(200);
    const failed = await request(`/vault/key-rotations/${rotationId}/commit`, { method: 'POST', token: owner.accessToken, body: { requestId: randomUUID() } });
    expect(failed.status).toBe(409); expect(failed.json.error.code).toBe('ROTATION_ITEM_SET_CHANGED');
    expect((await request('/vault/config', { token: owner.accessToken })).json.data.config).toMatchObject({ revision: '1', salt: blob(1, 16) });
    expect((await request('/vault/items', { token: owner.accessToken })).json.data.items[0]).toMatchObject({ revision: '2', ciphertext: blob(70, 80) });
  });

  it('stores only opaque cryptographic fields with idempotency, revision checks and account isolation', async () => {
    const owner = await register(), other = await register(), requestId = randomUUID();
    const createdConfig = await request('/vault/config', { method: 'PUT', token: owner.accessToken, body: configBody(requestId) });
    expect(createdConfig.status).toBe(200);
    expect(createdConfig.json.data.config).toMatchObject({ cryptoVersion: 1, recoveryVersion: 1, recoveryWrappedKey: blob(20, 48), revision: '1', kdf: { algorithm: 'argon2id' } });
    expect((await request('/vault/config', { method: 'PUT', token: owner.accessToken, body: configBody(requestId) })).json.data.replayed).toBe(true);
    expect((await request('/vault/config', { token: other.accessToken })).json.data.config).toBeNull();
    const rotated = await request('/vault/config', { method: 'PUT', token: owner.accessToken,
      body: { ...configBody(randomUUID(), '1'), salt: blob(8, 16), wrappedKey: blob(9, 48), wrapNonce: blob(10, 12) } });
    expect(rotated.json.data.config).toMatchObject({ revision: '2', salt: blob(8, 16) });
    const incompleteRecovery = await request('/vault/config', { method: 'PUT', token: owner.accessToken,
      body: { ...configBody(randomUUID(), '2'), recoveryNonce: undefined } });
    expect(incompleteRecovery.status).toBe(422);
    const legacyBody = configBody(randomUUID(), '2');
    delete legacyBody.recoveryWrappedKey; delete legacyBody.recoveryNonce; delete legacyBody.recoveryVersion;
    const legacyUpdate = await request('/vault/config', { method: 'PUT', token: owner.accessToken, body: legacyBody });
    expect(legacyUpdate.json.data.config).toMatchObject({ revision: '3', recoveryVersion: 1, recoveryWrappedKey: blob(20, 48) });
    const staleConfig = await request('/vault/config', { method: 'PUT', token: owner.accessToken,
      body: { ...configBody(randomUUID(), '1'), salt: blob(11, 16) } });
    expect(staleConfig.json.error.code).toBe('REVISION_CONFLICT');

    const id = randomUUID(), itemRequest = randomUUID();
    const created = await request(`/vault/items/${id}`, { method: 'PUT', token: owner.accessToken, body: itemBody(itemRequest) });
    expect(created.status).toBe(200); expect(created.json.data.item).toMatchObject({ id, revision: '1', deletedAt: null });
    expect(Object.keys(created.json.data.item).sort()).toEqual(['ciphertext','createdAt','cryptoVersion','deletedAt','id','nonce','revision','updatedAt'].sort());
    expect((await request(`/vault/items/${id}`, { method: 'PUT', token: owner.accessToken, body: itemBody(itemRequest) })).json.data.replayed).toBe(true);
    expect((await request(`/vault/items/${id}`, { method: 'PUT', token: owner.accessToken, body: itemBody(randomUUID(), '0', 7) })).json.error.code).toBe('REVISION_CONFLICT');
    expect((await request('/vault/items', { token: other.accessToken })).json.data.items).toEqual([]);
    const removed = await request(`/vault/items/${id}?baseRevision=1`, { method: 'DELETE', token: owner.accessToken, headers: { 'Idempotency-Key': randomUUID() } });
    expect(removed.json.data.item).toMatchObject({ id, revision: '2' }); expect(removed.json.data.item.deletedAt).toMatch(/^\d{4}-/);
  });

  it('rejects plaintext fields and uses an account-bound signed cursor', async () => {
    const owner = await register(), other = await register();
    const plaintext = await request(`/vault/items/${randomUUID()}`, { method: 'PUT', token: owner.accessToken,
      body: { ...itemBody(), serviceName: '不应上传', username: 'secret', password: 'secret' } });
    expect(plaintext.status).toBe(422);
    for (let index = 0; index < 3; index++) {
      const saved = await request(`/vault/items/${randomUUID()}`, { method: 'PUT', token: owner.accessToken, body: itemBody(randomUUID(), '0', 10 + index) });
      expect(saved.status).toBe(200);
    }
    const first = await request('/vault/items?limit=2', { token: owner.accessToken });
    expect(first.json.data).toMatchObject({ hasMore: true }); expect(first.json.data.items).toHaveLength(2);
    const second = await request(`/vault/items?limit=2&cursor=${encodeURIComponent(first.json.data.nextCursor)}`, { token: owner.accessToken });
    expect(second.json.data.items).toHaveLength(1); expect(second.json.data.hasMore).toBe(false);
    const crossAccount = await request(`/vault/items?limit=2&cursor=${encodeURIComponent(first.json.data.nextCursor)}`, { token: other.accessToken });
    expect(crossAccount.json.error.code).toBe('CURSOR_INVALID');
  });
});
