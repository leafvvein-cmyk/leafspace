import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { createSqliteStore, SQLITE_SCHEMA } from '../../apps/client/src/services/sqlite-store.js';
import { makeDraft } from '../../packages/contracts/src/entry.js';
import { createSyncUploader } from '../../apps/client/src/services/sync-uploader.js';

const cleanup = [];
describe.each(['indexeddb', 'sqlite'])('%s immutable upload queue', (type) => {
  it('atomically queues a confirmed merge and rolls back if its upload marker fails', async () => {
    const { store, failJobs, recoverJobs } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '最新本机稿' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    await store.saveMergeDraft(id, { ...original, title: '合并结果' }, 0);
    const options = { remote: { ...original, revision: '5', title: '云端稿' }, expectedLocalRevision: latest.localRevision, mergeRevision: 1 };
    await expect(store.keepCloud(id, { ...options, mergeRevision: 2 })).rejects.toThrow('合并草稿已变化');
    failJobs(); await expect(store.keepCloud(id, options)).rejects.toThrow('injected outbox'); recoverJobs();
    expect(await store.get(original.id)).toEqual(latest);
    expect((await store.getConflict(id)).record.resolution).toBeUndefined();
    await store.keepCloud(id, options);
    expect(await store.get(original.id)).toMatchObject({ title: '合并结果', revision: '5', localRevision: 3 });
    const job = await store.uploadQueue.next();
    expect(job.mutation.baseRevision).toBe('5'); expect(job.mutation.payload.title).toBe('合并结果');
    const record = (await store.getConflict(id)).record;
    expect(record.resolution.kind).toBe('merged-local'); expect(record.resolution.discardedLocal.title).toBe('最新本机稿');
    expect(record.mergeDraft.entry.title).toBe('合并结果');
    await expect(store.keepCloud(id, { ...options, mergeRevision: undefined })).rejects.toThrow('其他方式处理');
  });
  it('persists isolated merge drafts with cross-window revision checks and export backup', async () => {
    const { store, pending } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '当前内容' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id, jobs = await pending();
    const merged = await store.saveMergeDraft(id, { ...original, title: '手动合并中' }, 0);
    expect(merged.localRevision).toBe(1);
    expect((await store.getConflict(id)).record.mergeDraft.entry.title).toBe('手动合并中');
    expect((await store.exportLocal()).conflicts.find((item) => item.id === id).mergeDraft.entry).toEqual(merged);
    expect(await store.get(original.id)).toEqual(latest); expect(await pending()).toEqual(jobs);
    await expect(store.saveMergeDraft(id, { ...merged, title: '过期窗口' }, 0)).rejects.toThrow('其他窗口变化');
    await expect(store.saveMergeDraft(id, { ...merged, id: crypto.randomUUID() }, 1)).rejects.toThrow('编号不一致');
    const next = await store.saveMergeDraft(id, { ...merged, title: '继续合并' }, 1);
    expect(next.localRevision).toBe(2);
    const other = await setup(type); await expect(other.store.saveMergeDraft(id, merged, 1)).rejects.toThrow('找不到');
  });
  it('waits for older in-flight snapshots before retiring the local draft', async () => {
    const { store } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '新稿' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    const options = { expectedLocalRevision: latest.localRevision, remote: { ...original, revision: '5' } };
    const request = await store.syncMirror.requestSnapshot();
    await expect(store.keepCloud(id, options)).rejects.toThrow('快照正在重建');
    await store.syncMirror.resetRequest(request.requestId);
    const snapshotId = crypto.randomUUID();
    await store.syncMirror.begin({ snapshotId, recordCount: 1 });
    await expect(store.keepCloud(id, options)).rejects.toThrow('快照正在重建');
    await store.syncMirror.append(snapshotId, null, finalPage([{ entity: 'entry', id: original.id, value: { ...original, revision: '3' } }]));
    await expect(store.keepCloud(id, options)).rejects.toThrow('快照正在重建');
    expect(await store.get(original.id)).toEqual(latest);
    await store.syncMirror.commit(snapshotId);
    await store.keepCloud(id, options);
    expect((await store.get(original.id)).revision).toBe('5');
  });
  it('rolls back retirement, backup and jobs when accepting cloud cannot be persisted', async () => {
    const harness = await setup(type), { store, pending } = harness;
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '保留我' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    const before = await store.exportLocal(), jobs = await pending();
    const options = { expectedLocalRevision: latest.localRevision, remote: { ...original, revision: '3' } };
    harness.fail();
    await expect(store.keepCloud(id, options)).rejects.toThrow('injected quota');
    harness.recover();
    const after = await store.exportLocal();
    expect(after.entries).toEqual(before.entries); expect(after.drafts).toEqual(before.drafts);
    expect(after.conflicts).toEqual(before.conflicts); expect(await pending()).toEqual(jobs);
    expect(await store.get(original.id)).toEqual(latest);
    await store.keepCloud(id, options);
    expect((await store.get(original.id)).revision).toBe('3');
  });
  it('rejects outdated cloud choices, purges and out-of-range revisions without retiring work', async () => {
    const { store } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '最新稿' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    const options = { expectedLocalRevision: latest.localRevision, remote: { ...original, revision: '3' } };
    await expect(store.keepCloud(id, { ...options, remote: { ...original, revision: '9223372036854775808' } })).rejects.toThrow('云端版本无效');
    await seed(store.syncMirror, [{ entity: 'entry', id: original.id, value: { ...original, revision: '4' } }]);
    await expect(store.keepCloud(id, options)).rejects.toThrow('云端版本又有变化');
    await store.syncMirror.applyChanges('server.baseline', { events: [{ seq: '1', type: 'transaction', changes: [
      { entity: 'entry', id: original.id, action: 'purge', revision: '5' }
    ] }], hasMore: false, nextCursor: 'purged.cursor' });
    await expect(store.keepCloud(id, options)).rejects.toThrow('云端版本又有变化');
    expect(await store.get(original.id)).toEqual(latest);
    expect((await store.getConflict(id)).record.resolution).toBeUndefined();
  });
  it('keeps cloud with an archived local backup and rejects stale editors', async () => {
    const { store } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '本机原稿' });
    const latest = await store.save({ ...original, title: '本机最新稿' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    const remote = { ...original, revision: '5', title: '云端正文' };
    await expect(store.keepCloud(id, { expectedLocalRevision: original.localRevision, remote })).rejects.toThrow('本机稿已变化');
    await store.keepCloud(id, { expectedLocalRevision: latest.localRevision, remote });
    expect(await store.get(original.id)).toMatchObject({ title: '云端正文', revision: '5', localRevision: 3 });
    expect(await store.draft(original.id)).toMatchObject({ title: '云端正文' });
    expect((await store.getConflict(id)).record.resolution.discardedLocal.title).toBe('本机最新稿');
    const summary = (await store.listConflicts()).items.find((item) => item.id === id);
    expect(summary.resolutionKind).toBe('keep-cloud'); expect(summary.resolvedAt).toBeTruthy();
    expect(summary).not.toHaveProperty('discardedLocal'); expect(summary).not.toHaveProperty('acceptedRemote');
    await expect(store.save({ ...latest, title: '迟到的编辑' })).rejects.toThrow();
    const fresh = await store.save({ ...await store.get(original.id), title: '基于云端继续写' });
    expect(fresh.localRetired).toBeUndefined();
    expect((await store.uploadQueue.next()).mutation.baseRevision).toBe('5');
    expect(await store.keepCloud(id, { expectedLocalRevision: latest.localRevision, remote })).toMatchObject({ reused: true });
    expect((await store.get(original.id)).title).toBe('基于云端继续写');
  });
  it('refuses keep-cloud while an immutable upload is pending', async () => {
    const { store } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '最新稿' });
    await expect(store.save(original)).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    const job = await store.uploadQueue.next();
    await expect(store.keepCloud(id, { expectedLocalRevision: latest.localRevision,
      remote: { ...original, revision: '5' } })).rejects.toThrow('上传结果尚未确认');
    expect(await store.get(original.id)).toEqual(latest);
    expect((await store.uploadQueue.next()).mutation).toEqual(job.mutation);
    expect((await store.getConflict(id)).record.resolution).toBeUndefined();
  });
  it('atomically copies the preserved conflict draft once without changing the original or a newer draft', async () => {
    const { store, pending } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' });
    const latest = await store.save({ ...original, title: '当前新稿' });
    await expect(store.save({ ...original, title: '要保留的冲突稿' })).rejects.toMatchObject({ name: 'LocalConflictError' });
    const id = (await store.listConflicts()).items[0].id;
    const results = await Promise.all([store.copyConflict(id), store.copyConflict(id)]);
    expect(results[0].entryId).toBe(results[1].entryId); expect(results.filter((item) => !item.reused)).toHaveLength(1);
    expect(results[0].entryId).not.toBe(original.id);
    expect(await store.get(results[0].entryId)).toMatchObject({ kind: 'moment', title: '要保留的冲突稿', revision: '0', localRevision: 1, deletedAt: null });
    expect(await store.get(original.id)).toEqual(latest);
    expect((await store.getConflict(id)).record.local.title).toBe('要保留的冲突稿');
    expect((await pending()).filter((job) => job.entryId === results[0].entryId)).toHaveLength(1);
  });
  it('clones image bytes and rewrites image ids when a conflict draft becomes a new moment', async () => {
    const { store } = await setup(type), entryId = crypto.randomUUID(), assetId = crypto.randomUUID();
    await store.saveAsset({ id: assetId, entryId, mimeType: 'image/webp', size: 3, sha256: 'a'.repeat(64), width: 1, height: 1,
      status: 'ready', createdAt: new Date().toISOString(), bytes: new Uint8Array([7, 8, 9]) });
    const content = { type: 'doc', content: [{ type: 'image', attrs: { assetId, alt: '原图', caption: '' } }] };
    const original = await store.save({ ...makeDraft({ id: entryId }), title: '含图原稿', content });
    await store.save({ ...original, title: '当前新版' });
    await expect(store.save({ ...original, title: '冲突含图稿' })).rejects.toThrow();
    const conflictId = (await store.listConflicts()).items[0].id;
    const copied = await store.copyConflict(conflictId), copy = await store.get(copied.entryId);
    const copiedAssetId = copy.content.content[0].attrs.assetId;
    expect(copiedAssetId).not.toBe(assetId);
    expect(await store.listAssets(copied.entryId)).toEqual([expect.objectContaining({ id: copiedAssetId, status: 'local-only' })]);
    expect(Array.from((await store.getAsset(copiedAssetId)).bytes)).toEqual([7, 8, 9]);
  });
  it('rolls back all copy writes if its upload marker cannot be saved', async () => {
    const { store, failJobs, recoverJobs } = await setup(type);
    const original = await store.save({ ...makeDraft(), title: '原稿' }); await store.save({ ...original, title: '新稿' });
    await expect(store.save({ ...original, title: '保留版本' })).rejects.toThrow();
    const id = (await store.listConflicts()).items[0].id;
    failJobs(); await expect(store.copyConflict(id)).rejects.toThrow('injected outbox'); recoverJobs();
    expect((await store.exportLocal()).entries).toHaveLength(1);
    expect((await store.exportLocal()).drafts).toHaveLength(1);
    expect((await store.getConflict(id)).record.copyEntryId).toBeUndefined();
    const copy = await store.copyConflict(id); expect(copy.reused).toBe(false);
    expect((await store.exportLocal()).entries).toHaveLength(2);
    const other = await setup(type); await expect(other.store.copyConflict(id)).rejects.toThrow('找不到');
  });
  it('pages conflict summaries without bodies and reads preserved versions only from their own space', async () => {
    const { store } = await setup(type);
    for (let n = 0; n < 3; n++) {
      const original = await store.save({ ...makeDraft({ kind: 'moment' }), title: `原稿 ${n}` });
      await store.save({ ...original, title: `新版 ${n}` });
      await expect(store.save({ ...original, title: `冲突稿 ${n}` })).rejects.toMatchObject({ name: 'LocalConflictError' });
    }
    const first = await store.listConflicts({ limit: 2 }); expect(first.items).toHaveLength(2); expect(first.hasMore).toBe(true);
    expect(first.items[0]).not.toHaveProperty('local');
    const second = await store.listConflicts({ limit: 2, before: first.nextCursor }); expect(second.items).toHaveLength(1); expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    const bundle = await store.getConflict(first.items[0].id);
    expect(bundle.record.local.title).toContain('冲突稿'); expect(bundle.record.remote.title).toContain('新版'); expect(bundle.latestLocal.title).toContain('新版');
    const other = await setup(type); expect(await other.store.getConflict(bundle.record.id)).toBeNull();
    await expect(store.listConflicts({ before: 'invalid' })).rejects.toThrow('分页位置');
    await expect(store.listConflicts({ limit: 100 })).rejects.toThrow('分页数量');
  });
  const confirmed = (job, entry = { ...job.snapshot, revision: '1' }) => ({ mutationId: job.mutation.mutationId, status: 'applied', entry });
  it('distinguishes a pre-upload snapshot from a later snapshot proving absence', async () => {
    const { store } = await setup(type), generation = crypto.randomUUID();
    const saved = await store.save({ ...makeDraft(), title: '不能被旧快照误删' });
    const job = await store.uploadQueue.next();
    await store.uploadQueue.complete(job.mutation.mutationId, { ...confirmed(job), syncPosition: { generation, seq: '9007199254740993' } });
    await seed(store.syncMirror, [], { generation, seq: '9007199254740992' });
    expect((await store.get(saved.id)).title).toBe(saved.title);
    await seed(store.syncMirror, [], { generation, seq: '9007199254740994' });
    expect(await store.get(saved.id)).toBeUndefined(); expect(await store.draft(saved.id)).toBeUndefined();
    expect(await store.list()).toEqual([]); expect((await store.exportLocal()).entries).toHaveLength(1);
  });
  it('preserves unacknowledged work even when a later snapshot omits its remote version', async () => {
    const { store } = await setup(type), generation = crypto.randomUUID();
    const saved = await store.save({ ...makeDraft(), title: '第一版' });
    const job = await store.uploadQueue.next();
    const edited = await store.save({ ...saved, title: '还没上传的新内容' });
    await store.uploadQueue.complete(job.mutation.mutationId, { ...confirmed(job), syncPosition: { generation, seq: '1' } });
    await seed(store.syncMirror, [], { generation, seq: '10' });
    expect(await store.get(saved.id)).toEqual(edited);
  });
  it('does not infer deletion across generations or from legacy receipts without positions', async () => {
    const { store } = await setup(type), saved = await store.save({ ...makeDraft(), title: '需要核对的旧数据' });
    const job = await store.uploadQueue.next();
    await store.uploadQueue.complete(job.mutation.mutationId, { ...confirmed(job), syncPosition: { generation: crypto.randomUUID(), seq: '1' } });
    await seed(store.syncMirror, [], { generation: crypto.randomUUID(), seq: '999' });
    expect(await store.get(saved.id)).toBeTruthy();
    const edited = await store.save({ ...await store.get(saved.id), title: '旧版响应兼容' });
    const next = await store.uploadQueue.next(); await store.uploadQueue.complete(next.mutation.mutationId, confirmed(next, { ...edited, revision: '2' }));
    await seed(store.syncMirror, [], { generation: crypto.randomUUID(), seq: '999' });
    expect(await store.get(saved.id)).toBeTruthy();
  });
  it('hands clean local display to the receipt and then a newer cloud revision', async () => {
    const { store } = await setup(type); const saved = await store.save({ ...makeDraft(), title: '第一版' });
    const job = await store.uploadQueue.next(); await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job));
    expect(await store.get(saved.id)).toMatchObject({ revision: '1', localRevision: 1 });
    await seed(store.syncMirror, [{ entity: 'entry', id: saved.id, value: { ...saved, revision: '2', title: '另一台设备' } }]);
    const visible = await store.get(saved.id); expect(visible).toMatchObject({ title: '另一台设备', revision: '2', localRevision: 1 });
    expect((await store.list({ q: '另一台设备' })).map((entry) => entry.id)).toContain(saved.id);
    expect((await store.exportLocal()).entries[0].title).toBe('第一版');
    const edit = await store.save({ ...visible, title: '基于新云端版编辑' });
    expect(edit.revision).toBe('2');
    expect((await store.uploadQueue.next()).mutation.baseRevision).toBe('2');
  });
  it('rejects an old editor after a newer cloud revision but permits its own upload acknowledgement', async () => {
    const { store } = await setup(type); const original = await store.save({ ...makeDraft(), title: '原稿' });
    const job = await store.uploadQueue.next(); await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job));
    const continued = await store.save({ ...original, title: '确认后继续输入' });
    expect(continued.revision).toBe('1');
    const next = await store.uploadQueue.next(); await store.uploadQueue.complete(next.mutation.mutationId, confirmed(next, { ...continued, revision: '2' }));
    await seed(store.syncMirror, [{ entity: 'entry', id: original.id, value: { ...continued, revision: '3', title: '云端又有修改' } }]);
    await expect(store.save({ ...continued, title: '旧编辑器输入' })).rejects.toMatchObject({ name: 'LocalConflictError' });
    expect((await store.get(original.id)).title).toBe('云端又有修改');
    expect((await store.exportLocal()).conflicts.at(-1).local.title).toBe('旧编辑器输入');
  });
  it('hides confirmed purges from list, get and old draft fallbacks without deleting backup data', async () => {
    const { store } = await setup(type); const saved = await store.save({ ...makeDraft(), title: '随后永久删除' });
    const job = await store.uploadQueue.next(); await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job));
    await seed(store.syncMirror, [{ entity: 'entry', id: saved.id, value: { ...saved, revision: '1' } }]);
    await store.syncMirror.applyChanges('server.baseline', { events: [{ seq: '1', type: 'transaction', changes: [{ entity: 'entry', id: saved.id, action: 'purge', revision: '2' }] }], hasMore: false, nextCursor: 'purge.cursor' });
    expect(await store.get(saved.id)).toBeUndefined(); expect(await store.draft(saved.id)).toBeUndefined();
    expect(await store.dailyDraft(saved.entryDate)).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect((await store.exportLocal()).drafts[0].snapshot.title).toBe(saved.title);
    await expect(store.save({ ...saved, title: '旧窗口不应复活删除' })).rejects.toMatchObject({ name: 'LocalConflictError' });
  });
  it('releases an obsolete date index after the confirmed entry moves in the cloud', async () => {
    const { store } = await setup(type); const saved = await store.save({ ...makeDraft({ entryDate: '2026-09-07' }), title: '原日期' });
    const job = await store.uploadQueue.next(); await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job));
    await seed(store.syncMirror, [{ entity: 'entry', id: saved.id, value: { ...saved, entryDate: '2026-09-08', revision: '2' } }]);
    const replacement = await store.save({ ...makeDraft({ entryDate: '2026-09-07' }), title: '旧日期可重新写' });
    expect((await store.day('2026-09-07')).map((entry) => entry.id)).toEqual([replacement.id]);
    expect((await store.day('2026-09-08')).map((entry) => entry.id)).toEqual([saved.id]);
    await expect(store.save({ ...makeDraft({ entryDate: '2026-09-08' }), title: '仍拒绝同日重复' })).rejects.toMatchObject({ name: 'DailyExistsError' });
  });
  it('commits immutable requests and does not replace newer drafts after acknowledgement', async () => {
    const { store, pending } = await setup(type);
    const first = await store.save({ ...makeDraft({ kind: 'moment' }), title: '第一版' });
    const job = await store.uploadQueue.next();
    expect(job.mutation.payload.title).toBe('第一版'); expect(job.mutation.baseRevision).toBe('0');
    const second = await store.save({ ...first, title: '第二版' });
    expect(await store.uploadQueue.next()).toEqual(job);
    expect(await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job))).toEqual({ status: 'more-local-work' });
    expect(await store.draft(first.id)).toEqual(second);
    const next = await store.uploadQueue.next();
    expect(next.mutation.mutationId).not.toBe(job.mutation.mutationId);
    expect(next.mutation.baseRevision).toBe('1'); expect(next.mutation.payload.title).toBe('第二版');
    await store.uploadQueue.complete(next.mutation.mutationId, confirmed(next, { ...second, revision: '2' }));
    expect(await store.uploadQueue.next()).toBeNull();
    expect((await pending()).filter((row) => row.status === 'local-only')).toEqual([]);
    expect(await store.draft(first.id)).toEqual(second);
  });
  it('replays exactly the persisted request after a lost network response', async () => {
    const { store } = await setup(type); await store.save({ ...makeDraft(), title: '断网重试' });
    let first, fail = true;
    const uploader = () => createSyncUploader({ queue: store.uploadQueue, isCurrent: () => true, request: async (_path, options) => {
      const job = await store.uploadQueue.next(); expect(options.body.mutations).toEqual([job.mutation]);
      if (fail) { first = options.body; fail = false; throw new Error('response lost'); }
      expect(options.body).toEqual(first); return { results: [{ ...confirmed(job), status: 'replayed' }] };
    } });
    await expect(uploader().step()).rejects.toThrow('response lost');
    expect(await uploader().step()).toEqual({ status: 'acknowledged' });
  });
  it('keeps local-only trash private but finishes trash requested while create was in flight', async () => {
    const { store } = await setup(type); const first = await store.save({ ...makeDraft(), title: '已删除' });
    await store.trash(first.id); expect(await store.uploadQueue.next()).toBeNull();
    await store.restore(first.id); const job = await store.uploadQueue.next(); await store.trash(first.id);
    await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job));
    const trash = await store.uploadQueue.next(); expect(trash.mutation.operation).toBe('trash');
    expect(trash.mutation.baseRevision).toBe('1');
    await store.uploadQueue.complete(trash.mutation.mutationId, confirmed(trash, { ...trash.snapshot, revision: '2' }));
    expect(await store.uploadQueue.next()).toBeNull();
  });
  it('sends a content update before trash and explicit restore before restored content changes', async () => {
    const { store } = await setup(type), value = { ...makeDraft(), title: '云端', revision: '4' };
    await seed(store.syncMirror, [{ entity: 'entry', id: value.id, value }]);
    await store.save({ ...await store.get(value.id), title: '改后删除' }); await store.trash(value.id);
    const upsert = await store.uploadQueue.next(); expect(upsert.mutation.operation).toBe('upsert');
    await store.uploadQueue.complete(upsert.mutation.mutationId, confirmed(upsert, { ...upsert.snapshot, deletedAt: null, revision: '5' }));
    const trash = await store.uploadQueue.next(); expect(trash.mutation.operation).toBe('trash');
    await store.uploadQueue.complete(trash.mutation.mutationId, confirmed(trash, { ...trash.snapshot, revision: '6' }));
    await store.restore(value.id); const restore = await store.uploadQueue.next(); expect(restore.mutation.operation).toBe('restore');
    expect(restore.mutation.baseRevision).toBe('6');
  });
  it('retains a durable conflict and allows unrelated records to proceed', async () => {
    const { store } = await setup(type); const first = await store.save({ ...makeDraft({ kind: 'moment' }), title: '冲突' });
    const job = await store.uploadQueue.next();
    await store.uploadQueue.complete(job.mutation.mutationId, { mutationId: job.mutation.mutationId, status: 'conflict', error: { code: 'REVISION_CONFLICT' } });
    await store.save({ ...first, title: '继续保留的本机修改' });
    const next = await store.save({ ...makeDraft({ kind: 'moment' }), title: '其他记录' });
    expect((await store.uploadQueue.next()).entryId).toBe(next.id);
    expect((await store.exportLocal()).conflicts[0].local.title).toBe('冲突');
    expect((await store.draft(first.id)).title).toBe('继续保留的本机修改');
  });
  it('rejects mismatched acknowledgements and ignores late account responses', async () => {
    const { store } = await setup(type); await store.save({ ...makeDraft(), title: '账号隔离' });
    const job = await store.uploadQueue.next();
    await expect(store.uploadQueue.complete(job.mutation.mutationId, confirmed(job, { ...job.snapshot, id: crypto.randomUUID(), revision: '1' }))).rejects.toThrow('编号');
    let current = true;
    const uploader = createSyncUploader({ queue: store.uploadQueue, isCurrent: () => current,
      request: async () => { current = false; return { results: [confirmed(job)] }; } });
    await expect(uploader.step()).rejects.toMatchObject({ code: 'SYNC_CONTEXT_CHANGED' });
    expect(await store.uploadQueue.next()).toEqual(job);
  });
  it('rolls back failed request and receipt persistence, leaving the same work retryable', async () => {
    const { store, failJobs, recoverJobs } = await setup(type);
    const first = await store.save({ ...makeDraft(), title: '磁盘故障保护' });
    failJobs(); await expect(store.uploadQueue.next()).rejects.toThrow('injected outbox'); recoverJobs();
    const job = await store.uploadQueue.next();
    failJobs(); await expect(store.uploadQueue.complete(job.mutation.mutationId, confirmed(job))).rejects.toThrow('injected outbox'); recoverJobs();
    expect(await store.uploadQueue.next()).toEqual(job); expect(await store.draft(first.id)).toEqual(first);
    expect((await store.uploadQueue.complete(job.mutation.mutationId, confirmed(job))).status).toBe('acknowledged');
  });
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(type) {
  const namespace = `user:${crypto.randomUUID()}`;
  if (type === 'indexeddb') {
    const store = createLocalStore(namespace); cleanup.push(() => store.db.delete());
    const fail = () => { throw new Error('injected quota'); };
    const failJobs = () => { throw new Error('injected outbox'); };
    return { store, pending: () => store.db.outbox.toArray(), fail: () => store.db.cloudRecords.hook('creating', fail), recover: () => store.db.cloudRecords.hook('creating').unsubscribe(fail),
      failJobs: () => store.db.outbox.hook('creating', failJobs), recoverJobs: () => store.db.outbox.hook('creating').unsubscribe(failJobs) };
  }
  const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close());
  const connection = {
    execute: async (sql) => db.exec(sql), query: async (sql, args = []) => ({ values: db.prepare(sql).all(...args) }),
    run: async (sql, args = []) => db.prepare(sql).run(...args),
    beginTransaction: async () => db.exec('BEGIN IMMEDIATE'), commitTransaction: async () => db.exec('COMMIT'),
    rollbackTransaction: async () => db.exec('ROLLBACK'), isTransactionActive: async () => ({ result: db.isTransaction }), close: async () => {},
  };
  // Open a genuine schema-1 database, then verify the additive migration.
  for (const sql of SQLITE_SCHEMA) db.exec(sql);
  db.exec("PRAGMA user_version=1; INSERT INTO settings(key,payload) VALUES('old-setting','{\"value\":42}')");
  const store = await createSqliteStore(connection, namespace);
  expect(await store.getSetting('old-setting')).toBe(42);
  expect(db.prepare('PRAGMA user_version').get().user_version).toBe(4);
  return { store, pending: async () => db.prepare('SELECT payload FROM outbox ORDER BY id').all().map((row) => JSON.parse(row.payload)), fail: () => db.exec("CREATE TRIGGER fail_cloud BEFORE INSERT ON cloud_records BEGIN SELECT RAISE(ABORT,'injected quota'); END"), recover: () => db.exec('DROP TRIGGER fail_cloud'),
    failJobs: () => db.exec("CREATE TRIGGER fail_jobs BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected outbox'); END"), recoverJobs: () => db.exec('DROP TRIGGER fail_jobs') };
}
const tag = (name = '生活') => { const id = crypto.randomUUID(); return { entity: 'tag', id, value: { id, name, revision: '1' } }; };
const finalPage = (records, baselineCursor = 'server.baseline') => ({ records, hasMore: false, nextPageCursor: null, baselineCursor });
async function seed(mirror, records, snapshotPosition) {
  const id = crypto.randomUUID(); await mirror.begin({ snapshotId: id, recordCount: records.length });
  await mirror.append(id, null, { ...finalPage(records), snapshotPosition }); await mirror.commit(id); return id;
}

describe.each(['indexeddb', 'sqlite'])('%s snapshot mirror transactions', (type) => {
  it('rejects invalid positions before writing pages and checks deltas against a known snapshot baseline', async () => {
    const { store } = await setup(type), mirror = store.syncMirror, id = crypto.randomUUID(), generation = crypto.randomUUID();
    await mirror.begin({ snapshotId: id, recordCount: 0 });
    await expect(mirror.append(id, null, { ...finalPage([]), snapshotPosition: { generation, seq: '9223372036854775808' } })).rejects.toThrow('序号');
    expect((await mirror.state()).staging.complete).toBe(false);
    await mirror.append(id, null, { ...finalPage([]), snapshotPosition: { generation, seq: '10' } }); await mirror.commit(id);
    await expect(mirror.applyChanges('server.baseline', { events: [{ seq: '12', type: 'transaction', changes: [{ ...tag(), action: 'upsert' }] }], hasMore: false, nextCursor: 'skipped.next' })).rejects.toMatchObject({ code: 'SYNC_RESNAPSHOT_REQUIRED' });
    expect((await mirror.state()).active.lastSeq).toBe('10');
  });
  const entryRecord = (overrides = {}) => {
    const value = { ...makeDraft({ kind: 'moment' }), title: '云端日记', revision: '7', ...overrides };
    delete value.localRevision;
    return { entity: 'entry', id: value.id, value };
  };
  it('projects downloaded entries through detail, list, day, search and trash without creating local edits', async () => {
    const { store, pending } = await setup(type), record = entryRecord();
    const trash = entryRecord({ deletedAt: new Date().toISOString(), title: '已删除的云日记' });
    await seed(store.syncMirror, [record, trash]);
    expect(await store.get(record.id)).toMatchObject({ title: '云端日记', revision: '7', localRevision: 0 });
    expect((await store.list({ q: '云端' })).map((entry) => entry.id)).toEqual([record.id]);
    expect((await store.day(record.value.entryDate)).map((entry) => entry.id)).toEqual([record.id]);
    expect((await store.list({ state: 'trash' })).map((entry) => entry.id)).toEqual([trash.id]);
    expect(await pending()).toEqual([]); expect((await store.exportLocal()).entries).toEqual([]);
  });
  it('edits a cloud entry locally while preserving its original upload base and remote body', async () => {
    const { store, pending } = await setup(type), record = entryRecord(); await seed(store.syncMirror, [record]);
    const saved = await store.save({ ...await store.get(record.id), title: '我的本机修改' });
    expect(saved).toMatchObject({ localRevision: 1, revision: '7' });
    expect((await store.syncMirror.records())[0].value.title).toBe('云端日记');
    await seed(store.syncMirror, [{ ...record, value: { ...record.value, revision: '8', title: '其他设备修改' } }]);
    expect((await store.get(record.id)).title).toBe('我的本机修改');
    expect(await store.list()).toHaveLength(1); expect(await pending()).toHaveLength(1);
    expect((await store.save({ ...saved, title: '继续写' })).revision).toBe('7');
  });
  it('rejects clearing a downloaded entry to an empty draft without leaving partial local state', async () => {
    const { store, pending } = await setup(type), record = entryRecord(); await seed(store.syncMirror, [record]);
    await expect(store.save({ ...await store.get(record.id), title: '' })).rejects.toThrow('至少保留');
    expect(await store.draft(record.id)).toBeUndefined(); expect(await pending()).toEqual([]);
    expect((await store.get(record.id)).title).toBe('云端日记');
  });
  it('persists losing work when the cloud changes before the first local save', async () => {
    const { store } = await setup(type), record = entryRecord(); await seed(store.syncMirror, [record]);
    const editing = await store.get(record.id);
    await seed(store.syncMirror, [{ ...record, value: { ...record.value, revision: '8', title: '新版' } }]);
    await expect(store.save({ ...editing, title: '未保存的旧版修改' })).rejects.toMatchObject({ name: 'LocalConflictError' });
    expect((await store.get(record.id)).title).toBe('新版');
    expect((await store.exportLocal()).conflicts[0].local.title).toBe('未保存的旧版修改');
  });
  it('handles cloud-only trash and restore as local changes, and checks cloud daily uniqueness', async () => {
    const { store } = await setup(type), record = entryRecord({ kind: 'daily', occurredAt: null }); await seed(store.syncMirror, [record]);
    await expect(store.save({ ...makeDraft({ entryDate: record.value.entryDate }), title: '重复一天' })).rejects.toMatchObject({ name: 'DailyExistsError' });
    expect((await store.trash(record.id)).deletedAt).toBeTruthy();
    expect(await store.list()).toEqual([]);
    expect((await store.restore(record.id)).deletedAt).toBeNull();
    expect(await store.day(record.value.entryDate)).toHaveLength(1);
  });
  it('does not recreate a remotely purged or missing entry from an old cloud editor', async () => {
    const { store } = await setup(type), record = entryRecord(); await seed(store.syncMirror, [record]);
    const editing = await store.get(record.id);
    await store.syncMirror.applyChanges('server.baseline', { events: [{ seq: '1', type: 'transaction', changes: [{ entity: 'entry', id: record.id, action: 'purge', revision: '8' }] }], hasMore: false, nextCursor: 'after.purge' });
    expect(await store.get(record.id)).toBeUndefined(); expect(await store.list()).toEqual([]);
    await expect(store.save({ ...editing, title: '旧窗口内容' })).rejects.toMatchObject({ name: 'LocalConflictError' });
    expect((await store.exportLocal()).conflicts[0].local.title).toBe('旧窗口内容');
  });
  const page = (seq, changes, nextCursor = 'delta.next') => ({ events: [{ seq, type: 'transaction', changes }], nextCursor, hasMore: false });
  const upsert = (record) => ({ ...record, action: 'upsert' });
  it('applies remote changes and position atomically, ignores duplicates, and prevents revision regression', async () => {
    const { store } = await setup(type), mirror = store.syncMirror, record = tag(); await seed(mirror, [record]);
    const changed = { ...record, value: { ...record.value, name: '更新', revision: '2' } };
    await mirror.applyChanges('server.baseline', page('9007199254740993', [upsert(changed)]));
    expect(await mirror.records()).toEqual([changed]);
    const duplicate = page('9007199254740993', [upsert(record)], 'delta.duplicate');
    await mirror.applyChanges('delta.next', duplicate);
    await mirror.applyChanges('delta.duplicate', page('9007199254740994', [upsert(record)], 'delta.final'));
    expect(await mirror.records()).toEqual([changed]);
    expect((await mirror.state()).active.lastSeq).toBe('9007199254740994');
    await expect(mirror.applyChanges('server.baseline', duplicate)).rejects.toMatchObject({ code: 'SYNC_POSITION_CHANGED' });
  });
  it('rolls back every entity and cursor if a transaction contains invalid data or a sequence gap', async () => {
    const { store } = await setup(type), mirror = store.syncMirror, record = tag(); await seed(mirror, [record]);
    const changed = { ...record, value: { ...record.value, revision: '2' } };
    await expect(mirror.applyChanges('server.baseline', page('1', [upsert(changed), { action: 'unknown' }]))).rejects.toThrow();
    expect(await mirror.records()).toEqual([record]); expect((await mirror.state()).active.cursor).toBe('server.baseline');
    await mirror.applyChanges('server.baseline', page('1', [upsert(changed)]));
    await expect(mirror.applyChanges('delta.next', page('3', [upsert(tag())]))).rejects.toMatchObject({ code: 'SYNC_RESNAPSHOT_REQUIRED' });
    expect((await mirror.state()).active.lastSeq).toBe('1');
  });
  it('keeps a body-free purge tombstone and does not erase local work', async () => {
    const { store, pending } = await setup(type), mirror = store.syncMirror;
    const local = await store.save({ ...makeDraft(), title: '本机稿' });
    const record = { entity: 'entry', id: local.id, value: { ...local, revision: '1' } }; await seed(mirror, [record]);
    await mirror.applyChanges('server.baseline', page('10', [{ entity: 'entry', id: local.id, action: 'purge', revision: '2' }]));
    const tombstone = (await mirror.records())[0]; expect(tombstone.purged).toBe(true); expect(tombstone.value).toEqual({ revision: '2' });
    expect((await store.draft(local.id)).title).toBe('本机稿'); expect(await pending()).toHaveLength(1);
    await mirror.applyChanges('delta.next', page('11', [upsert(record)], 'old.replay'));
    expect((await mirror.records())[0].purged).toBe(true);
  });
  it('rolls back all changes when the server requests a replacement snapshot', async () => {
    const { store } = await setup(type), mirror = store.syncMirror, record = tag(); await seed(mirror, [record]);
    const input = page('1', [upsert(tag())]); input.events.push({ seq: '2', type: 'resnapshot_required' });
    await expect(mirror.applyChanges('server.baseline', input)).rejects.toMatchObject({ code: 'SYNC_RESNAPSHOT_REQUIRED' });
    expect(await mirror.records()).toEqual([record]); expect((await mirror.state()).active.cursor).toBe('server.baseline');
  });
  it('switches a complete mirror and cursor without changing local diary, draft or pending marker', async () => {
    const { store, pending } = await setup(type);
    const saved = await store.save({ ...makeDraft(), title: '尚未上传的本机修改' });
    const before = await store.exportLocal();
    const pendingBefore = await pending();
    const record = tag(); const id = await seed(store.syncMirror, [record]);
    expect(await store.syncMirror.records()).toEqual([record]);
    expect((await store.syncMirror.state()).active).toMatchObject({ snapshotId: id, cursor: 'server.baseline' });
    expect((await store.syncMirror.state()).staging).toBeNull();
    expect((await store.get(saved.id)).title).toBe(saved.title);
    const after = await store.exportLocal();
    expect(after.entries).toEqual(before.entries); expect(after.drafts).toEqual(before.drafts); expect(after.conflicts).toEqual(before.conflicts);
    expect(await pending()).toEqual(pendingBefore); expect(pendingBefore).toHaveLength(1);
  });
  it('keeps the previous mirror while a replacement is incomplete and rejects skipped page positions', async () => {
    const { store } = await setup(type), mirror = store.syncMirror, previous = tag('旧版'); await seed(mirror, [previous]);
    const id = crypto.randomUUID(); await mirror.begin({ snapshotId: id, recordCount: 2 });
    await mirror.append(id, null, { records: [tag()], hasMore: true, nextPageCursor: 'page.two', baselineCursor: null });
    await expect(mirror.commit(id)).rejects.toThrow('完整');
    await expect(mirror.append(id, null, finalPage([tag()]))).rejects.toThrow('位置');
    expect(await mirror.records()).toEqual([previous]);
    expect((await mirror.begin({ snapshotId: id, recordCount: 2 })).nextPageCursor).toBe('page.two');
    await mirror.append(id, 'page.two', finalPage([tag()])); await mirror.commit(id);
    expect(await mirror.records()).toHaveLength(2);
  });
  it('rolls back duplicate records and wrong final counts without advancing the download cursor', async () => {
    const { store } = await setup(type), mirror = store.syncMirror, id = crypto.randomUUID(), record = tag();
    await mirror.begin({ snapshotId: id, recordCount: 2 });
    await expect(mirror.append(id, null, finalPage([record, record]))).rejects.toThrow('重复');
    await expect(mirror.append(id, null, finalPage([record]))).rejects.toThrow('数量');
    expect((await mirror.state()).staging.received).toBe(0);
    await mirror.append(id, null, finalPage([record, tag()])); await mirror.commit(id);
    expect(await mirror.records()).toHaveLength(2);
  });
  it('rolls back mirror replacement and retains staged content on storage failure', async () => {
    const h = await setup(type), mirror = h.store.syncMirror, old = tag('旧版'), next = tag('新版');
    await seed(mirror, [old]); const id = crypto.randomUUID();
    await mirror.begin({ snapshotId: id, recordCount: 1 }); await mirror.append(id, null, finalPage([next], 'next.baseline'));
    h.fail(); await expect(mirror.commit(id)).rejects.toThrow(); h.recover();
    expect(await mirror.records()).toEqual([old]);
    expect((await mirror.state()).active.cursor).toBe('server.baseline');
    expect((await mirror.state()).staging.complete).toBe(true);
    await mirror.commit(id); expect(await mirror.records()).toEqual([next]);
  });
  it('rejects another account profile before persisting a page', async () => {
    const { store } = await setup(type), id = crypto.randomUUID(), other = crypto.randomUUID();
    await store.syncMirror.begin({ snapshotId: id, recordCount: 1 });
    await expect(store.syncMirror.append(id, null, finalPage([{ entity: 'profile', id: other, value: { id: other, revision: '1' } }]))).rejects.toThrow('账号');
    expect((await store.syncMirror.state()).staging.received).toBe(0);
  });
});
