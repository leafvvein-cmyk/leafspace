import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { makeDraft, contentText } from '../../packages/contracts/src/entry.js';

const databases = [];
function space() { const store = createLocalStore(`test-${crypto.randomUUID()}`); databases.push(store.db); return store; }
function draft(options = {}) { return { ...makeDraft({ entryDate: '2026-09-08', ...options }), title: '我的一天' }; }
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });

describe('durable local diary repository', () => {
  it('keeps private image bytes across reopening and rejects asset id reuse', async () => {
    const store = space(), entryId = crypto.randomUUID(), id = crypto.randomUUID();
    const asset = { id, entryId, mimeType: 'image/webp', size: 4, sha256: 'a'.repeat(64), width: 2, height: 2, createdAt: new Date().toISOString(), bytes: new Uint8Array([1, 2, 3, 4]) };
    await store.saveAsset(asset);
    store.db.close(); await store.db.open();
    expect(Array.from((await store.getAsset(id)).bytes)).toEqual([1, 2, 3, 4]);
    expect(await store.listAssets(entryId)).toHaveLength(1);
    await expect(store.saveAsset({ ...asset, entryId: crypto.randomUUID() })).rejects.toThrow('另一份内容');
  });
  it('uploads referenced images and lets text sync before a pending image without duplicate text mutations', async () => {
    const store = createLocalStore(`user:${crypto.randomUUID()}`); databases.push(store.db);
    const entryId = crypto.randomUUID(), id = crypto.randomUUID();
    const asset = { id, entryId, mimeType: 'image/webp', size: 1, sha256: 'd'.repeat(64), width: 1, height: 1, createdAt: new Date().toISOString(), bytes: new Uint8Array([1]) };
    await store.saveAsset(asset); expect(await store.nextAssetUpload()).toBeUndefined();
    const entry = await store.save({ ...draft(), id: entryId, content: { type: 'doc', content: [{ type: 'image', attrs: { assetId: id, alt: '', caption: '' } }] } });
    expect((await store.nextAssetUpload()).id).toBe(id);
    const textJob = await store.uploadQueue.next();
    expect(textJob).toMatchObject({ entryId: entry.id, pendingAssets: 1, mutation: { baseRevision: '0', operation: 'upsert' } });
    expect(textJob.mutation.payload.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    const cloudText = { ...textJob.snapshot, ...textJob.mutation.payload, revision: '1', localRevision: 0, updatedAt: new Date().toISOString() };
    await store.uploadQueue.complete(textJob.mutation.mutationId,
      { mutationId: textJob.mutation.mutationId, status: 'applied', entry: cloudText });
    expect(await store.uploadQueue.next()).toBeNull();
    await store.completeAssetUpload(id, { width: 1, height: 1 });
    const fullJob = await store.uploadQueue.next();
    expect(fullJob).toMatchObject({ entryId: entry.id, pendingAssets: 0, mutation: { baseRevision: '1', operation: 'upsert' } });
    expect(contentText(fullJob.mutation.payload.content)).toBe('');
    expect(fullJob.mutation.payload.content.content[0]).toMatchObject({ type: 'image', attrs: { assetId: id } });
  });
  it('stops silent image retries after three failures and exposes a safe manual retry', async () => {
    const store = createLocalStore(`user:${crypto.randomUUID()}`); databases.push(store.db);
    const entryId = crypto.randomUUID(), id = crypto.randomUUID();
    await store.saveAsset({ id, entryId, mimeType: 'image/webp', size: 1, sha256: 'e'.repeat(64), width: 1, height: 1,
      createdAt: new Date().toISOString(), bytes: new Uint8Array([1]) });
    await store.save({ ...draft(), id: entryId, content: { type: 'doc', content: [{ type: 'image', attrs: { assetId: id, alt: '', caption: '' } }] } });
    for (let attempt = 0; attempt < 3; attempt++) await store.recordAssetUploadFailure(id,
      Object.assign(new Error('secret ticket must never persist'), { code: 'NETWORK_UNAVAILABLE' }));
    expect(await store.nextAssetUpload()).toBeUndefined();
    const [problem] = await store.listAssetProblems();
    expect(problem).toMatchObject({ id, entryId, status: 'error', uploadAttempts: 3,
      error: { code: 'NETWORK_UNAVAILABLE', message: '图片上传未完成，请检查网络后重试。' } });
    expect(problem).not.toHaveProperty('bytes');
    expect(JSON.stringify(problem)).not.toContain('secret ticket');
    await store.retryAssetUpload(id);
    expect(await store.listAssetProblems()).toEqual([]);
    expect(await store.nextAssetUpload()).toMatchObject({ id, status: 'local-only', uploadAttempts: 0, error: null });
  });
  it('clears only redownloadable remote image cache and preserves local originals', async () => {
    const store = space(), entryId = crypto.randomUUID(), cachedId = crypto.randomUUID(), localId = crypto.randomUUID();
    const base = { entryId, mimeType: 'image/webp', size: 2, width: 1, height: 1, createdAt: new Date().toISOString(), bytes: new Uint8Array([1, 2]) };
    await store.saveAsset({ ...base, id: cachedId, sha256: '1'.repeat(64), status: 'ready', cacheSource: 'remote' });
    await store.saveAsset({ ...base, id: localId, sha256: '2'.repeat(64), status: 'local-only' });
    expect(await store.storageSummary()).toEqual({ cacheCount: 1, cacheBytes: 2, protectedCount: 1, protectedBytes: 2 });
    expect(await store.clearDownloadedAssetCache()).toEqual({ clearedCount: 1, clearedBytes: 2 });
    expect(await store.getAsset(cachedId)).toBeUndefined();
    expect(await store.getAsset(localId)).toMatchObject({ id: localId, status: 'local-only' });
  });
  it('keeps a blank draft without creating a diary or upload marker', async () => {
    const store = space();
    const entry = makeDraft();
    await store.save(entry);
    expect(await store.list()).toHaveLength(0);
    expect(await store.db.outbox.count()).toBe(0);
    expect((await store.draft(entry.id)).id).toBe(entry.id);
  });
  it('persists records, drafts and pending markers together across reopening', async () => {
    const store = space();
    const entry = await store.save(draft());
    store.db.close(); await store.db.open();
    expect((await store.get(entry.id)).title).toBe('我的一天');
    expect((await store.draft(entry.id)).localRevision).toBe(1);
    expect((await store.db.outbox.toArray())[0].status).toBe('local-only');
  });
  it('version-checks blank drafts and preserves an old-window conflict', async () => {
    const store = space();
    const blank = await store.save(makeDraft());
    const latest = await store.save({ ...blank, mood: 5 });
    expect(latest.localRevision).toBe(2);
    await expect(store.save({ ...blank, mood: 2 })).rejects.toThrow('另一个窗口');
    expect((await store.draft(blank.id)).mood).toBe(5);
    expect(await store.db.conflicts.count()).toBe(1);
  });
  it('does not let a content-free draft compete for the daily date', async () => {
    const store = space();
    await store.save(draft());
    await store.save(makeDraft({ entryDate: '2026-09-08' }));
    expect(await store.list()).toHaveLength(1);
    expect(await store.db.conflicts.count()).toBe(0);
  });
  it('increments local revisions without claiming a server revision', async () => {
    const store = space();
    const first = await store.save(draft());
    const second = await store.save({ ...first, title: '修改后' });
    expect(second.localRevision).toBe(2);
    expect(second.revision).toBe('0');
    expect(await store.db.outbox.count()).toBe(1);
  });
  it('retains both sides when two windows edit the same version', async () => {
    const store = space();
    const first = await store.save(draft());
    const results = await Promise.allSettled([store.save({ ...first, title: '窗口 A' }), store.save({ ...first, title: '窗口 B' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const conflicts = await store.db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(new Set([conflicts[0].local.title, conflicts[0].remote.title])).toEqual(new Set(['窗口 A', '窗口 B']));
  });
  it('enforces one active daily per date and preserves the losing draft', async () => {
    const store = space();
    const results = await Promise.allSettled([store.save(draft()), store.save({ ...draft(), title: '另一份' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
    expect(await store.db.conflicts.count()).toBe(1);
  });
  it('permits multiple moments on the same day', async () => {
    const store = space();
    await store.save(draft());
    await store.save(draft({ kind: 'moment' }));
    await store.save(draft({ kind: 'moment' }));
    expect(await store.day('2026-09-08')).toHaveLength(3);
  });
  it('isolates unrelated account spaces', async () => {
    const a = space(), b = space();
    const entry = await a.save(draft());
    expect(await b.get(entry.id)).toBeUndefined();
    expect(await b.list()).toHaveLength(0);
  });
  it('retains trashed content and prevents restore from overwriting a replacement daily', async () => {
    const store = space();
    const first = await store.save(draft());
    await store.trash(first.id);
    const replacement = await store.save({ ...draft(), title: '新的每日' });
    const error = await store.restore(first.id).catch((error) => error);
    expect(error.message).toContain('已有日记');
    expect(error.current.id).toBe(replacement.id);
    expect((await store.db.conflicts.toArray())[0].remote.id).toBe(replacement.id);
    expect((await store.get(replacement.id)).title).toBe('新的每日');
    expect(await store.list({ state: 'trash' })).toHaveLength(1);
    await store.restore(first.id, { kind: 'moment', occurredAt: new Date().toISOString() });
    expect(await store.list()).toHaveLength(2);
  });
  it('rejects clearing a saved record without deleting its original data', async () => {
    const store = space();
    const first = await store.save(draft());
    await expect(store.save({ ...first, title: '' })).rejects.toThrow('至少保留');
    expect((await store.get(first.id)).title).toBe('我的一天');
    expect((await store.draft(first.id)).title ?? (await store.draft(first.id)).snapshot?.title).toBe('我的一天');
  });
  it('treats percent signs and HTML-looking searches literally', async () => {
    const store = space();
    await store.save({ ...draft(), title: '进步 10% <script>' });
    expect(await store.list({ q: '%' })).toHaveLength(1);
    expect(await store.list({ q: '%script%' })).toHaveLength(0);
    expect(await store.list({ q: '<script>' })).toHaveLength(1);
  });
  it('exports recovery copies, not only visible records', async () => {
    const store = space();
    const first = await store.save(draft());
    await store.save({ ...first, title: 'new' });
    await expect(store.save({ ...first, title: 'conflicted' })).rejects.toThrow();
    const archive = await store.exportLocal();
    expect(archive.entries).toHaveLength(1);
    expect(archive.drafts).toHaveLength(1);
    expect(archive.conflicts).toHaveLength(1);
    expect(archive.source).toBe('local-learning');
  });
  it('exports entries and drafts from one consistent read transaction during a write', async () => {
    const store = space();
    const first = await store.save(draft());
    const [archive] = await Promise.all([store.exportLocal(), store.save({ ...first, title: 'concurrent edit' })]);
    expect(archive.namespace).toBe(store.namespace);
    expect(archive.entries[0].localRevision).toBe(archive.drafts[0].snapshot.localRevision);
    expect(archive.entries[0].title).toBe(archive.drafts[0].snapshot.title);
  });
  it('includes portable base64 image bytes in the complete local backup', async () => {
    const store = space(), entryId = crypto.randomUUID(), id = crypto.randomUUID();
    await store.saveAsset({ id, entryId, mimeType: 'image/webp', size: 4, sha256: 'f'.repeat(64), width: 2, height: 2,
      createdAt: new Date().toISOString(), bytes: new Uint8Array([1, 2, 3, 4]) });
    const archive = await store.exportLocal();
    expect(archive.exportSchemaVersion).toBe(3);
    expect(archive.assets).toEqual([expect.objectContaining({ id, entryId, sourceBase64: 'AQIDBA==' })]);
    expect(archive.assets[0].bytes).toBeUndefined();
  });
});
