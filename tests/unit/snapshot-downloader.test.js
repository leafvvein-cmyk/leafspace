import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { createSnapshotDownloader, retryFailedSnapshot } from '../../apps/client/src/services/snapshot-downloader.js';
const stores = [];
it('restarts a confirmed failed job atomically without clearing the active mirror or local work', async () => {
  const h = harness(); await h.create().step();
  const pending = await h.store.syncMirror.requestSnapshot();
  const failedId = crypto.randomUUID(); await h.store.syncMirror.bindSnapshot(pending.requestId, failedId);
  const before = await h.store.exportLocal(), records = await h.store.syncMirror.records();
  const result = await retryFailedSnapshot({ mirror: h.store.syncMirror, isCurrent: () => true,
    request: async () => ({ snapshotId: failedId, status: 'failed' }) });
  expect(result.reset).toBe(true);
  const state = await h.store.syncMirror.state();
  expect(state.request.requestId).not.toBe(pending.requestId); expect(state.request.snapshotId).toBeNull();
  expect(await h.store.syncMirror.records()).toEqual(records);
  expect((await h.store.exportLocal()).entries).toEqual(before.entries);
});
it.each(['queued', 'running', 'ready'])('keeps a %s job and its request identity during recovery', async (status) => {
  const h = harness(), pending = await h.store.syncMirror.requestSnapshot(); await h.store.syncMirror.bindSnapshot(pending.requestId, h.id);
  expect(await retryFailedSnapshot({ mirror: h.store.syncMirror, isCurrent: () => true, request: async () => ({ snapshotId: h.id, status }) })).toEqual({ reset: false });
  expect((await h.store.syncMirror.state()).request.requestId).toBe(pending.requestId);
});
it('keeps unknown POST outcomes and aborts recovery after an account change', async () => {
  const h = harness(), pending = await h.store.syncMirror.requestSnapshot(), request = vi.fn();
  await retryFailedSnapshot({ mirror: h.store.syncMirror, isCurrent: () => true, request }); expect(request).not.toHaveBeenCalled();
  await h.store.syncMirror.bindSnapshot(pending.requestId, h.id); let current = true;
  await expect(retryFailedSnapshot({ mirror: h.store.syncMirror, isCurrent: () => current, request: async () => {
    current = false; return { snapshotId: h.id, status: 'failed' };
  } })).rejects.toMatchObject({ code: 'SYNC_CONTEXT_CHANGED' });
  expect((await h.store.syncMirror.state()).request.requestId).toBe(pending.requestId);
});
afterEach(async () => { for (const store of stores.splice(0)) await store.db.delete(); });
function harness() {
  const store = createLocalStore(`user:${crypto.randomUUID()}`); stores.push(store);
  const id = crypto.randomUUID(), tagId = crypto.randomUUID(); let current = true;
  const record = { entity: 'tag', id: tagId, value: { id: tagId, name: '生活', revision: '1' } };
  const request = vi.fn(async (path) => path.includes('/pages?')
    ? { records: [record], hasMore: false, nextPageCursor: null, baselineCursor: 'signed.baseline' }
    : { snapshotId: id, status: 'ready', recordCount: '1' });
  const create = () => createSnapshotDownloader({ mirror: store.syncMirror, request, isCurrent: () => current });
  return { store, id, record, request, create, switchAccount: () => { current = false; } };
}
it('persists request identity before HTTP and reuses it after an unknown POST result and restart', async () => {
  const h = harness(); let firstId;
  h.request.mockImplementationOnce(async (_path, options) => {
    firstId = options.body.requestId;
    expect((await h.store.syncMirror.state()).request.requestId).toBe(firstId);
    throw new Error('network response lost');
  });
  await expect(h.create().step()).rejects.toThrow('network');
  h.store.db.close(); await h.store.db.open();
  expect((await h.create().step()).status).toBe('ready');
  expect(h.request.mock.calls[1][1].body.requestId).toBe(firstId);
  expect(await h.store.syncMirror.records()).toEqual([h.record]);
});
it('does not persist a late response after switching accounts', async () => {
  const h = harness();
  h.request.mockImplementationOnce(async () => { h.switchAccount(); return { snapshotId: h.id, status: 'ready', recordCount: '1' }; });
  await expect(h.create().step()).rejects.toMatchObject({ code: 'SYNC_CONTEXT_CHANGED' });
  expect((await h.store.syncMirror.state()).request.snapshotId).toBeNull();
  expect(await h.store.syncMirror.records()).toEqual([]);
});
it('shares one in-flight step and returns a waiting result instead of polling in a loop', async () => {
  const h = harness(); h.request.mockResolvedValue({ snapshotId: h.id, status: 'running' });
  const worker = h.create(), first = worker.step(), second = worker.step();
  expect(first).toBe(second); expect((await first).status).toBe('waiting');
  expect(h.request).toHaveBeenCalledTimes(1);
});
it('keeps durable page position after download failure, then resumes it', async () => {
  const h = harness();
  h.request.mockImplementation(async (path) => {
    if (!path.includes('/pages?')) return { snapshotId: h.id, status: 'ready', recordCount: '1' };
    throw new Error('offline');
  });
  await expect(h.create().step()).rejects.toThrow('offline');
  expect((await h.store.syncMirror.state()).staging.received).toBe(0);
  h.request.mockImplementation(async (path) => path.includes('/pages?')
    ? { records: [h.record], hasMore: false, nextPageCursor: null, baselineCursor: 'signed.baseline' }
    : { snapshotId: h.id, status: 'ready', recordCount: '1' });
  expect((await h.create().step()).status).toBe('ready');
  expect(h.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
