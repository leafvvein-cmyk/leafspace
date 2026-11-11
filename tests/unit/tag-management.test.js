import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDraft } from '../../packages/contracts/src/entry.js';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { applyTagChange, changedTags } from '../../apps/client/src/services/tag-management.js';

const stores = [];
const open = () => { const store = createLocalStore(`test-${crypto.randomUUID()}`); stores.push(store); return store; };
afterEach(async () => { for (const store of stores.splice(0)) await store.db.delete(); });

describe('tag management', () => {
  it('renames by normalized identity and deduplicates an existing target tag', () => {
    expect(changedTags([{ name: '工作' }, { name: '生活' }], ' 工作 ', '生活')).toEqual([{ name: '生活' }]);
    expect(changedTags([{ name: '工作' }], '不存在', '新名')).toBeNull();
    expect(() => changedTags([{ name: '工作' }], '工作', '')).toThrow('不能为空');
  });
  it('updates active and trashed entries while keeping unrelated tags', async () => {
    const store = open();
    const first = await store.save({ ...makeDraft({ kind: 'moment' }), title: '一', tags: [{ name: '工作' }, { name: '项目' }] });
    const second = await store.save({ ...makeDraft({ kind: 'moment' }), title: '二', tags: [{ name: '工作' }] }); await store.trash(second.id);
    await expect(applyTagChange({ store, from: '工作', to: '事业' })).resolves.toEqual({ changed: 2, total: 2 });
    expect((await store.get(first.id)).tags).toEqual([{ name: '事业' }, { name: '项目' }]);
    expect((await store.get(second.id)).tags).toEqual([{ name: '事业' }]);
    await expect(applyTagChange({ store, from: '事业', to: null })).resolves.toEqual({ changed: 2, total: 2 });
    expect((await store.get(first.id)).tags).toEqual([{ name: '项目' }]);
  });
  it('is safely repeatable after a completed change', async () => {
    const store = open(); await store.save({ ...makeDraft({ kind: 'moment' }), title: '日记', tags: [{ name: '旧标签' }] });
    await applyTagChange({ store, from: '旧标签', to: '新标签' });
    await expect(applyTagChange({ store, from: '旧标签', to: '新标签' })).resolves.toEqual({ changed: 0, total: 0 });
  });
});
