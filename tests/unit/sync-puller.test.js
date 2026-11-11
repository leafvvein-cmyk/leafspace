import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { createSyncPuller } from '../../apps/client/src/services/sync-puller.js';
const stores = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.db.delete(); });
async function harness() {
  const store = createLocalStore(`user:${crypto.randomUUID()}`); stores.push(store);
  const id = crypto.randomUUID(), snapshotId = crypto.randomUUID();
  const record = { entity: 'tag', id, value: { id, name: '生活', revision: '1' } };
  await store.syncMirror.begin({ snapshotId, recordCount: 1 });
  await store.syncMirror.append(snapshotId, null, { records: [record], hasMore: false, nextPageCursor: null, baselineCursor: 'baseline.signed' });
  await store.syncMirror.commit(snapshotId);
  let current = true;
  const request = vi.fn();
  const puller = createSyncPuller({ mirror: store.syncMirror, request, isCurrent: () => current });
  return { store, record, request, puller, switchAccount: () => { current = false; } };
}
it('rebuilds after an expired cursor but preserves the old mirror', async () => {
  const h = await harness(); h.request.mockRejectedValue(Object.assign(new Error('expired'), { code: 'SYNC_CURSOR_EXPIRED' }));
  expect((await h.puller.step()).status).toBe('rebuilding');
  expect(await h.store.syncMirror.records()).toEqual([h.record]);
  expect((await h.store.syncMirror.state()).request.requestId).toBeTruthy();
});
it('keeps the cursor and creates no replacement job on a network failure', async () => {
  const h = await harness(); h.request.mockRejectedValue(new Error('offline'));
  await expect(h.puller.step()).rejects.toThrow('offline');
  const state = await h.store.syncMirror.state(); expect(state.active.cursor).toBe('baseline.signed'); expect(state.request).toBeNull();
});
it('does not apply an increment received after an account switch', async () => {
  const h = await harness();
  h.request.mockImplementation(async () => { h.switchAccount(); return { events: [], hasMore: false, nextCursor: 'next.signed' }; });
  await expect(h.puller.step()).rejects.toMatchObject({ code: 'SYNC_CONTEXT_CHANGED' });
  expect((await h.store.syncMirror.state()).active.cursor).toBe('baseline.signed');
});
it('returns an idle delay when the current round is caught up, not an upload success', async () => {
  const h = await harness(); h.request.mockResolvedValue({ events: [], hasMore: false, nextCursor: 'next.signed' });
  expect(await h.puller.step()).toEqual({ status: 'idle', retryAfterMs: 30000, changed: false });
  expect((await h.store.syncMirror.state()).active.cursor).toBe('next.signed');
});
