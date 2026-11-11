import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/api/src/app.js';
import { config as defaults } from '../../apps/api/src/config.js';
import { createPool } from '../../apps/api/src/db.js';
import { migrate } from '../../apps/api/src/migrate.js';

const databaseName = `diary_restart_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
let admin, databaseUrl, storageRoot, pool, server, origin, secondaryPool, secondaryServer, secondaryOrigin, created = false;

async function stopApi() {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  server = undefined;
  await pool?.end();
  pool = undefined;
}

async function startApi() {
  pool = createPool(databaseUrl);
  const app = createApp({ pool, config: {
    ...defaults,
    secret: 'restart-persistence-integration-test-only',
    authIpLimit: 1000,
    imageStorageRoot: join(storageRoot, 'assets'),
    exportStorageRoot: join(storageRoot, 'exports'),
  } });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  origin = `http://127.0.0.1:${server.address().port}/api/v1`;
}

async function startSecondaryApi() {
  secondaryPool = createPool(databaseUrl);
  const app = createApp({ pool: secondaryPool, config: {
    ...defaults,
    secret: 'restart-persistence-integration-test-only',
    authIpLimit: 1000,
    imageStorageRoot: join(storageRoot, 'assets'),
    exportStorageRoot: join(storageRoot, 'exports'),
  } });
  secondaryServer = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  secondaryOrigin = `http://127.0.0.1:${secondaryServer.address().port}/api/v1`;
}

async function requestAt(base, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}
const request = (path, options) => requestAt(origin, path, options);

beforeAll(async () => {
  const url = new URL(defaults.databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329' || !/^diary_restart_test_[0-9a-f_]+$/.test(databaseName)) throw new Error('Restart test requires the isolated loopback diary PostgreSQL server.');
  url.pathname = '/postgres';
  admin = createPool(url.href);
  await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
  url.pathname = `/${databaseName}`;
  databaseUrl = url.href;
  const migrationPool = createPool(databaseUrl);
  try { await migrate(migrationPool); } finally { await migrationPool.end(); }
  storageRoot = await mkdtemp(join(tmpdir(), 'diary-restart-test-'));
});

afterAll(async () => {
  if (secondaryServer) await new Promise((resolve) => { secondaryServer.close(resolve); secondaryServer.closeAllConnections(); });
  await secondaryPool?.end();
  await stopApi();
  if (created && /^diary_restart_test_[0-9a-f_]+$/.test(databaseName)) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('API restart persistence and multiple instances', { sequential: true }, () => {
  it('keeps the account and diary after recreating the server and database pool', async () => {
    const username = `restart_${randomUUID().slice(0, 12)}`;
    const password = 'restart-proof-password-2026!';
    const device = { installationId: randomUUID(), platform: 'android', name: '重启测试手机' };
    await startApi();
    const operations = await request('/health/operations');
    expect(operations.status).toBe(200);
    expect(operations.json.data).toEqual({ status: 'ok', counts: {
      snapshot_pending: 0, snapshot_failed: 0, export_pending: 0, export_failed: 0,
      deletion_pending: 0, deletion_failed: 0, ledger_reappeared: 0, asset_failed: 0, trash_overdue: 0, vault_rotation_expired: 0,
    } });
    const registered = await request('/auth/native/register', { method: 'POST', body: { username, password, device } });
    expect(registered.status).toBe(201);
    const entryId = randomUUID();
    const createdEntry = await request('/entries', { method: 'POST', token: registered.json.data.accessToken, body: {
      mutationId: randomUUID(), entryId, baseRevision: '0', payload: {
        kind: 'daily', entryDate: '2026-09-09', timezone: 'Asia/Shanghai', occurredAt: null,
        title: '重启后仍存在', contentSchemaVersion: 1,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '持久化验证正文' }] }] },
        mood: 5, tags: [{ name: '持久化' }],
      },
    } });
    expect(createdEntry.status).toBe(201);

    await stopApi();
    await startApi();
    const loggedIn = await request('/auth/native/login', { method: 'POST', body: { username, password, device: { ...device, installationId: randomUUID() } } });
    expect(loggedIn.status).toBe(200);
    const restored = await request(`/entries/${entryId}`, { token: loggedIn.json.data.accessToken });
    expect(restored.status).toBe(200);
    expect(restored.json.data).toMatchObject({ id: entryId, title: '重启后仍存在', plainText: '持久化验证正文', tags: [{ name: '持久化' }] });
  });

  it('shares sessions and enforces daily uniqueness across two API instances', async () => {
    await startSecondaryApi();
    const username = `instances_${randomUUID().slice(0, 12)}`;
    const password = 'two-instance-password-2026!';
    const device = { installationId: randomUUID(), platform: 'android', name: '多实例测试手机' };
    const registered = await request('/auth/native/register', { method: 'POST', body: { username, password, device } });
    expect(registered.status).toBe(201);
    const payload = (title) => ({
      mutationId: randomUUID(), entryId: randomUUID(), baseRevision: '0', payload: {
        kind: 'daily', entryDate: '2026-09-10', timezone: 'Asia/Shanghai', occurredAt: null,
        title, contentSchemaVersion: 1,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] },
        mood: 4, tags: [{ name: '双实例' }],
      },
    });
    const [first, second] = await Promise.all([
      request('/entries', { method: 'POST', token: registered.json.data.accessToken, body: payload('实例一写入') }),
      requestAt(secondaryOrigin, '/entries', { method: 'POST', token: registered.json.data.accessToken, body: payload('实例二写入') }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const successful = first.status === 201 ? first : second;
    const readFromOther = await requestAt(first.status === 201 ? secondaryOrigin : origin, `/entries/${successful.json.data.entry.id}`, { token: registered.json.data.accessToken });
    expect(readFromOther.status).toBe(200);
    expect(['实例一写入', '实例二写入']).toContain(readFromOther.json.data.title);
  });
});
