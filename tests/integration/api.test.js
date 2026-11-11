import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../../apps/api/src/app.js';
import { createPool, userTransaction, appendEvent } from '../../apps/api/src/db.js';
import { migrate } from '../../apps/api/src/migrate.js';
import { config as defaults } from '../../apps/api/src/config.js';
import { createAuth } from '../../apps/api/src/auth.js';
import { createSync } from '../../apps/api/src/sync.js';
import 'fake-indexeddb/auto';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { createSnapshotDownloader } from '../../apps/client/src/services/snapshot-downloader.js';
import { createSyncPuller } from '../../apps/client/src/services/sync-puller.js';
import { createSyncUploader } from '../../apps/client/src/services/sync-uploader.js';
import { createAssetUploader } from '../../apps/client/src/services/asset-uploader.js';
import { createSyncCoordinator } from '../../apps/client/src/services/sync-coordinator.js';
import { freezeExport } from '../../apps/api/src/export-snapshot.js';
import { createExportWorker } from '../../apps/api/src/export-worker.js';
import JSZip from 'jszip';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { makeDraft } from '../../packages/contracts/src/entry.js';

let admin, pool, server, origin, snapshots, exportWorker, assetCleanup, accountDeletions, entryPurge, imageFiles;
const databaseName = `diary_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
const config = { ...defaults, secret: 'integration-test-secret-only-not-production', authIpLimit: 10000 };
const device = (platform = 'android') => ({ installationId: randomUUID(), platform, name: platform === 'web' ? '测试电脑' : '测试手机' });

beforeAll(async () => {
  const url = new URL(defaults.databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329' || !/^diary_test_[0-9a-f_]+$/.test(databaseName)) throw new Error('Integration tests only run against the dedicated loopback diary database on port 54329.');
  url.pathname = '/postgres';
  admin = createPool(url.href);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  url.pathname = `/${databaseName}`;
  pool = createPool(url.href);
  await migrate(pool);
  imageFiles = new Map();
  const imageStorage = {
    async putSource(id, bytes) { const key = `source/${id}.bin`, existing = imageFiles.get(key); if (existing && !existing.equals(bytes)) throw new Error('source changed'); imageFiles.set(key, Buffer.from(bytes)); return key; },
    async read(key) { const value = imageFiles.get(key); if (!value) throw new Error('missing image'); return Buffer.from(value); },
    async putVariants(id, token, original, thumbnail) { const keys = { original: `original/${id}_${token}.webp`, thumbnail: `thumbnail/${id}_${token}.webp` }; imageFiles.set(keys.original, Buffer.from(original)); imageFiles.set(keys.thumbnail, Buffer.from(thumbnail)); return keys; },
    async remove(key) { imageFiles.delete(key); },
  };
  const app = createApp({ pool, config, imageStorage });
  snapshots = app.locals.snapshots;
  exportWorker = app.locals.exportWorker;
  assetCleanup = app.locals.assetCleanup;
  accountDeletions = app.locals.accountDeletions;
  entryPurge = app.locals.entryPurge;
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await pool?.end();
  // Only the unique database created above may be removed, never diary_dev or a user DB.
  if (admin && /^diary_test_[0-9a-f_]+$/.test(databaseName)) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin?.end();
});

async function request(path, { method = 'GET', token, body, headers = {}, raw } = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
}

async function user(options = {}) {
  const username = options.username ?? `u_${randomUUID().slice(0, 18)}`;
  const password = options.password ?? 'learn-diary-password-2026!';
  const result = await request('/auth/native/register', { method: 'POST', body: { username, password, device: device() } });
  expect(result.status).toBe(201);
  return { ...result.json.data, username: username.trim().toLowerCase(), password };
}

const payload = (overrides = {}) => ({ kind: 'daily', entryDate: '2026-09-08', timezone: 'Asia/Shanghai', occurredAt: null, title: '今天的记录', contentSchemaVersion: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '你好，新的日记本。' }] }] }, mood: 4, tags: [{ name: '生活' }], ...overrides });
const mutation = (overrides = {}) => ({ mutationId: randomUUID(), entryId: randomUUID(), baseRevision: '0', payload: payload(), ...overrides });
const createEntry = (account, body = mutation()) => request('/entries', { method: 'POST', token: account.accessToken, body });

describe('frozen synchronization snapshots', () => {
  it('syncs diary text after terminal image failures and later patches the ready private image on the confirmed revision', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#9d5338' } }).png().toBuffer();
    const entryId = randomUUID(), assetId = randomUUID(), stamp = new Date().toISOString();
    const clientRequest = async (path, options = {}) => {
      const response = await request(path, { ...options, token: a.accessToken });
      if (response.status >= 400) throw Object.assign(new Error(response.json.error.message), response.json.error, { status: response.status });
      return response.json?.data;
    };
    try {
      await store.saveAsset({ id: assetId, entryId, mimeType: 'image/png', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), width: 6, height: 4, createdAt: stamp, bytes });
      const local = await store.save({ ...makeDraft({ id: entryId, kind: 'moment' }), title: '图片失败也先保住文字',
        content: { type: 'doc', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '这段文字应先到云端。' }] },
          { type: 'image', attrs: { assetId, alt: '稍后补传', caption: '' } },
        ] } });
      for (let attempt = 0; attempt < 3; attempt++) await store.recordAssetUploadFailure(assetId,
        Object.assign(new Error('simulated transport detail'), { code: 'NETWORK_UNAVAILABLE' }));
      expect(await store.assetUploadSummary()).toEqual({ waiting: 0, failed: 1 });

      const uploader = createSyncUploader({ queue: store.uploadQueue, request: clientRequest, isCurrent: () => true });
      expect((await uploader.step()).status).toBe('more-local-work');
      const textOnly = await request(`/entries/${entryId}`, { token: a.accessToken });
      expect(textOnly.json.data.revision).toBe('1');
      expect(JSON.stringify(textOnly.json.data.content)).toContain('这段文字应先到云端');
      expect(JSON.stringify(textOnly.json.data.content)).not.toContain(assetId);
      expect(await store.uploadQueue.next()).toBeNull();

      await store.retryAssetUpload(assetId);
      const assetUploader = createAssetUploader({ assets: store, request: clientRequest, isCurrent: () => true,
        upload: async (path, input) => {
          const response = await fetch(`${origin}${path}`, { method: 'PUT', headers: { 'Content-Type': input.mimeType }, body: input.bytes });
          if (!response.ok) throw Object.assign(new Error('asset upload failed'), { status: response.status });
        } });
      expect((await assetUploader.step()).status).toBe('asset-ready');
      expect((await uploader.step()).status).toBe('acknowledged');
      const complete = await request(`/entries/${entryId}`, { token: a.accessToken });
      expect(complete.json.data).toMatchObject({ revision: '2', title: local.title });
      expect(JSON.stringify(complete.json.data.content)).toContain(assetId);
      expect((await pool.query('SELECT asset_id FROM entry_assets WHERE user_id=$1 AND entry_id=$2', [a.user.id, entryId])).rows[0].asset_id).toBe(assetId);
      expect(await store.assetUploadSummary()).toEqual({ waiting: 0, failed: 0 });
    } finally { await store.db.delete(); }
  });
  it('receives a session-bound image upload and makes it ready only after safe processing', async () => {
    const a = await user(), bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#ac5837' } }).png().toBuffer();
    const assetId = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
    const registered = await request('/assets/uploads', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), assetId, mimeType: 'image/png', size: bytes.length, sha256 } });
    expect(registered.status).toBe(201);
    const upload = await fetch(origin.replace(/\/api\/v1$/, '') + registered.json.data.uploadUrl,
      { method: 'PUT', headers: registered.json.data.headers, body: bytes });
    expect(upload.status).toBe(200);
    expect((await request(`/assets/${assetId}`, { token: a.accessToken })).json.data.status).toBe('pending');
    const requestId = randomUUID();
    const completed = await request(`/assets/${assetId}/complete`, { method: 'POST', token: a.accessToken, body: { requestId } });
    expect(completed.status).toBe(202); expect(completed.json.data).toMatchObject({ status: 'ready', width: 16, height: 12 });
    expect((await request(`/assets/${assetId}/complete`, { method: 'POST', token: a.accessToken, body: { requestId } })).json.data).toEqual(completed.json.data);
    expect([...imageFiles.keys()].some((key) => key.startsWith(`source/${assetId}`))).toBe(false);
    expect([...imageFiles.keys()].filter((key) => key.includes(assetId))).toHaveLength(2);
    const read = async (variant) => request(`/assets/${assetId}/read-url`, { method: 'POST', token: a.accessToken, body: { variant } });
    for (const variant of ['thumbnail', 'original']) {
      const issued = await read(variant); expect(issued.status).toBe(200);
      const response = await fetch(origin.replace(/\/api\/v1$/, '') + issued.json.data.url);
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/webp');
      expect((await sharp(await response.arrayBuffer()).metadata()).format).toBe('webp');
      expect((await fetch(origin.replace(/\/api\/v1$/, '') + issued.json.data.url + 'x')).status).toBe(403);
    }
    const b = await user();
    expect((await request(`/assets/${assetId}/read-url`, { method: 'POST', token: b.accessToken, body: { variant: 'thumbnail' } })).status).toBe(404);
    const imageContent = { type: 'doc', content: [{ type: 'image', attrs: { assetId, alt: '日记照片', caption: '当天的照片' } }] };
    const ownEntry = mutation({ payload: payload({ kind: 'moment', occurredAt: new Date().toISOString(), content: imageContent }) });
    expect((await createEntry(a, ownEntry)).status).toBe(201);
    expect((await pool.query('SELECT asset_id FROM entry_assets WHERE user_id=$1 AND entry_id=$2', [a.user.id, ownEntry.entryId])).rows[0].asset_id).toBe(assetId);
    const foreignEntry = mutation({ payload: payload({ kind: 'moment', occurredAt: new Date().toISOString(), content: imageContent }) });
    const foreignResult = await createEntry(b, foreignEntry);
    expect(foreignResult.status).toBe(422); expect(foreignResult.json.error.code).toBe('ASSET_NOT_READY');
    const oldLink = (await read('thumbnail')).json.data.url;
    expect((await request('/auth/logout', { method: 'POST', token: a.accessToken })).status).toBe(204);
    expect((await fetch(origin.replace(/\/api\/v1$/, '') + oldLink)).status).toBe(401);
  });
  it('rejects a changed upload body and a credential from a logged-out session', async () => {
    const a = await user(), bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
    const assetId = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
    const registered = await request('/assets/uploads', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), assetId, mimeType: 'image/png', size: bytes.length, sha256 } });
    const url = origin.replace(/\/api\/v1$/, '') + registered.json.data.uploadUrl;
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    expect((await fetch(url, { method: 'PUT', headers: registered.json.data.headers, body: changed })).status).toBe(422);
    expect(imageFiles.has(`source/${assetId}.bin`)).toBe(false);
    expect((await request('/auth/logout', { method: 'POST', token: a.accessToken })).status).toBe(204);
    expect((await fetch(url, { method: 'PUT', headers: registered.json.data.headers, body: bytes })).status).toBe(401);
  });
  it('keeps referenced images and removes private bytes only seven days after the last reference', async () => {
    const a = await user(), bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: 'navy' } }).png().toBuffer();
    const assetId = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
    const registered = await request('/assets/uploads', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), assetId, mimeType: 'image/png', size: bytes.length, sha256 } });
    await fetch(origin.replace(/\/api\/v1$/, '') + registered.json.data.uploadUrl, { method: 'PUT', headers: registered.json.data.headers, body: bytes });
    await request(`/assets/${assetId}/complete`, { method: 'POST', token: a.accessToken, body: { requestId: randomUUID() } });
    const content = { type: 'doc', content: [{ type: 'image', attrs: { assetId, alt: '', caption: '' } }] };
    const createdMutation = mutation({ payload: payload({ kind: 'moment', occurredAt: new Date().toISOString(), content }) });
    const created = await createEntry(a, createdMutation); expect(created.status).toBe(201);
    await pool.query("UPDATE assets SET orphaned_at=now()-interval '8 days' WHERE id=$1", [assetId]);
    await assetCleanup.expire();
    expect((await request(`/assets/${assetId}`, { token: a.accessToken })).json.data.status).toBe('ready');
    expect([...imageFiles.keys()].filter((key) => key.includes(assetId))).toHaveLength(2);
    const exported = await request('/exports', { method: 'POST', token: a.accessToken, body: { requestId: randomUUID(), format: 'markdown_zip', entryIds: [createdMutation.entryId], includeImages: true } });
    expect(exported.status).toBe(202); await exportWorker.runOne();
    const link = await request(`/exports/${exported.json.data.jobId}/download`, { method: 'POST', token: a.accessToken });
    const archive = await JSZip.loadAsync(await (await fetch(origin.replace(/\/api\/v1$/, '') + link.json.data.url)).arrayBuffer());
    expect(archive.file(`assets/${assetId}.webp`)).not.toBeNull();
    expect(await archive.file(`entries/${createdMutation.payload.entryDate}-${createdMutation.entryId}.md`).async('string')).toContain(`assets/${assetId}.webp`);
    await request(`/exports/${exported.json.data.jobId}`, { method: 'DELETE', token: a.accessToken }); await exportWorker.expire();
    const updated = await request(`/entries/${createdMutation.entryId}`, { method: 'PUT', token: a.accessToken,
      body: { mutationId: randomUUID(), baseRevision: created.json.data.entry.revision, payload: payload({ kind: 'moment', occurredAt: new Date().toISOString() }) } });
    expect(updated.status).toBe(200);
    expect((await pool.query('SELECT orphaned_at FROM assets WHERE id=$1', [assetId])).rows[0].orphaned_at).not.toBeNull();
    await pool.query("UPDATE assets SET orphaned_at=now()-interval '8 days' WHERE id=$1", [assetId]);
    await assetCleanup.expire();
    expect((await request(`/assets/${assetId}`, { token: a.accessToken })).json.data.status).toBe('deleted');
    expect([...imageFiles.keys()].some((key) => key.includes(assetId))).toBe(false);
  });
  it('registers immutable image identities with private idempotent upload credentials', async () => {
    const a = await user(), b = await user();
    const body = { requestId: randomUUID(), assetId: randomUUID(), mimeType: 'image/png', size: 123, sha256: 'a'.repeat(64) };
    const create = () => request('/assets/uploads', { method: 'POST', token: a.accessToken, body });
    const first = await create(), replay = await create();
    expect(first.status).toBe(201); expect(replay.json.data).toEqual(first.json.data);
    expect((await request(`/assets/${body.assetId}`, { token: b.accessToken })).status).toBe(404);
    expect((await request('/assets/uploads', { method: 'POST', token: a.accessToken, body: { ...body, size: 124 } })).status).toBe(409);
    expect((await request('/assets/uploads', { method: 'POST', token: a.accessToken, body: { ...body, requestId: randomUUID(), size: 124 } })).json.error.code).toBe('ASSET_IDENTITY_CHANGED');
    const renewed = await request(`/assets/${body.assetId}/upload-credentials`, { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), size: body.size, sha256: body.sha256 } });
    expect(renewed.status).toBe(200);
    expect((await request(`/assets/${body.assetId}`, { token: a.accessToken })).json.data.status).toBe('pending');
  });
  it('invalidates a private export link after logout even when another session stays active', async () => {
    const a = await user(); await createEntry(a);
    const second = await request('/auth/native/login', { method: 'POST', body: { username: a.username, password: a.password, device: device() } });
    expect(second.status).toBe(200);
    const token = second.json.data.accessToken;
    const created = await request('/exports', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), format: 'json_zip', includeImages: false } });
    const id = created.json.data.jobId;
    try {
      expect(await exportWorker.runOne()).toBe(true);
      const issued = await request(`/exports/${id}/download`, { method: 'POST', token: a.accessToken });
      const oldUrl = origin.replace(/\/api\/v1$/, '') + issued.json.data.url;
      expect((await request('/auth/logout', { method: 'POST', token: a.accessToken })).status).toBe(204);
      expect((await fetch(oldUrl)).status).toBe(401);
      const fresh = await request(`/exports/${id}/download`, { method: 'POST', token });
      expect(fresh.status).toBe(200);
      const response = await fetch(origin.replace(/\/api\/v1$/, '') + fresh.json.data.url);
      expect(response.status).toBe(200); await response.arrayBuffer();
      expect((await fetch(oldUrl)).status).toBe(401);
    } finally {
      await request(`/exports/${id}`, { method: 'DELETE', token }); await exportWorker.expire();
    }
  });
  it('bounds export retries and never publishes a file after cancellation during storage', async () => {
    const a = await user(); await createEntry(a);
    const make = async () => (await request('/exports', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), format: 'json_zip', includeImages: false } })).json.data.jobId;
    const failedId = await make();
    const failedWorker = createExportWorker(pool, { async write(_id, _token, stream) { stream.destroy(); throw new Error('injected storage failure'); }, async remove() {} });
    for (let attempt = 0; attempt < 3; attempt++) expect(await failedWorker.runOne()).toBe(true);
    expect((await request(`/exports/${failedId}`, { token: a.accessToken })).json.data.status).toBe('failed');
    expect(await failedWorker.runOne()).toBe(false);
    await request(`/exports/${failedId}`, { method: 'DELETE', token: a.accessToken });
    await failedWorker.expire();
    const cancelledId = await make(), removed = [];
    const cancellingWorker = createExportWorker(pool, { async write(id, token, stream) {
      for await (const _chunk of stream) { /* consume the archive without storing test bytes */ }
      expect(id).toBe(cancelledId);
      await request(`/exports/${id}`, { method: 'DELETE', token: a.accessToken });
      return `${id}_${token}.zip`;
    }, async remove(key) { removed.push(key); } });
    expect(await cancellingWorker.runOne()).toBe(true);
    expect(removed).toHaveLength(1);
    expect((await request(`/exports/${cancelledId}`, { token: a.accessToken })).json.data.status).toBe('cancelled');
    expect((await request(`/exports/${cancelledId}/download`, { method: 'POST', token: a.accessToken })).status).toBe(409);
    await cancellingWorker.expire();
  });
  it('pages only the current account export jobs without exposing private output locations', async () => {
    const a = await user(), b = await user();
    const ids = [];
    for (let n = 0; n < 3; n++) {
      const result = await request('/exports', { method: 'POST', token: a.accessToken,
        body: { requestId: randomUUID(), format: 'json_zip', includeImages: false } });
      ids.push(result.json.data.jobId);
      await request(`/exports/${result.json.data.jobId}`, { method: 'DELETE', token: a.accessToken });
    }
    const page = await request('/exports?limit=2', { token: a.accessToken });
    expect(page.json.data.items).toHaveLength(2); expect(page.json.data.hasMore).toBe(true);
    const next = await request(`/exports?limit=2&before=${page.json.data.nextCursor}`, { token: a.accessToken });
    expect(next.json.data.items).toHaveLength(1); expect(next.json.data.hasMore).toBe(false);
    expect(new Set([...page.json.data.items, ...next.json.data.items].map((job) => job.jobId))).toEqual(new Set(ids));
    expect(page.json.data.items[0]).not.toHaveProperty('output_key');
    expect((await request('/exports', { token: b.accessToken })).json.data.items).toEqual([]);
    expect((await request('/exports?limit=500', { token: a.accessToken })).status).toBe(422);
  });
  it('downloads a real private archive through a session-bound link and revokes it on cancellation', async () => {
    const a = await user(), b = await user(); await createEntry(a);
    const created = await request('/exports', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), format: 'json_zip', includeImages: false } });
    const id = created.json.data.jobId;
    try {
      expect(await exportWorker.runOne()).toBe(true);
      expect((await request(`/exports/${id}/download`, { method: 'POST', token: b.accessToken })).status).toBe(404);
      const issued = await request(`/exports/${id}/download`, { method: 'POST', token: a.accessToken });
      expect(issued.status).toBe(200);
      const url = origin.replace(/\/api\/v1$/, '') + issued.json.data.url;
      const response = await fetch(url); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const zip = await JSZip.loadAsync(await response.arrayBuffer(), { checkCRC32: true });
      expect(JSON.parse(await zip.file('manifest.json').async('string')).entryCount).toBe(1);
      expect((await fetch(url + 'x')).status).toBe(403);
      await request(`/exports/${id}`, { method: 'DELETE', token: a.accessToken });
      expect((await fetch(url)).status).toBe(410);
    } finally {
      await request(`/exports/${id}`, { method: 'DELETE', token: a.accessToken });
      await exportWorker.expire();
    }
  });
  it('generates a frozen private ZIP and marks readiness only after storage succeeds', async () => {
    const a = await user(); await createEntry(a);
    const created = await request('/exports', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), format: 'markdown_zip', includeImages: false } });
    const id = created.json.data.jobId;
    let saved; const removed = [];
    const worker = createExportWorker(pool, { async write(jobId, token, stream) {
      const chunks = []; for await (const chunk of stream) chunks.push(chunk);
      saved = Buffer.concat(chunks); return `${jobId}_${token}.zip`;
    }, async remove(key) { removed.push(key); } });
    expect(await worker.runOne()).toBe(true);
    const status = (await request(`/exports/${id}`, { token: a.accessToken })).json.data;
    expect(status).toMatchObject({ status: 'ready', progress: 100 }); expect(status.expiresAt).toBeTruthy();
    expect(status).not.toHaveProperty('output_key');
    const zip = await JSZip.loadAsync(saved, { checkCRC32: true });
    expect(JSON.parse(await zip.file('manifest.json').async('string')).entryCount).toBe(1);
    await pool.query("UPDATE export_jobs SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect((await request(`/exports/${id}`, { token: a.accessToken })).json.data.status).toBe('expired');
    await worker.expire(); await worker.expire();
    expect(removed).toHaveLength(1);
    expect((await pool.query('SELECT * FROM export_records WHERE job_id=$1', [id])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM entries WHERE user_id=$1', [a.user.id])).rowCount).toBe(1);
  });
  it('freezes export records once and does not include later edits or another account', async () => {
    const a = await user(), b = await user();
    const first = (await createEntry(a)).json.data.entry;
    const foreign = (await createEntry(b)).json.data.entry;
    const created = await request('/exports', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), format: 'json_zip', entryIds: [first.id], includeImages: false } });
    const id = created.json.data.jobId;
    expect((await freezeExport(pool, id)).record_count).toBe('1');
    await request(`/entries/${first.id}`, { method: 'PUT', token: a.accessToken,
      body: { mutationId: randomUUID(), baseRevision: '1', payload: payload({ title: '冻结之后修改' }) } });
    await freezeExport(pool, id);
    const records = (await pool.query('SELECT record FROM export_records WHERE job_id=$1', [id])).rows;
    expect(records).toHaveLength(1); expect(records[0].record.title).toBe(first.title);
    const invalid = await request('/exports', { method: 'POST', token: a.accessToken,
      body: { requestId: randomUUID(), format: 'json_zip', entryIds: [first.id, foreign.id] } });
    await expect(freezeExport(pool, invalid.json.data.jobId)).rejects.toMatchObject({ code: 'EXPORT_SELECTION_UNAVAILABLE' });
    expect((await pool.query('SELECT * FROM export_records WHERE job_id=$1', [invalid.json.data.jobId])).rowCount).toBe(0);
    await request(`/exports/${id}`, { method: 'DELETE', token: a.accessToken });
    expect(await freezeExport(pool, id)).toBeNull();
  });
  it('isolates export jobs, deduplicates requests and permits idempotent cancellation', async () => {
    const a = await user(), b = await user(), body = { requestId: randomUUID(), format: 'markdown_zip', from: '2026-01-01', to: '2026-09-08' };
    const create = () => request('/exports', { method: 'POST', token: a.accessToken, body });
    const [first, replay] = await Promise.all([create(), create()]);
    expect(first.status).toBe(202); expect(first.json.data.jobId).toBe(replay.json.data.jobId);
    expect(first.json.data.status).toBe('queued'); expect(first.json.data).not.toHaveProperty('downloadUrl');
    const path = `/exports/${first.json.data.jobId}`;
    expect((await request(path, { token: b.accessToken })).status).toBe(404);
    expect((await request(path, { method: 'DELETE', token: b.accessToken })).status).toBe(404);
    expect((await request('/exports', { method: 'POST', token: a.accessToken, body: { ...body, format: 'json_zip' } })).status).toBe(409);
    expect((await request('/exports', { method: 'POST', token: a.accessToken, body: { ...body, requestId: randomUUID(), from: '2026-09-09' } })).status).toBe(422);
    expect((await request(path, { method: 'DELETE', token: a.accessToken })).json.data.status).toBe('cancelled');
    expect((await request(path, { method: 'DELETE', token: a.accessToken })).json.data.status).toBe('cancelled');
    expect((await create()).json.data.status).toBe('cancelled');
  });
  it('preserves a submitted merge through another remote update and permits a newly confirmed merge', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    const read = async (id) => (await request(`/entries/${id}`, { token: a.accessToken })).json.data;
    try {
      const uploader = createSyncUploader({ queue: store.uploadQueue, isCurrent: () => true, request: async (path, options) => {
        const result = await request(path, { ...options, token: a.accessToken }); expect(result.status).toBe(200); return result.json.data;
      } });
      const original = await store.save({ ...makeDraft({ kind: 'moment' }), title: '原始记录' });
      await uploader.step();
      const local = await store.save({ ...await store.get(original.id), title: '本机编辑' });
      const update = async (baseRevision, title) => {
        const result = await request(`/entries/${original.id}`, { method: 'PUT', token: a.accessToken,
          body: { mutationId: randomUUID(), baseRevision, payload: payload({ kind: 'moment', occurredAt: original.occurredAt, title }) } });
        expect(result.status).toBe(200);
      };
      await update('1', '云端第二版'); expect((await uploader.step()).status).toBe('conflict');
      const firstId = (await store.listConflicts()).items[0].id;
      await store.saveMergeDraft(firstId, { ...local, title: '第一次手动合并' }, 0);
      await store.keepCloud(firstId, { expectedLocalRevision: local.localRevision, remote: await read(original.id), mergeRevision: 1 });
      await update('2', '云端第三版');
      expect((await uploader.step()).status).toBe('conflict');
      expect((await read(original.id)).title).toBe('云端第三版');
      const second = (await store.listConflicts()).items.find((item) => item.id !== firstId);
      const preserved = await store.getConflict(second.id);
      expect(preserved.record.local.title).toBe('第一次手动合并');
      expect(preserved.record.remote.revision).toBe('3');
      expect((await store.getConflict(firstId)).record.mergeDraft.entry.title).toBe('第一次手动合并');
      await store.saveMergeDraft(second.id, { ...preserved.record.local, title: '再次比较后确认的合并' }, 0);
      await store.keepCloud(second.id, { expectedLocalRevision: preserved.latestLocal.localRevision, remote: await read(original.id), mergeRevision: 1 });
      expect((await uploader.step()).status).toBe('acknowledged');
      expect(await read(original.id)).toMatchObject({ title: '再次比较后确认的合并', revision: '4' });
      expect((await store.uploadQueue.summary()).blocked).toBe(0);
    } finally { await store.db.delete(); }
  });
  it('accepts a live cloud revision after conflict and uploads subsequent edits from that revision', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    try {
      const uploader = createSyncUploader({ queue: store.uploadQueue, isCurrent: () => true, request: async (path, options) => {
        const response = await request(path, { ...options, token: a.accessToken });
        expect(response.status).toBe(200); return response.json.data;
      } });
      const original = await store.save({ ...makeDraft({ kind: 'moment' }), title: '第一版' });
      expect((await uploader.step()).status).toBe('acknowledged');
      const edit = await store.save({ ...await store.get(original.id), title: '本机尚未上传' });
      const remoteWrite = await request(`/entries/${original.id}`, { method: 'PUT', token: a.accessToken,
        body: { mutationId: randomUUID(), baseRevision: '1', payload: payload({ kind: 'moment', occurredAt: original.occurredAt, title: '另一台设备写入' }) } });
      expect(remoteWrite.status).toBe(200);
      expect((await uploader.step()).status).toBe('conflict');
      const conflictId = (await store.listConflicts()).items[0].id;
      const live = await request(`/entries/${original.id}`, { token: a.accessToken });
      expect(live.status).toBe(200);
      await store.keepCloud(conflictId, { expectedLocalRevision: edit.localRevision, remote: live.json.data });
      expect((await store.uploadQueue.summary()).blocked).toBe(0);
      expect((await store.getConflict(conflictId)).record.resolution.discardedLocal.title).toBe('本机尚未上传');
      const visible = await store.get(original.id);
      expect(visible).toMatchObject({ revision: '2', title: '另一台设备写入' });
      await expect(store.save({ ...edit, title: '旧编辑器迟到' })).rejects.toThrow();
      await store.save({ ...visible, title: '保留后继续编辑' });
      expect((await uploader.step()).status).toBe('acknowledged');
      expect((await request(`/entries/${original.id}`, { token: a.accessToken })).json.data)
        .toMatchObject({ revision: '3', title: '保留后继续编辑' });
    } finally { await store.db.delete(); }
  });
  it('uploads a conflict copy under a new ID while preserving the existing daily and blocked original', async () => {
    const a = await user(), existing = mutation(); await createEntry(a, existing);
    const store = createLocalStore(`user:${a.user.id}`);
    try {
      const original = await store.save({ ...makeDraft({ entryDate: existing.payload.entryDate }), title: '重复日期的本机稿' });
      const uploader = createSyncUploader({ queue: store.uploadQueue, isCurrent: () => true, request: async (path, options) => {
        const response = await request(path, { ...options, token: a.accessToken }); expect(response.status).toBe(200); return response.json.data;
      } });
      expect((await uploader.step()).status).toBe('conflict');
      const conflictId = (await store.listConflicts()).items[0].id;
      const copy = await store.copyConflict(conflictId); expect(copy.entryId).not.toBe(original.id);
      expect((await uploader.step()).status).toBe('acknowledged');
      const remoteCopy = await request(`/entries/${copy.entryId}`, { token: a.accessToken });
      expect(remoteCopy.json.data).toMatchObject({ kind: 'moment', title: original.title, revision: '1' });
      expect((await request(`/entries/${existing.entryId}`, { token: a.accessToken })).json.data.title).toBe(existing.payload.title);
      expect((await store.uploadQueue.summary()).blocked).toBe(1);
      expect((await store.get(original.id)).title).toBe(original.title);
      expect(await store.copyConflict(conflictId)).toEqual({ entryId: copy.entryId, reused: true });
    } finally { await store.db.delete(); }
  });
  it('recovers a terminal snapshot failure only after an explicit recovery request', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    try {
      const saved = await store.save({ ...makeDraft({ kind: 'moment' }), title: '失败后继续同步的本机稿' });
      const coordinator = createSyncCoordinator({ mirror: store.syncMirror, queue: store.uploadQueue, isCurrent: () => true,
        request: async (path, options = {}) => {
          const response = await request(path, { ...options, token: a.accessToken });
          if (response.status >= 400) throw Object.assign(new Error(response.json.error.message), response.json.error);
          return response.json.data;
        } });
      expect((await coordinator.step()).status).toBe('waiting');
      const original = (await store.syncMirror.state()).request;
      await pool.query("UPDATE snapshots SET status='failed',error_code='TEST_FAILURE' WHERE id=$1 AND user_id=$2", [original.snapshotId, a.user.id]);
      await expect(coordinator.step()).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' });
      expect((await store.syncMirror.state()).request).toEqual(original);
      coordinator.requestRecovery(); expect((await coordinator.step()).status).toBe('waiting');
      const replacement = (await store.syncMirror.state()).request;
      expect(replacement.requestId).not.toBe(original.requestId); expect(replacement.snapshotId).not.toBe(original.snapshotId);
      expect((await store.draft(saved.id)).title).toBe(saved.title);
      await snapshots.runOne(); let result;
      for (let step = 0; step < 8; step++) { result = await coordinator.step(); if (result.status === 'sync-idle') break; }
      expect(result.status).toBe('sync-idle');
      expect((await request(`/entries/${saved.id}`, { token: a.accessToken })).json.data.title).toBe(saved.title);
    } finally { await store.db.delete(); }
  });
  it('coordinates initial snapshot, automatic upload, delta download and an accurate idle summary', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    try {
      const saved = await store.save({ ...makeDraft({ kind: 'moment' }), title: '自动同步链路' });
      const coordinator = createSyncCoordinator({ mirror: store.syncMirror, queue: store.uploadQueue, isCurrent: () => true,
        request: async (path, options = {}) => {
          const response = await request(path, { ...options, token: a.accessToken });
          if (response.status >= 400) throw Object.assign(new Error(response.json.error.message), response.json.error);
          return response.json.data;
        } });
      let result;
      for (let step = 0; step < 10; step++) {
        result = await coordinator.step();
        if (result.status === 'waiting') await snapshots.runOne();
        if (result.status === 'sync-idle') break;
      }
      expect(result).toMatchObject({ status: 'sync-idle', summary: { pending: 0, waiting: 0, blocked: 0, localTrash: 0, unverified: 0 } });
      expect((await request(`/entries/${saved.id}`, { token: a.accessToken })).json.data.title).toBe(saved.title);
      expect((await store.syncMirror.records()).find((row) => row.id === saved.id).value.title).toBe(saved.title);
      expect((await store.get(saved.id)).revision).toBe('1');
    } finally { await store.db.delete(); }
  });
  it('uses actual snapshot and receipt positions to distinguish an old snapshot from a later simulated purge', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    const createFrozen = async () => {
      const created = await request('/sync/snapshots', { method: 'POST', token: a.accessToken, body: { requestId: randomUUID() } });
      expect(created.status).toBe(202); await snapshots.runOne();
      return created.json.data.snapshotId;
    };
    const applyFrozen = async (id) => {
      const info = await request(`/sync/snapshots/${id}`, { token: a.accessToken }); expect(info.json.data.status).toBe('ready');
      const page = await request(`/sync/snapshots/${id}/pages?limit=100`, { token: a.accessToken });
      expect(page.json.data.hasMore).toBe(false);
      await store.syncMirror.begin({ snapshotId: id, recordCount: Number(info.json.data.recordCount) });
      await store.syncMirror.append(id, null, page.json.data); await store.syncMirror.commit(id);
      return page.json.data.snapshotPosition;
    };
    try {
      const oldSnapshot = await createFrozen();
      const saved = await store.save({ ...makeDraft({ kind: 'moment' }), title: '快照生成后才上传' });
      const uploader = createSyncUploader({ queue: store.uploadQueue, isCurrent: () => true, request: async (path, options) => {
        const response = await request(path, { ...options, token: a.accessToken }); expect(response.status).toBe(200); return response.json.data;
      } });
      expect((await uploader.step()).status).toBe('acknowledged');
      const receipt = await store.db.outbox.get(`receipt:${saved.id}`);
      const earlier = await applyFrozen(oldSnapshot);
      expect(earlier.generation).toBe(receipt.syncPosition.generation);
      expect(BigInt(earlier.seq)).toBeLessThan(BigInt(receipt.syncPosition.seq));
      expect((await store.get(saved.id)).title).toBe(saved.title);
      // Inject a purge only into this test's unique database. There is no claim
      // that a user-facing permanent-delete endpoint has been implemented.
      await userTransaction(pool, a.user.id, a.session.id, async (client) => {
        await client.query('INSERT INTO entry_tombstones(user_id,entry_id,final_revision) VALUES($1,$2,2)', [a.user.id, saved.id]);
        await client.query('DELETE FROM entries WHERE user_id=$1 AND id=$2', [a.user.id, saved.id]);
        await appendEvent(client, a.user.id, [{ entity: 'entry', id: saved.id, action: 'purge', revision: '2' }]);
      });
      const later = await applyFrozen(await createFrozen());
      expect(BigInt(later.seq)).toBeGreaterThan(BigInt(receipt.syncPosition.seq));
      expect(await store.get(saved.id)).toBeUndefined(); expect(await store.draft(saved.id)).toBeUndefined();
      expect((await store.exportLocal()).entries[0].title).toBe(saved.title);
    } finally { await store.db.delete(); }
  });
  it('uploads durable local work, replays a lost receipt and preserves an edit made during upload', async () => {
    const a = await user(), store = createLocalStore(`user:${a.user.id}`);
    try {
      const first = await store.save({ ...makeDraft({ kind: 'moment' }), title: '上传第一版', tags: [{ name: '生活' }, { name: '心情' }] });
      let loseResponse = true, firstMutation;
      const uploader = createSyncUploader({ queue: store.uploadQueue, isCurrent: () => true, request: async (path, options) => {
        const sent = options.body.mutations[0];
        const response = await request(path, { ...options, token: a.accessToken }); expect(response.status).toBe(200);
        if (loseResponse) {
          firstMutation = structuredClone(sent); loseResponse = false;
          await store.save({ ...first, title: '上传期间写的第二版' });
          throw new Error('simulated lost response after server commit');
        }
        if (sent.mutationId === firstMutation.mutationId) {
          expect(sent).toEqual(firstMutation); expect(response.json.data.results[0].status).toBe('replayed');
        }
        return response.json.data;
      } });
      await expect(uploader.step()).rejects.toThrow('lost response');
      expect((await uploader.step()).status).toBe('more-local-work');
      expect((await store.draft(first.id)).title).toBe('上传期间写的第二版');
      expect((await uploader.step()).status).toBe('acknowledged');
      const serverEntry = await request(`/entries/${first.id}`, { token: a.accessToken });
      expect(serverEntry.status).toBe(200);
      expect(serverEntry.json.data).toMatchObject({ title: '上传期间写的第二版', revision: '2' });
      expect(await store.get(first.id)).toMatchObject({ title: '上传期间写的第二版', revision: '2', localRevision: 2 });
      expect((await uploader.step()).status).toBe('no-upload-work');
      await store.trash(first.id); expect((await uploader.step()).status).toBe('acknowledged');
      await store.restore(first.id); expect((await uploader.step()).status).toBe('acknowledged');
      expect((await store.draft(first.id)).title).toBe('上传期间写的第二版');
      expect(await store.get(first.id)).toMatchObject({ revision: '4', deletedAt: null });
    } finally { await store.db.delete(); }
  });
  const queue = (a, requestId = randomUUID()) => request('/sync/snapshots', { method: 'POST', token: a.accessToken, body: { requestId } });
  const status = (a, id) => request(`/sync/snapshots/${id}`, { token: a.accessToken });
  const pages = (a, id, suffix = '') => request(`/sync/snapshots/${id}/pages?limit=1${suffix}`, { token: a.accessToken });
  it('downloads a real HTTP snapshot into the client mirror without overwriting a local draft', async () => {
    const a = await user(), cloud = mutation(); await createEntry(a, cloud);
    const store = createLocalStore(`user:${a.user.id}`);
    try {
      const draft = await store.save({ ...makeDraft(), title: '不能被云端替换的本机稿' });
      const downloader = createSnapshotDownloader({ mirror: store.syncMirror, isCurrent: () => true,
        request: async (path, options = {}) => {
          const result = await request(path, { ...options, token: a.accessToken });
          if (result.status >= 400) throw Object.assign(new Error(result.json.error.message), result.json.error);
          return result.json.data;
        } });
      expect((await downloader.step()).status).toBe('waiting');
      await snapshots.runOne();
      expect((await downloader.step()).status).toBe('ready');
      const records = await store.syncMirror.records();
      expect(records.find((record) => record.entity === 'entry').value.id).toBe(cloud.entryId);
      expect(records.find((record) => record.entity === 'entry').value.title).toBe(cloud.payload.title);
      expect((await store.draft(draft.id)).title).toBe(draft.title);
      expect(await store.db.outbox.count()).toBe(1);
      const state = await store.syncMirror.state(); expect(state.request).toBeNull();
      expect((await request(`/sync/changes?cursor=${encodeURIComponent(state.active.cursor)}`, { token: a.accessToken })).status).toBe(200);
      const puller = createSyncPuller({ mirror: store.syncMirror, isCurrent: () => true, request: async (path, options = {}) => {
        const result = await request(path, { ...options, token: a.accessToken });
        if (result.status >= 400) throw Object.assign(new Error(result.json.error.message), result.json.error);
        return result.json.data;
      } });
      const changed = await request(`/entries/${cloud.entryId}`, { method: 'PUT', token: a.accessToken,
        body: mutation({ entryId: cloud.entryId, baseRevision: '1', payload: payload({ title: '另一台设备的修改' }) }) });
      expect(changed.status).toBe(200);
      expect((await puller.step()).status).toBe('idle');
      expect((await store.syncMirror.records()).find((r) => r.id === cloud.entryId).value.title).toBe('另一台设备的修改');
      expect((await store.get(cloud.entryId)).title).toBe('另一台设备的修改');
      expect((await store.list({ q: '另一台设备' })).map((entry) => entry.id)).toContain(cloud.entryId);
      await request(`/entries/${cloud.entryId}/trash`, { method: 'POST', token: a.accessToken, body: { mutationId: randomUUID(), baseRevision: '2' } });
      expect((await puller.step()).status).toBe('idle');
      expect((await store.syncMirror.records()).find((r) => r.id === cloud.entryId).value.deletedAt).not.toBeNull();
      expect((await store.list()).map((entry) => entry.id)).not.toContain(cloud.entryId);
      expect((await store.list({ state: 'trash' })).map((entry) => entry.id)).toContain(cloud.entryId);
      expect((await store.draft(draft.id)).title).toBe(draft.title);
    } finally { await store.db.delete(); }
  });
  it('materializes frozen content, includes trash, omits secrets, then hands off a real delta baseline', async () => {
    const a = await user(); const entry = mutation();
    await createEntry(a, entry);
    const trash = mutation({ payload: payload({ entryDate: '2026-09-07' }) }); await createEntry(a, trash);
    await request(`/entries/${trash.entryId}/trash`, { method: 'POST', token: a.accessToken, body: { mutationId: randomUUID(), baseRevision: '1' } });
    const requestId = randomUUID(); const job = await queue(a, requestId);
    expect(job.status).toBe(202); const id = job.json.data.snapshotId;
    expect((await pages(a, id)).status).toBe(409);
    expect((await queue(a, requestId)).json.data.snapshotId).toBe(id);
    expect(await snapshots.runOne()).toBe(true);
    expect((await status(a, id)).json.data.status).toBe('ready');
    await request(`/entries/${entry.entryId}`, { method: 'PUT', token: a.accessToken,
      body: mutation({ entryId: entry.entryId, baseRevision: '1', payload: payload({ title: '快照之后' }) }) });
    const records = []; let suffix = '', baseline;
    do {
      const result = await pages(a, id, suffix); expect(result.status).toBe(200);
      records.push(...result.json.data.records); baseline = result.json.data.baselineCursor;
      if (result.json.data.hasMore) {
        expect(baseline).toBeNull(); suffix = `&pageCursor=${encodeURIComponent(result.json.data.nextPageCursor)}`;
      } else break;
    } while (records.length < 20);
    expect(records.find((r) => r.id === entry.entryId).value.title).toBe('今天的记录');
    expect(records.find((r) => r.id === trash.entryId).value.deletedAt).not.toBeNull();
    expect(records.some((r) => r.entity === 'profile')).toBe(true);
    expect(records.some((r) => r.entity === 'settings')).toBe(true);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('password_hash'); expect(serialized).not.toContain(a.refreshToken);
    const delta = await request(`/sync/changes?cursor=${encodeURIComponent(baseline)}`, { token: a.accessToken });
    expect(delta.status).toBe(200);
    expect(delta.json.data.events[0].changes.at(-1).value.title).toBe('快照之后');
  });
  it('isolates snapshot IDs and signed page positions by user and snapshot', async () => {
    const a = await user(), b = await user(); const first = (await queue(a)).json.data.snapshotId;
    const second = (await queue(a)).json.data.snapshotId;
    await snapshots.runOne(); await snapshots.runOne();
    expect((await status(b, first)).status).toBe(404); expect((await pages(b, first)).status).toBe(404);
    const cursor = (await pages(a, first)).json.data.nextPageCursor;
    expect((await pages(a, second, `&pageCursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    expect((await pages(a, first, `&pageCursor=${encodeURIComponent(cursor + '.x')}`)).status).toBe(400);
  });
  it('expires frozen content without deleting source diary entries', async () => {
    const a = await user(); const entry = mutation(); await createEntry(a, entry);
    const id = (await queue(a)).json.data.snapshotId; await snapshots.runOne();
    await pool.query("UPDATE snapshots SET expires_at=now()-interval '1 minute' WHERE id=$1", [id]);
    expect((await status(a, id)).json.data.status).toBe('expired');
    expect((await pages(a, id)).status).toBe(410); await snapshots.expire();
    expect((await pool.query('SELECT count(*)::int AS n FROM snapshot_records WHERE snapshot_id=$1', [id])).rows[0].n).toBe(0);
    expect((await request(`/entries/${entry.entryId}`, { token: a.accessToken })).status).toBe(200);
  });
  it('reclaims an expired worker lease and does not duplicate records', async () => {
    const a = await user(); const id = (await queue(a)).json.data.snapshotId;
    await pool.query("UPDATE snapshots SET status='running',attempts=1,lease_token=$2,lease_until=now()-interval '1 minute' WHERE id=$1", [id, randomUUID()]);
    expect(await snapshots.runOne()).toBe(true);
    expect((await status(a, id)).json.data.status).toBe('ready');
    expect(await snapshots.runOne()).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM snapshot_records WHERE snapshot_id=$1', [id])).rows[0].n).toBe(2);
  });
  it('rolls back a failed materialization and retries without partial pages', async () => {
    const a = await user(); const id = (await queue(a)).json.data.snapshotId;
    await pool.query("CREATE FUNCTION test_snapshot_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$");
    await pool.query('CREATE TRIGGER test_snapshot_fail BEFORE INSERT ON snapshot_records FOR EACH ROW EXECUTE FUNCTION test_snapshot_failure()');
    try {
      await snapshots.runOne();
      expect((await status(a, id)).json.data.status).toBe('queued');
      expect((await pool.query('SELECT count(*)::int AS n FROM snapshot_records WHERE snapshot_id=$1', [id])).rows[0].n).toBe(0);
      expect((await pages(a, id)).status).toBe(409);
    } finally {
      await pool.query('DROP TRIGGER test_snapshot_fail ON snapshot_records');
      await pool.query('DROP FUNCTION test_snapshot_failure()');
    }
    await snapshots.runOne(); expect((await status(a, id)).json.data.status).toBe('ready');
  });
  it('enforces task quota but permits replay, and concurrent workers claim a job once', async () => {
    const a = await user(), requestId = randomUUID();
    const first = await queue(a, requestId); await queue(a); await queue(a);
    expect((await queue(a)).status).toBe(429);
    expect((await queue(a, requestId)).json.data.snapshotId).toBe(first.json.data.snapshotId);
    await Promise.all([snapshots.runOne(), snapshots.runOne()]); await snapshots.runOne();
    // Repeatable-read serialization can retry when two jobs of the same user race.
    for (let remaining = 9; remaining > 0 && await snapshots.runOne(); remaining--) { /* Bounded retries. */ }
    const { rows } = await pool.query('SELECT status,attempts FROM snapshots WHERE user_id=$1', [a.user.id]);
    expect(rows.every((job) => job.status === 'ready' && job.attempts >= 1 && job.attempts <= 3)).toBe(true);
    expect((await status(a, first.json.data.snapshotId)).json.data.status).toBe('ready');
  });
});

describe('incremental synchronization with real PostgreSQL', () => {
  async function start(account, options) {
    const service = createSync(pool, createAuth(pool, config), options);
    const { rows: [state] } = await pool.query('SELECT * FROM sync_state WHERE user_id=$1', [account.user.id]);
    return { service, cursor: service.baseline(account.user.id, state.generation, state.last_seq) };
  }
  const page = (account, cursor, limit = 50) => request(`/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, { token: account.accessToken });
  it('downloads whole entry/tag transactions and fixes the upper bound while new writes arrive', async () => {
    const a = await user(); const { cursor } = await start(a);
    const first = await createEntry(a); expect(first.status).toBe(201);
    await createEntry(a, mutation({ payload: payload({ entryDate: '2026-09-09' }) }));
    const p1 = await page(a, cursor, 1); expect(p1.status).toBe(200);
    expect(p1.json.data.events[0].changes.map((c) => c.entity)).toEqual(['tag', 'entry']);
    expect(p1.json.data.hasMore).toBe(true);
    await createEntry(a, mutation({ payload: payload({ entryDate: '2026-09-10' }) }));
    const p2 = await page(a, p1.json.data.nextCursor, 1);
    expect(p2.json.data.hasMore).toBe(false); expect(p2.json.data.events[0].seq).toBe('2');
    const p3 = await page(a, p2.json.data.nextCursor, 1);
    expect(p3.json.data.events[0].seq).toBe('3');
    expect(p3.headers.get('cache-control')).toBe('no-store');
    expect((await page(a, cursor, 1)).json.data.events).toEqual(p1.json.data.events);
  });
  it('rejects missing identity, altered signatures, extra token segments and another account', async () => {
    const a = await user(), b = await user(); const { cursor } = await start(a);
    expect((await request(`/sync/changes?cursor=${cursor}`)).status).toBe(401);
    for (const broken of [`${cursor}x`, `${cursor}.extra`]) expect((await page(a, broken)).status).toBe(400);
    expect((await page(b, cursor)).status).toBe(400);
  });
  it('requires resnapshot after data generation changes or a missing event', async () => {
    const a = await user(); const { cursor } = await start(a);
    await createEntry(a);
    await pool.query('DELETE FROM sync_events WHERE user_id=$1', [a.user.id]);
    expect((await page(a, cursor)).json.error.code).toBe('SYNC_CURSOR_EXPIRED');
    await pool.query('UPDATE sync_state SET generation=$2 WHERE user_id=$1', [a.user.id, randomUUID()]);
    expect((await page(a, cursor)).status).toBe(410);
  });
  it('expires old signed cursors and returns a bounded resnapshot event for oversized transactions', async () => {
    const a = await user();
    const old = await start(a, { now: () => Date.now() - 91 * 86400000 });
    expect((await page(a, old.cursor)).status).toBe(410);
    const current = await start(a, { maxEventBytes: 1 }); await createEntry(a);
    const result = await current.service.changes({ userId: a.user.id, sessionId: a.session.id }, { cursor: current.cursor });
    expect(result.events).toEqual([{ seq: '1', type: 'resnapshot_required' }]);
  });
});
async function reauth(account, scope, extra = {}) {
  const response = await request('/auth/reauth', { method: 'POST', token: account.accessToken, body: { password: account.password, scope, ...extra } });
  expect(response.status).toBe(200);
  return response.json.data.reauthToken;
}

function webJar() {
  const cookies = new Map();
  const headers = () => ({ Origin: config.webOrigin, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') });
  async function send(path, options = {}) {
    const result = await request(path, { ...options, headers: { ...headers(), ...options.headers } });
    for (const cookie of result.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return result;
  }
  async function post(path, options = {}) {
    const csrf = await send('/auth/csrf');
    return send(path, { ...options, method: 'POST', headers: { 'X-CSRF-Token': csrf.json.data.csrfToken, ...options.headers } });
  }
  return { cookies, send, post };
}

describe('auth context and recovery regression', () => {
  it('allows the dedicated device-unlock password check without OTP or a target record', async () => {
    const account = await user();
    const accepted = await request('/auth/reauth', { method: 'POST', token: account.accessToken,
      body: { password: account.password, scope: 'unlock_device' } });
    expect(accepted.status).toBe(200); expect(accepted.json.data.reauthToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rejected = await request('/auth/reauth', { method: 'POST', token: account.accessToken,
      body: { password: 'wrong-password-that-is-long', scope: 'unlock_device' } });
    expect(rejected.status).toBe(403); expect(rejected.json.error.code).toBe('REAUTH_FAILED');
  });
  it('reuses valid CSRF and rejects stale headers against a real updated cookie jar', async () => {
    const jar = webJar();
    const first = await jar.send('/auth/csrf'), second = await jar.send('/auth/csrf');
    expect(second.json.data.csrfToken).toBe(first.json.data.csrfToken);
    expect(second.headers.getSetCookie()).toHaveLength(0);
    const registered = await jar.post('/auth/register', { body: { username: `web_${randomUUID().slice(0, 16)}`, password: 'cookie-jar-password-2026!', device: device('web') } });
    expect(registered.status).toBe(201);
    expect(jar.cookies.get('diary_csrf')).not.toBe(first.json.data.csrfToken);
    const stale = await jar.send('/auth/refresh', { method: 'POST', headers: { 'X-CSRF-Token': first.json.data.csrfToken } });
    expect(stale.status).toBe(403); expect(stale.json.error.code).toBe('CSRF_INVALID');
    expect((await jar.post('/auth/refresh')).status).toBe(200);
    jar.cookies.set('diary_csrf', 'tampered');
    expect((await jar.send('/auth/csrf')).json.data.csrfToken).not.toBe('tampered');
  });
  it('never lets an old tab clear a new account or same-account new-session cookie', async () => {
    const a = await user(), b = await user(), jar = webJar();
    const webLogin = (account) => jar.post('/auth/login', { body: { username: account.username, password: account.password, device: device('web') } });
    const first = await webLogin(a), second = await webLogin(b);
    const rejected = await jar.post('/auth/logout', { token: first.json.data.accessToken });
    expect(rejected.status).toBe(409); expect(rejected.json.error.code).toBe('BROWSER_SESSION_CHANGED');
    expect(rejected.headers.getSetCookie()).toHaveLength(0);
    expect((await request('/me', { token: first.json.data.accessToken })).status).toBe(200);
    expect((await request('/me', { token: second.json.data.accessToken })).status).toBe(200);
    const third = await webLogin(b);
    expect((await jar.post('/auth/logout', { token: second.json.data.accessToken })).status).toBe(409);
    expect((await jar.post('/auth/logout', { token: third.json.data.accessToken })).status).toBe(204);
  });
  it('keeps native logout entirely separate from Web cookies', async () => {
    const a = await user();
    const logout = await request('/auth/logout', { method: 'POST', token: a.accessToken });
    expect(logout.status).toBe(204); expect(logout.headers.getSetCookie()).toHaveLength(0);
  });
  it('rejects cross-channel refresh including consumed tokens without revoking the correct channel', async () => {
    const a = await user(), jar = webJar();
    await jar.post('/auth/login', { body: { username: a.username, password: a.password, device: device('web') } });
    const webToken = jar.cookies.get('diary_refresh');
    expect((await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: webToken } })).status).toBe(401);
    expect((await jar.post('/auth/refresh')).status).toBe(200);
    const next = await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: a.refreshToken } });
    jar.cookies.set('diary_refresh', a.refreshToken);
    expect((await jar.post('/auth/refresh')).status).toBe(401);
    const stillValid = await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: next.json.data.refreshToken } });
    expect(stillValid.status).toBe(200); expect(stillValid.headers.getSetCookie()).toHaveLength(0);
  });
  it('limits first recovery generation to the recent registration session, not a recent login', async () => {
    const a = await user();
    const login = await request('/auth/native/login', { method: 'POST', body: { username: a.username, password: a.password, device: device() } });
    const issue = (token) => request('/security/recovery-code', { method: 'POST', token, body: { requestId: randomUUID() } });
    expect((await issue(login.json.data.accessToken)).status).toBe(403);
    const refreshed = await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: a.refreshToken } });
    expect((await issue(refreshed.json.data.accessToken)).status).toBe(200);
    expect((await issue(refreshed.json.data.accessToken)).status).toBe(403);
    const b = await user();
    await pool.query("UPDATE sessions SET created_at=now()-interval '6 minutes' WHERE id=$1", [b.session.id]);
    expect((await issue(b.accessToken)).status).toBe(403);
  });
  it('returns actual recovery status from all profile and session responses', async () => {
    const a = await user(); expect(a.user.recoveryCodeConfigured).toBe(false);
    const issued = await request('/security/recovery-code', { method: 'POST', token: a.accessToken, body: { requestId: randomUUID() } });
    expect((await request('/me', { token: a.accessToken })).json.data.recoveryCodeConfigured).toBe(true);
    expect((await request('/me', { method: 'PATCH', token: a.accessToken, body: { displayName: '恢复码已设置', baseRevision: '1' } })).json.data.recoveryCodeConfigured).toBe(true);
    const loginBody = { username: a.username, password: a.password, device: device() };
    expect((await request('/auth/native/login', { method: 'POST', body: loginBody })).json.data.user.recoveryCodeConfigured).toBe(true);
    expect((await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: a.refreshToken } })).json.data.user.recoveryCodeConfigured).toBe(true);
    expect((await request('/auth/password-reset', { method: 'POST', body: { username: a.username, recoveryCode: issued.json.data.recoveryCode, newPassword: a.password } })).status).toBe(200);
    expect((await request('/auth/native/login', { method: 'POST', body: loginBody })).json.data.user.recoveryCodeConfigured).toBe(false);
  });
  it('replays revoke-others receipts without revoking sessions created after the first operation', async () => {
    const a = await user();
    const login = () => request('/auth/native/login', { method: 'POST', body: { username: a.username, password: a.password, device: device() } });
    const other = await login(), token = await reauth(a, 'revoke_others');
    const body = { reauthToken: token, requestId: randomUUID() };
    const perform = () => request('/sessions/revoke-others', { method: 'POST', token: a.accessToken, body });
    expect((await Promise.all([perform(), perform()])).map((result) => result.status)).toEqual([204, 204]);
    expect((await request('/me', { token: other.json.data.accessToken })).status).toBe(401);
    const later = await login();
    expect((await perform()).status).toBe(204);
    expect((await request('/me', { token: later.json.data.accessToken })).status).toBe(200);
    expect((await request('/me', { token: a.accessToken })).status).toBe(200);
    expect((await request('/sessions/revoke-others', { method: 'POST', token: a.accessToken, body: { ...body, requestId: randomUUID() } })).status).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM auth_operation_receipts WHERE request_id=$1', [body.requestId])).rows[0].n).toBe(1);
  });
  it('immediately disables an account and completes private-data cleanup behind an opaque receipt', async () => {
    const account = await user(), other = await request('/auth/native/login', { method: 'POST', body: { username: account.username, password: account.password, device: device() } });
    await createEntry(account);
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    const assetId = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
    const registered = await request('/assets/uploads', { method: 'POST', token: account.accessToken,
      body: { requestId: randomUUID(), assetId, mimeType: 'image/png', size: bytes.length, sha256 } });
    await fetch(origin.replace(/\/api\/v1$/, '') + registered.json.data.uploadUrl, { method: 'PUT', headers: registered.json.data.headers, body: bytes });
    await request(`/assets/${assetId}/complete`, { method: 'POST', token: account.accessToken, body: { requestId: randomUUID() } });
    const exported = await request('/exports', { method: 'POST', token: account.accessToken, body: { requestId: randomUUID(), format: 'json_zip', includeImages: false } });
    await exportWorker.runOne();
    const deletionId = randomUUID(), requestId = randomUUID(), receiptToken = randomBytes(32).toString('base64url');
    const token = await reauth(account, 'delete_account');
    const deletion = await request('/account-deletions', { method: 'POST', token: account.accessToken,
      body: { deletionId, requestId, receiptToken, reauthToken: token, confirmed: true } });
    expect(deletion.status).toBe(202); expect(deletion.json.data).toMatchObject({ deletionId, status: 'requested', receiptToken });
    expect((await request('/me', { token: account.accessToken })).status).toBe(401);
    expect((await request('/me', { token: other.json.data.accessToken })).status).toBe(401);
    expect((await request('/auth/native/login', { method: 'POST', body: { username: account.username, password: account.password, device: device() } })).status).toBe(401);
    expect((await request(`/account-deletions/${deletionId}`, { headers: { 'X-Deletion-Receipt': randomBytes(32).toString('base64url') } })).status).toBe(404);
    expect(await accountDeletions.runOne()).toBe(true);
    const receiptResult = await request(`/account-deletions/${deletionId}`, { headers: { 'X-Deletion-Receipt': receiptToken } });
    expect(receiptResult.status).toBe(200); expect(receiptResult.json.data.status).toBe('completed');
    expect(JSON.stringify(receiptResult.json)).not.toContain(account.username);
    for (const table of ['users', 'entries', 'assets', 'export_jobs', 'sessions', 'sync_state']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'}=$1`, [account.user.id])).rows[0].n).toBe(0);
    }
    expect(imageFiles.has(`source/${assetId}.bin`)).toBe(false);
    expect([...imageFiles.keys()].some((key) => key.includes(assetId))).toBe(false);
    expect((await pool.query('SELECT user_id FROM account_deletions WHERE id=$1', [deletionId])).rows[0].user_id).toBeNull();
    expect((await pool.query('SELECT deletion_id,status,completed_at FROM account_deletion_ledger WHERE user_id=$1', [account.user.id])).rows[0]).toMatchObject({ deletion_id: deletionId, status: 'completed', completed_at: expect.any(Date) });
    await pool.query('INSERT INTO users(id,username_normalized,display_name,password_hash,status) VALUES($1,$2,$3,$4,$5)', [account.user.id, `restored_${randomUUID().slice(0, 12)}`, '不应复活', 'restored-backup-hash', 'active']);
    await pool.query('INSERT INTO sync_state(user_id,generation) VALUES($1,$2)', [account.user.id, randomUUID()]);
    await pool.query(`INSERT INTO entries(id,user_id,kind,entry_date,timezone,title,content_schema_version,content,plain_text,sort_at)
      VALUES($1,$2,'daily','2026-09-09','Asia/Shanghai','旧备份复活日记',1,'{"type":"doc","content":[]}','不应重新上线',now())`, [randomUUID(), account.user.id]);
    expect(await accountDeletions.reconcileLedger()).toBe(1);
    expect((await pool.query('SELECT status FROM users WHERE id=$1', [account.user.id])).rows[0].status).toBe('deleting');
    expect(await accountDeletions.runOne()).toBe(true);
    expect((await pool.query('SELECT id FROM users WHERE id=$1', [account.user.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT user_id FROM account_deletion_ledger WHERE user_id=$1', [account.user.id])).rowCount).toBe(1);
    expect(exported.json.data.jobId).toBeTruthy();
  });
});

describe('real PostgreSQL authentication and isolation', () => {
  it('stores Argon2id hashes, normalizes usernames and keeps Chinese out of headers', async () => {
    const name = `CASE_${randomUUID().slice(0, 15)}`;
    const account = await user({ username: ` ${name} `, password: '🌿'.repeat(12) + ' ' });
    const { rows: [row] } = await pool.query('SELECT username_normalized,password_hash FROM users WHERE id=$1', [account.user.id]);
    expect(row.username_normalized).toBe(name.toLowerCase());
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(account.password);
    const duplicate = await request('/auth/native/register', { method: 'POST', body: { username: name.toLowerCase(), password: account.password, device: device() } });
    expect(duplicate.status).toBe(409);
    const renamed = await request('/me', { method: 'PATCH', token: account.accessToken, body: { displayName: '中文昵称', baseRevision: '1' } });
    expect(renamed.status).toBe(200);
    expect(renamed.json.data.displayName).toBe('中文昵称');
    expect(renamed.json.data.revision).toBe('2');
  });
  it('does not trim passwords and unifies missing-user/wrong-password errors', async () => {
    const account = await user({ password: 'a-long-password-with-space ' });
    const wrong = await request('/auth/native/login', { method: 'POST', body: { username: account.username, password: account.password.trim(), device: device() } });
    const missing = await request('/auth/native/login', { method: 'POST', body: { username: `no_${randomUUID().slice(0, 18)}`, password: account.password, device: device() } });
    expect(wrong.status).toBe(401); expect(missing.status).toBe(401);
    expect(wrong.json.error).toEqual(missing.json.error);
    expect(wrong.headers.get('cache-control')).toBe('no-store');
  });
  it('requires Web CSRF, leaves refresh tokens out of JSON and clears logout cookies', async () => {
    const bootstrap = await request('/auth/csrf');
    const csrf = bootstrap.json.data.csrfToken;
    const csrfCookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
    const body = { username: `web_${randomUUID().slice(0, 16)}`, password: 'web-diary-password-2026!', device: device('web') };
    expect((await request('/auth/register', { method: 'POST', body })).status).toBe(403);
    expect((await request('/auth/register', { method: 'POST', body, headers: { Origin: 'https://attacker.invalid', Cookie: csrfCookie, 'X-CSRF-Token': csrf } })).status).toBe(403);
    const register = await request('/auth/register', { method: 'POST', body, headers: { Origin: config.webOrigin, Cookie: csrfCookie, 'X-CSRF-Token': csrf } });
    expect(register.status).toBe(201);
    expect(register.json.data.refreshToken).toBeUndefined();
    const refreshCookie = register.headers.getSetCookie()[0];
    expect(refreshCookie).toContain('HttpOnly'); expect(refreshCookie).toContain('SameSite=Strict');
    const cookie = `${csrfCookie}; ${refreshCookie.split(';')[0]}`;
    const refreshed = await request('/auth/refresh', { method: 'POST', headers: { Origin: config.webOrigin, Cookie: cookie, 'X-CSRF-Token': csrf } });
    expect(refreshed.status).toBe(200);
    const logout = await request('/auth/logout', { method: 'POST', token: refreshed.json.data.accessToken, headers: { Origin: config.webOrigin, Cookie: cookie, 'X-CSRF-Token': csrf } });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect((await request('/me', { token: refreshed.json.data.accessToken })).status).toBe(401);
  });
  it('rotates refresh credentials and revokes the whole session on old-token reuse', async () => {
    const account = await user();
    const next = await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: account.refreshToken } });
    expect(next.status).toBe(200);
    expect(next.json.data.refreshToken).not.toBe(account.refreshToken);
    expect(next.headers.getSetCookie()).toHaveLength(0);
    const replay = await request('/auth/native/refresh', { method: 'POST', body: { refreshToken: account.refreshToken } });
    expect(replay.status).toBe(401);
    expect((await request('/me', { token: next.json.data.accessToken })).status).toBe(401);
  });
  it('checks JWT signature, issuer and audience', async () => {
    const account = await user();
    const forged = await new SignJWT({ sid: account.session.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(account.user.id).setIssuer('other-api').setAudience('diary-client').setExpirationTime('1h').sign(new TextEncoder().encode(config.secret));
    expect((await request('/me', { token: forged })).status).toBe(401);
    expect((await request('/me', { token: account.accessToken.slice(0, -5) + 'aaaaa' })).status).toBe(401);
  });
  it('scopes reauth tokens and revokes all sessions when the password changes', async () => {
    const account = await user();
    const other = await request('/auth/native/login', { method: 'POST', body: { username: account.username, password: account.password, device: device() } });
    const wrongScope = await reauth(account, 'rotate_recovery_code');
    expect((await request('/security/password', { method: 'POST', token: account.accessToken, body: { newPassword: 'new-password-for-diary!', reauthToken: wrongScope, requestId: randomUUID() } })).status).toBe(403);
    const token = await reauth(account, 'change_password');
    const changed = await request('/security/password', { method: 'POST', token: account.accessToken, body: { newPassword: 'new-password-for-diary!', reauthToken: token, requestId: randomUUID() } });
    expect(changed.status).toBe(200);
    expect((await request('/me', { token: account.accessToken })).status).toBe(401);
    expect((await request('/me', { token: other.json.data.accessToken })).status).toBe(401);
    expect((await request('/auth/native/login', { method: 'POST', body: { username: account.username, password: 'new-password-for-diary!', device: device() } })).status).toBe(200);
  });
  it('consumes recovery codes once under concurrent resets and stores only a digest', async () => {
    const account = await user();
    const issued = await request('/security/recovery-code', { method: 'POST', token: account.accessToken, body: { requestId: randomUUID() } });
    expect(issued.status).toBe(200);
    const code = issued.json.data.recoveryCode;
    const { rows: [stored] } = await pool.query('SELECT code_digest FROM recovery_codes WHERE user_id=$1', [account.user.id]);
    expect(stored.code_digest).not.toContain(code.replaceAll('-', '').toLowerCase());
    const body = { username: account.username, recoveryCode: code, newPassword: 'reset-diary-password-2026!' };
    const results = await Promise.all([request('/auth/password-reset', { method: 'POST', body }), request('/auth/password-reset', { method: 'POST', body })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect((await request('/me', { token: account.accessToken })).status).toBe(401);
  });
  it('requires account ownership and a scoped credential for remote session revocation', async () => {
    const account = await user(), stranger = await user();
    const login = await request('/auth/native/login', { method: 'POST', body: { username: account.username, password: account.password, device: device() } });
    expect((await request(`/sessions/${account.session.id}`, { method: 'DELETE', token: stranger.accessToken })).status).toBe(404);
    const token = await reauth(account, 'revoke_session', { targetId: login.json.data.session.id });
    expect((await request(`/sessions/${login.json.data.session.id}`, { method: 'DELETE', token: account.accessToken, headers: { 'X-Reauth-Token': token } })).status).toBe(204);
    expect((await request('/me', { token: login.json.data.accessToken })).status).toBe(401);
    expect((await request('/me', { token: account.accessToken })).status).toBe(200);
  });
  it('returns safe malformed-JSON errors without echoing request secrets', async () => {
    const result = await request('/auth/native/login', { method: 'POST', raw: '{"password":"do-not-echo-secret",' });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).not.toContain('do-not-echo-secret');
  });
});

describe('transactional diary API on PostgreSQL', () => {
  it('creates, reads and updates with server-derived text and string revisions', async () => {
    const account = await user();
    const created = await createEntry(account);
    expect(created.status).toBe(201);
    const entry = created.json.data.entry;
    expect(entry.revision).toBe('1'); expect(entry.entryDate).toBe('2026-09-08');
    expect(entry.plainText).toBe('你好，新的日记本。');
    expect(entry.tagIds).toHaveLength(1);
    const updated = await request(`/entries/${entry.id}`, { method: 'PUT', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '1', payload: payload({ title: '修改后' }) } });
    expect(updated.status).toBe(200); expect(updated.json.data.entry.revision).toBe('2');
    expect((await request(`/entries/${entry.id}`, { token: account.accessToken })).json.data.title).toBe('修改后');
  });
  it('reuses one normalized tag across concurrent devices and reports its active count', async () => {
    const account = await user();
    const [first, second] = await Promise.all([
      createEntry(account, mutation({ payload: payload({ kind: 'moment', entryDate: '2026-09-11', occurredAt: '2026-09-11T10:00:00Z', title: '电脑稿', tags: [{ name: 'Work' }] }) })),
      createEntry(account, mutation({ payload: payload({ kind: 'moment', entryDate: '2026-09-12', occurredAt: '2026-09-12T10:00:00Z', title: '手机稿', tags: [{ name: 'ｗｏｒｋ' }] }) })),
    ]);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    const firstTag = first.json.data.entry.tags[0], secondTag = second.json.data.entry.tags[0];
    expect(firstTag.id).toBe(secondTag.id);
    // Requests are serialized by the user transaction lock, but concurrent
    // network completion order is deliberately unspecified. Preserve the
    // original spelling that commits first and require every caller to receive
    // that one canonical row consistently.
    expect(['Work', 'ｗｏｒｋ']).toContain(firstTag.name);
    expect(secondTag.name).toBe(firstTag.name);
    const tags = await request('/tags', { token: account.accessToken });
    expect(tags.json.data.items).toEqual([{ id: firstTag.id, name: firstTag.name, revision: '1', activeEntryCount: 2 }]);
    const filtered = await request(`/entries?tagId=${firstTag.id}`, { token: account.accessToken });
    expect(new Set(filtered.json.data.items.map((entry) => entry.title))).toEqual(new Set(['电脑稿', '手机稿']));
  });
  it('rejects cross-account reads, writes and tag associations', async () => {
    const a = await user(), b = await user();
    const created = await createEntry(a); const entry = created.json.data.entry;
    expect((await request(`/entries/${entry.id}`, { token: b.accessToken })).status).toBe(404);
    expect((await request(`/entries/${entry.id}`, { method: 'PUT', token: b.accessToken, body: { mutationId: randomUUID(), baseRevision: '1', payload: payload() } })).status).toBe(404);
    const foreignTag = await createEntry(b, mutation({ payload: payload({ tags: [{ name: '不得残留的标签' }, { id: entry.tagIds[0] }] }) }));
    expect(foreignTag.status).toBe(422);
    expect((await pool.query('SELECT id FROM tags WHERE user_id=$1', [b.user.id])).rowCount).toBe(0);
    expect((await request('/entries', { token: b.accessToken })).json.data.items).toHaveLength(0);
  });
  it('rejects invalid dates, schemas, empty content and extra identity fields', async () => {
    const account = await user();
    for (const overrides of [{ entryDate: '2026-02-29' }, { contentSchemaVersion: 2 }, { title: '', content: { type: 'doc', content: [{ type: 'paragraph' }] } }, { content: { type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' } }] } }]) {
      expect((await createEntry(account, mutation({ payload: payload(overrides) }))).status).toBe(422);
    }
    expect((await createEntry(account, { ...mutation(), userId: randomUUID() })).status).toBe(422);
  });
  it('serializes concurrent daily creates and concurrent same-revision updates', async () => {
    const account = await user();
    const creates = await Promise.all([createEntry(account), createEntry(account)]);
    expect(creates.map((result) => result.status).sort()).toEqual([201, 409]);
    const entry = creates.find((result) => result.status === 201).json.data.entry;
    const updates = await Promise.all(['版本 A', '版本 B'].map((title) => request(`/entries/${entry.id}`, { method: 'PUT', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '1', payload: payload({ title }) } })));
    expect(updates.map((result) => result.status).sort()).toEqual([200, 409]);
    const { rows: [state] } = await pool.query('SELECT last_seq FROM sync_state WHERE user_id=$1', [account.user.id]);
    expect(state.last_seq).toBe('2');
  });
  it('deduplicates a committed request and rejects changed content under the same mutation ID', async () => {
    const account = await user(), body = mutation();
    const first = await createEntry(account, body), replay = await createEntry(account, body);
    expect(first.status).toBe(201); expect(replay.status).toBe(200);
    expect(replay.json.data.status).toBe('replayed');
    expect(replay.json.data.entry).toEqual(first.json.data.entry);
    const changed = await createEntry(account, { ...body, payload: payload({ title: '另一个请求' }) });
    expect(changed.status).toBe(409); expect(changed.json.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await pool.query('SELECT seq FROM sync_events WHERE user_id=$1', [account.user.id])).rowCount).toBe(1);
  });
  it('rolls back content, tags, revision, event and receipt when the final write fails', async () => {
    const account = await user(), body = mutation();
    await pool.query("CREATE FUNCTION test_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test injected failure'; END $$");
    await pool.query('CREATE TRIGGER test_fail_receipt BEFORE INSERT ON mutation_receipts FOR EACH ROW EXECUTE FUNCTION test_receipt_failure()');
    try {
      expect((await createEntry(account, body)).status).toBe(500);
      expect((await pool.query('SELECT id FROM entries WHERE user_id=$1', [account.user.id])).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM tags WHERE user_id=$1', [account.user.id])).rowCount).toBe(0);
      expect((await pool.query('SELECT seq FROM sync_events WHERE user_id=$1', [account.user.id])).rowCount).toBe(0);
      expect((await pool.query('SELECT last_seq FROM sync_state WHERE user_id=$1', [account.user.id])).rows[0].last_seq).toBe('0');
    } finally {
      await pool.query('DROP TRIGGER test_fail_receipt ON mutation_receipts');
      await pool.query('DROP FUNCTION test_receipt_failure()');
    }
    expect((await createEntry(account, body)).status).toBe(201);
  });
  it('does not resurrect deleted entries and keeps restore conflicts recoverable', async () => {
    const account = await user();
    const original = (await createEntry(account)).json.data.entry;
    const trash = await request(`/entries/${original.id}/trash`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '1' } });
    expect(trash.status).toBe(200); expect(trash.json.data.entry.purgeAfter).not.toBeNull();
    expect((await request(`/entries/${original.id}`, { method: 'PUT', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '2', payload: payload() } })).json.error.code).toBe('ENTRY_TRASHED');
    const replacement = (await createEntry(account)).json.data.entry;
    const restore = await request(`/entries/${original.id}/restore`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '2' } });
    expect(restore.status).toBe(409); expect(restore.json.error.details.existingEntryId).toBe(replacement.id);
    expect((await request('/entries?state=trash', { token: account.accessToken })).json.data.items).toHaveLength(1);
    const asMoment = await request(`/entries/${original.id}/restore`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '2', payload: { kind: 'moment', occurredAt: '2026-09-08T12:00:00Z' } } });
    expect(asMoment.status).toBe(200); expect(asMoment.json.data.entry.kind).toBe('moment');
  });
  it('permanently deletes only a reauthenticated trash revision and safely replays the receipt', async () => {
    const account = await user(), created = (await createEntry(account)).json.data.entry;
    const exportJob = await request('/exports', { method: 'POST', token: account.accessToken,
      body: { requestId: randomUUID(), format: 'json_zip', entryIds: [created.id], includeImages: false } });
    let exportStatus;
    for (let attempt = 0; attempt < 10; attempt++) {
      await exportWorker.runOne();
      exportStatus = (await request(`/exports/${exportJob.json.data.jobId}`, { token: account.accessToken })).json.data.status;
      if (exportStatus === 'ready') break;
    }
    expect(exportStatus).toBe('ready');
    const trashed = await request(`/entries/${created.id}/trash`, { method: 'POST', token: account.accessToken,
      body: { mutationId: randomUUID(), baseRevision: '1' } });
    const reauth = await request('/auth/reauth', { method: 'POST', token: account.accessToken,
      body: { password: account.password, scope: 'purge_entry', targetId: created.id } });
    expect(reauth.status).toBe(200);
    const body = { requestId: randomUUID(), baseRevision: trashed.json.data.entry.revision, reauthToken: reauth.json.data.reauthToken };
    const purged = await request(`/entries/${created.id}/purge`, { method: 'POST', token: account.accessToken, body });
    expect(purged.status).toBe(200); expect(purged.json.data).toMatchObject({ purged: [created.id] });
    const replay = await request(`/entries/${created.id}/purge`, { method: 'POST', token: account.accessToken, body });
    expect(replay.status).toBe(200); expect(replay.json.data).toMatchObject({ purged: [created.id], replayed: true });
    expect((await request(`/entries/${created.id}`, { token: account.accessToken })).status).toBe(404);
    const stale = await request(`/entries/${created.id}`, { method: 'PUT', token: account.accessToken,
      body: { mutationId: randomUUID(), baseRevision: '2', payload: payload({ title: '不得复活' }) } });
    expect(stale.status).toBe(410); expect(stale.json.error.code).toBe('ENTRY_PURGED');
    const tombstone = (await pool.query('SELECT final_revision FROM entry_tombstones WHERE user_id=$1 AND entry_id=$2', [account.user.id, created.id])).rows[0];
    expect(tombstone.final_revision).toBe('3');
    expect((await request(`/exports/${exportJob.json.data.jobId}`, { token: account.accessToken })).json.data.status).toBe('cancelled');
  });
  it('rolls back a stale purge batch and automatically expires server-timed trash', async () => {
    const account = await user();
    const first = (await createEntry(account, mutation({ payload: payload({ kind: 'moment', entryDate: '2026-09-06', occurredAt: '2026-09-06T12:00:00Z' }) }))).json.data.entry;
    const second = (await createEntry(account, mutation({ payload: payload({ kind: 'moment', entryDate: '2026-09-07', occurredAt: '2026-09-07T12:00:00Z' }) }))).json.data.entry;
    for (const entry of [first, second]) await request(`/entries/${entry.id}/trash`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '1' } });
    const reauth = await request('/auth/reauth', { method: 'POST', token: account.accessToken,
      body: { password: account.password, scope: 'purge_entries', targetIds: [second.id, first.id] } });
    const restored = await request(`/entries/${second.id}/restore`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '2' } });
    const retrash = await request(`/entries/${second.id}/trash`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: restored.json.data.entry.revision } });
    const requestId = randomUUID();
    const stale = await request('/entries/purge-batch', { method: 'POST', token: account.accessToken, body: { requestId,
      entries: [{ id: first.id, baseRevision: '2' }, { id: second.id, baseRevision: '2' }], reauthToken: reauth.json.data.reauthToken } });
    expect(stale.status).toBe(409); expect(stale.json.error.code).toBe('REVISION_CONFLICT');
    expect((await pool.query('SELECT id FROM entries WHERE user_id=$1 AND id=ANY($2::uuid[])', [account.user.id, [first.id, second.id]])).rowCount).toBe(2);
    const success = await request('/entries/purge-batch', { method: 'POST', token: account.accessToken, body: { requestId,
      entries: [{ id: first.id, baseRevision: '2' }, { id: second.id, baseRevision: retrash.json.data.entry.revision }], reauthToken: reauth.json.data.reauthToken } });
    expect(success.status).toBe(200); expect(new Set(success.json.data.purged)).toEqual(new Set([first.id, second.id]));

    const expiring = (await createEntry(account, mutation({ payload: payload({ kind: 'moment', entryDate: '2026-09-05', occurredAt: '2026-09-05T12:00:00Z' }) }))).json.data.entry;
    await request(`/entries/${expiring.id}/trash`, { method: 'POST', token: account.accessToken, body: { mutationId: randomUUID(), baseRevision: '1' } });
    await pool.query("UPDATE entries SET purge_after=now()-interval '1 second' WHERE id=$1", [expiring.id]);
    expect(await entryPurge.expire()).toBe(1);
    expect((await pool.query('SELECT id FROM entries WHERE id=$1', [expiring.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT entry_id FROM entry_tombstones WHERE user_id=$1 AND entry_id=$2', [account.user.id, expiring.id])).rowCount).toBe(1);
  });
  it('paginates with signed user/filter-bound cursors and literal wildcard searches', async () => {
    const account = await user(), other = await user();
    for (let n = 1; n <= 3; n++) await createEntry(account, mutation({ payload: payload({ entryDate: `2026-09-0${n}`, title: n === 1 ? '进步 10%' : `第 ${n} 天` }) }));
    const first = await request('/entries?limit=2', { token: account.accessToken });
    expect(first.json.data.items).toHaveLength(2); expect(first.json.data.hasMore).toBe(true);
    const cursor = encodeURIComponent(first.json.data.nextCursor);
    const second = await request(`/entries?limit=2&cursor=${cursor}`, { token: account.accessToken });
    expect(second.json.data.items).toHaveLength(1);
    expect(new Set([...first.json.data.items, ...second.json.data.items].map((entry) => entry.id)).size).toBe(3);
    expect((await request(`/entries?limit=2&cursor=${cursor}`, { token: other.accessToken })).status).toBe(400);
    expect((await request(`/entries?kind=moment&cursor=${cursor}`, { token: account.accessToken })).status).toBe(400);
    expect((await request('/entries?q=%25', { token: account.accessToken })).json.data.items).toHaveLength(1);
    expect((await request('/entries?q=%25%E7%AC%AC%25', { token: account.accessToken })).json.data.items).toHaveLength(0);
  });
  it('preserves data through re-running migrations and returns correct calendar/statistics', async () => {
    const account = await user(); await createEntry(account);
    await createEntry(account, mutation({ payload: payload({ kind: 'moment', occurredAt: '2026-09-08T20:00:00Z', mood: 2 }) }));
    await migrate(pool);
    const calendar = await request('/calendar?month=2026-09', { token: account.accessToken });
    expect(calendar.json.data.days).toHaveLength(1);
    expect(calendar.json.data.days[0]).toMatchObject({ totalCount: 2, momentCount: 1, mood: 4 });
    const stats = await request('/stats', { token: account.accessToken });
    expect(stats.json.data).toEqual({ entries: 2, days: 1 });
    expect((await pool.query('SELECT name FROM _diary_migrations ORDER BY name')).rows.map((row) => row.name)).toEqual(['001_core.sql', '002_auth_context.sql', '003_sync_snapshots.sql', '004_export_jobs.sql', '005_export_snapshot.sql', '006_export_worker.sql', '007_assets.sql', '008_entry_assets.sql', '009_asset_cleanup.sql', '010_account_deletions.sql', '011_entry_purge_receipts.sql', '012_account_deletion_ledger.sql', '013_tasks.sql', '014_vault.sql', '015_vault_recovery.sql', '016_vault_key_rotation.sql']);
  });
});
