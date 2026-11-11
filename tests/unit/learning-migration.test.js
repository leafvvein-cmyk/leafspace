import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { copyLearningSpace, previewLearningBackup } from '../../apps/client/src/services/learning-migration.js';
import { makeDraft } from '../../packages/contracts/src/entry.js';

const stores = [];
const open = (namespace) => { const store = createLocalStore(namespace); stores.push(store); return store; };
afterEach(async () => { for (const store of stores.splice(0)) await store.db.delete(); });

describe('explicit learning-space migration', () => {
  it('copies content and private image bytes under new ids, leaves the source intact, and replays safely', async () => {
    const source = open('learning'), target = open(`user:${crypto.randomUUID()}`);
    const entryId = crypto.randomUUID(), assetId = crypto.randomUUID();
    await source.saveAsset({ id: assetId, entryId, mimeType: 'image/webp', size: 3, sha256: 'b'.repeat(64), width: 1, height: 1,
      createdAt: new Date().toISOString(), bytes: new Uint8Array([1, 2, 3]) });
    await source.save({ ...makeDraft({ id: entryId, kind: 'moment' }), title: '学习稿',
      content: { type: 'doc', content: [{ type: 'image', attrs: { assetId, alt: '', caption: '' } }] } });
    expect(previewLearningBackup(await source.exportLocal())).toMatchObject({ total: 1, active: 1, images: 1 });
    const result = await copyLearningSpace({ source, target });
    expect(result).toMatchObject({ copied: 1, conflicts: 0, missingImages: 0, reused: false });
    const [copy] = await target.list(), copiedAssetId = copy.content.content[0].attrs.assetId;
    expect(copy.id).not.toBe(entryId); expect(copiedAssetId).not.toBe(assetId);
    expect(Array.from((await target.getAsset(copiedAssetId)).bytes)).toEqual([1, 2, 3]);
    expect(await source.get(entryId)).toBeDefined();
    await expect(copyLearningSpace({ source, target })).resolves.toMatchObject({ copied: 0, reused: true });
    expect(await target.list()).toHaveLength(1);
  });
  it('records a daily-date collision as a conflict instead of overwriting the account diary', async () => {
    const source = open('learning'), target = open(`user:${crypto.randomUUID()}`), date = '2026-09-08';
    await source.save({ ...makeDraft({ entryDate: date }), title: '学习空间版本' });
    const existing = await target.save({ ...makeDraft({ entryDate: date }), title: '账号已有版本' });
    await expect(copyLearningSpace({ source, target })).resolves.toMatchObject({ copied: 0, conflicts: 1 });
    expect((await target.day(date))).toEqual([existing]);
    const conflicts = await target.listConflicts(); expect(conflicts.items).toHaveLength(1);
    expect((await target.getConflict(conflicts.items[0].id)).record.local.title).toBe('学习空间版本');
  });
  it('copies only new or changed learning items after a completed migration', async () => {
    const source = open('learning'), target = open(`user:${crypto.randomUUID()}`);
    await source.save({ ...makeDraft({ kind: 'moment' }), title: '第一篇' });
    await copyLearningSpace({ source, target });
    await source.save({ ...makeDraft({ kind: 'moment' }), title: '第二篇' });
    await expect(copyLearningSpace({ source, target })).resolves.toMatchObject({ copied: 1, skipped: 1 });
    expect(await target.list()).toHaveLength(2);
  });
});
