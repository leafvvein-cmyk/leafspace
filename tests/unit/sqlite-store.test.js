import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createSqliteStore } from '../../apps/client/src/services/sqlite-store.js';
import { makeDraft } from '../../packages/contracts/src/entry.js';

const resources = [];
function bridge(path = ':memory:') {
  const db = new DatabaseSync(path);
  let active = false;
  let closed = false;
  const connection = {
    raw: db,
    query: async (sql, values = []) => ({ values: db.prepare(sql).all(...values) }),
    execute: async (sql, transaction) => {
      expect(transaction).toBe(false);
      // Match SQLCipher execSQL's distinction rather than silently swallowing
      // result rows as DatabaseSync.exec would do.
      if (/PRAGMA\s+(busy_timeout|optimize)/i.test(sql)) throw new Error('Queries must use query, not execSQL');
      db.exec(sql); return { changes: { changes: 0 } };
    },
    run: async (sql, values, transaction) => {
      expect(transaction).toBe(false);
      const result = db.prepare(sql).run(...values);
      return { changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) } };
    },
    beginTransaction: async () => { db.exec('BEGIN IMMEDIATE'); active = true; },
    commitTransaction: async () => { db.exec('COMMIT'); active = false; },
    rollbackTransaction: async () => { db.exec('ROLLBACK'); active = false; },
    isTransactionActive: async () => ({ result: active }),
    close: async () => { if (!closed) { db.close(); closed = true; } },
  };
  resources.push(() => connection.close());
  return connection;
}
async function space(path, namespace = crypto.randomUUID()) {
  const connection = bridge(path);
  return { connection, store: await createSqliteStore(connection, namespace) };
}
const entry = (options = {}) => ({ ...makeDraft({ entryDate: '2026-09-08', ...options }), title: '手机里的一天' });
const payloads = (connection, table) => connection.raw.prepare(`SELECT payload FROM ${table}`).all().map((row) => JSON.parse(row.payload));
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });

describe('SQLite repository with real SQL (not native device verification)', () => {
  it('keeps encrypted-database image payloads across reopen and rejects asset id reuse', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'diary-asset-test-'));
    resources.push(() => rmSync(directory, { recursive: true }));
    const path = join(directory, 'test.sqlite'), entryId = crypto.randomUUID(), id = crypto.randomUUID();
    const input = { id, entryId, mimeType: 'image/webp', size: 4, sha256: 'b'.repeat(64), width: 2, height: 2, createdAt: new Date().toISOString(), bytes: new Uint8Array([9, 8, 7, 6]) };
    const first = await space(path); await first.store.saveAsset(input); await first.store.close();
    const reopened = await space(path);
    expect(Array.from((await reopened.store.getAsset(id)).bytes)).toEqual([9, 8, 7, 6]);
    expect(await reopened.store.listAssets(entryId)).toHaveLength(1);
    await expect(reopened.store.saveAsset({ ...input, sha256: 'c'.repeat(64) })).rejects.toThrow('另一份内容');
  });
  it('includes portable base64 image bytes in the complete native backup', async () => {
    const { store } = await space(undefined, `user:${crypto.randomUUID()}`), entryId = crypto.randomUUID(), id = crypto.randomUUID();
    await store.saveAsset({ id, entryId, mimeType: 'image/webp', size: 4, sha256: 'e'.repeat(64), width: 2, height: 2,
      createdAt: new Date().toISOString(), bytes: new Uint8Array([9, 8, 7, 6]) });
    const archive = await store.exportLocal();
    expect(archive.exportSchemaVersion).toBe(3);
    expect(archive.assets).toEqual([expect.objectContaining({ id, entryId, sourceBase64: 'CQgHBg==' })]);
  });
  it('persists terminal image upload problems without exposing bytes and can retry them', async () => {
    const { store } = await space(), entryId = crypto.randomUUID(), id = crypto.randomUUID();
    await store.saveAsset({ id, entryId, mimeType: 'image/webp', size: 1, sha256: 'f'.repeat(64), width: 1, height: 1,
      createdAt: new Date().toISOString(), bytes: new Uint8Array([7]) });
    for (let attempt = 0; attempt < 3; attempt++) await store.recordAssetUploadFailure(id,
      Object.assign(new Error('signed URL must not persist'), { code: 'SERVER_DOWN' }));
    const [problem] = await store.listAssetProblems();
    expect(problem).toMatchObject({ id, status: 'error', uploadAttempts: 3,
      error: { code: 'SERVER_DOWN', message: '图片上传未完成，请检查网络后重试。' } });
    expect(problem).not.toHaveProperty('sourceBase64');
    expect(JSON.stringify(problem)).not.toContain('signed URL');
    await store.retryAssetUpload(id);
    expect(await store.listAssetProblems()).toEqual([]);
    expect(await store.getAsset(id)).toMatchObject({ status: 'local-only', uploadAttempts: 0, error: null });
  });
  it('uses the confirmed text revision when a native image becomes ready later', async () => {
    const { store } = await space(undefined, `user:${crypto.randomUUID()}`), entryId = crypto.randomUUID(), id = crypto.randomUUID();
    await store.saveAsset({ id, entryId, mimeType: 'image/webp', size: 1, sha256: 'a'.repeat(64), width: 1, height: 1,
      createdAt: new Date().toISOString(), bytes: new Uint8Array([5]) });
    const saved = await store.save({ ...entry(), id: entryId,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '先同步文字' }] }, { type: 'image', attrs: { assetId: id, alt: '', caption: '' } }] } });
    const textJob = await store.uploadQueue.next();
    expect(textJob).toMatchObject({ pendingAssets: 1, mutation: { baseRevision: '0' } });
    expect(textJob.mutation.payload.content.content).toHaveLength(1);
    const cloudText = { ...textJob.snapshot, ...textJob.mutation.payload, revision: '1', localRevision: 0, updatedAt: new Date().toISOString() };
    await store.uploadQueue.complete(textJob.mutation.mutationId,
      { mutationId: textJob.mutation.mutationId, status: 'applied', entry: cloudText });
    expect(await store.uploadQueue.next()).toBeNull();
    await store.completeAssetUpload(id, { width: 1, height: 1 });
    const imageJob = await store.uploadQueue.next();
    expect(imageJob).toMatchObject({ entryId: saved.id, pendingAssets: 0, mutation: { baseRevision: '1' } });
    expect(imageJob.mutation.payload.content.content).toHaveLength(2);
  });
  it('clears only remote cache rows from the native database', async () => {
    const { store } = await space(), entryId = crypto.randomUUID(), cachedId = crypto.randomUUID(), localId = crypto.randomUUID();
    const base = { entryId, mimeType: 'image/webp', size: 2, width: 1, height: 1, createdAt: new Date().toISOString(), bytes: new Uint8Array([8, 9]) };
    await store.saveAsset({ ...base, id: cachedId, sha256: '3'.repeat(64), status: 'ready', cacheSource: 'remote' });
    await store.saveAsset({ ...base, id: localId, sha256: '4'.repeat(64), status: 'ready' });
    expect(await store.storageSummary()).toEqual({ cacheCount: 1, cacheBytes: 2, protectedCount: 1, protectedBytes: 2 });
    await store.clearDownloadedAssetCache();
    expect(await store.getAsset(cachedId)).toBeUndefined();
    expect(await store.getAsset(localId)).toMatchObject({ id: localId });
  });
  it('persists entry, draft, marker and settings across a real database reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'diary-sql-test-'));
    resources.push(() => rmSync(directory, { recursive: true }));
    const path = join(directory, 'test.sqlite');
    const first = await space(path);
    const saved = await first.store.save(entry());
    await first.store.setSetting('fontSize', 22);
    await first.store.close();
    const reopened = await space(path);
    expect((await reopened.store.get(saved.id)).title).toBe('手机里的一天');
    expect((await reopened.store.draft(saved.id)).localRevision).toBe(1);
    expect(await reopened.store.getSetting('fontSize')).toBe(22);
    expect(payloads(reopened.connection, 'outbox')[0].status).toBe('local-only');
  });
  it('keeps empty drafts out of entries and versions them for CAS', async () => {
    const { store, connection } = await space();
    const blank = await store.save(makeDraft());
    const second = await store.save({ ...blank, mood: 5 });
    await expect(store.save({ ...blank, mood: 2 })).rejects.toThrow('另一个窗口');
    expect(second.localRevision).toBe(2);
    expect((await store.draft(blank.id)).mood).toBe(5);
    expect(await store.list()).toHaveLength(0);
    expect(payloads(connection, 'outbox')).toHaveLength(0);
    expect(payloads(connection, 'conflicts')[0].local.mood).toBe(2);
  });
  it('allows only one concurrent update and commits the losing recovery copy', async () => {
    const { store, connection } = await space();
    const saved = await store.save(entry());
    const results = await Promise.allSettled([store.save({ ...saved, title: 'A' }), store.save({ ...saved, title: 'B' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const conflict = payloads(connection, 'conflicts')[0];
    expect(new Set([conflict.local.title, conflict.remote.title])).toEqual(new Set(['A', 'B']));
    expect((await store.get(saved.id)).localRevision).toBe(2);
  });
  it('has one active daily, multiple moments, and no empty-draft competition', async () => {
    const { store, connection } = await space();
    const results = await Promise.allSettled([store.save(entry()), store.save(entry())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await store.save(entry({ kind: 'moment' })); await store.save(entry({ kind: 'moment' }));
    await store.save(makeDraft({ entryDate: '2026-09-08' }));
    expect(await store.day('2026-09-08')).toHaveLength(3);
    expect(payloads(connection, 'conflicts')).toHaveLength(1);
    const plan = connection.raw.prepare('EXPLAIN QUERY PLAN SELECT payload FROM entries WHERE entry_date = ?').all('2026-09-08');
    expect(plan.some((row) => row.detail.includes('idx_entries_date'))).toBe(true);
  });
  it('preserves the actual competing daily when restore collides', async () => {
    const { store, connection } = await space();
    const saved = await store.save(entry());
    await store.trash(saved.id);
    const replacement = await store.save({ ...entry(), title: 'replacement' });
    const error = await store.restore(saved.id).catch((error) => error);
    expect(error.current.id).toBe(replacement.id);
    expect(payloads(connection, 'conflicts')[0].remote.id).toBe(replacement.id);
    expect(await store.list({ state: 'trash' })).toHaveLength(1);
    await store.restore(saved.id, { kind: 'moment', occurredAt: new Date().toISOString() });
    expect(await store.list()).toHaveLength(2);
  });
  it.each(['drafts', 'entries', 'outbox'])('rolls back all data when %s write fails', async (table) => {
    const { store, connection } = await space();
    const draft = entry();
    connection.raw.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    await expect(store.save(draft)).rejects.toThrow('injected');
    expect(await store.get(draft.id)).toBeUndefined();
    expect(await store.draft(draft.id)).toBeUndefined();
    expect(payloads(connection, 'outbox')).toHaveLength(0);
    connection.raw.exec('DROP TRIGGER injected_failure');
    expect((await store.save(draft)).localRevision).toBe(1);
  });
  it('rolls back a failed commit and keeps the repository usable', async () => {
    const { store, connection } = await space();
    const commit = connection.commitTransaction;
    connection.commitTransaction = async () => { throw new Error('commit unavailable'); };
    const draft = entry();
    await expect(store.save(draft)).rejects.toThrow('commit unavailable');
    expect(await store.get(draft.id)).toBeUndefined();
    connection.commitTransaction = commit;
    expect((await store.save(draft)).localRevision).toBe(1);
  });
  it('rejects clearing an entry and retains its previous draft and marker', async () => {
    const { store } = await space();
    const saved = await store.save(entry());
    await expect(store.save({ ...saved, title: '' })).rejects.toThrow('至少保留');
    expect((await store.get(saved.id)).localRevision).toBe(1);
    expect((await store.draft(saved.id)).title).toBe(saved.title);
  });
  it('serializes reads, exports and settings without joining an in-flight save transaction', async () => {
    const { store } = await space();
    const draft = entry();
    const results = await Promise.all([store.save(draft), store.list(), store.exportLocal(), store.setSetting('x', false), store.getSetting('x', true)]);
    expect(results[1]).toHaveLength(1);
    expect(results[2].entries).toHaveLength(1);
    expect(results[2].drafts).toHaveLength(1);
    expect(results[4]).toBe(false);
  });
  it('round-trips Unicode and literal SQL-looking searches and isolates database spaces', async () => {
    const a = await space(), b = await space();
    const saved = await a.store.save({ ...entry(), title: "中文🙂 10% O'Reilly _ <script>", tags: [{ name: '日常' }] });
    expect((await a.store.get(saved.id)).title).toBe(saved.title);
    expect(await a.store.list({ q: '%' })).toHaveLength(1);
    expect(await a.store.list({ q: '%script%' })).toHaveLength(0);
    expect(await a.store.list({ q: "' OR 1=1 --" })).toHaveLength(0);
    expect(await b.store.get(saved.id)).toBeUndefined();
  });
  it('refuses a future schema and leaves its records intact', async () => {
    const connection = bridge();
    connection.raw.exec('PRAGMA user_version=999; CREATE TABLE keep_me (value TEXT); INSERT INTO keep_me VALUES (\'still here\');');
    await expect(createSqliteStore(connection, 'future')).rejects.toThrow('较新版本');
    expect(connection.raw.prepare('SELECT value FROM keep_me').get().value).toBe('still here');
  });
});
