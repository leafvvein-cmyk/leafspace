import { expect, it, vi } from 'vitest';
import { createSyncCoordinator, syncSummaryLabel } from '../../apps/client/src/services/sync-coordinator.js';

function setup() {
  let current = true;
  const generation = crypto.randomUUID();
  const mirror = { state: vi.fn(async () => ({ active: { cursor: 'cursor', snapshotPosition: { generation, seq: '0' } }, request: null, staging: null })), applyChanges: vi.fn() };
  const queue = { next: vi.fn(async () => null), complete: vi.fn(async () => ({ status: 'acknowledged' })),
    summary: vi.fn(async () => ({ pending: 0, waiting: 0, blocked: 0, localTrash: 0, unverified: 0 })) };
  const request = vi.fn(async () => ({ events: [], hasMore: false, nextCursor: 'next' }));
  const coordinator = createSyncCoordinator({ mirror, queue, request, isCurrent: () => current });
  return { coordinator, mirror, queue, request, invalidate: () => { current = false; } };
}
it('checks downloads before uploads and idles only after both are checked', async () => {
  const h = setup();
  expect((await h.coordinator.step()).status).toBe('idle');
  expect(h.queue.next).not.toHaveBeenCalled(); expect(h.coordinator.activity()).toBe('uploading');
  expect(await h.coordinator.step()).toMatchObject({ status: 'sync-idle', retryAfterMs: 30000 });
  expect(h.queue.next).toHaveBeenCalledTimes(1); expect(h.coordinator.activity()).toBe('downloading');
});
it('retains the upload phase for an ambiguous failure and does not claim confirmation', async () => {
  const h = setup(), mutation = { mutationId: crypto.randomUUID() };
  await h.coordinator.step(); h.queue.next.mockResolvedValue({ mutation });
  h.request.mockRejectedValueOnce(new Error('lost response'));
  await expect(h.coordinator.step()).rejects.toThrow('lost response');
  expect(h.coordinator.activity()).toBe('uploading'); expect(h.queue.complete).not.toHaveBeenCalled();
  h.request.mockResolvedValueOnce({ results: [{ mutationId: mutation.mutationId, status: 'replayed' }] });
  expect((await h.coordinator.step()).status).toBe('upload-processed');
  expect(h.queue.complete).toHaveBeenCalledWith(mutation.mutationId, expect.objectContaining({ status: 'replayed' }));
});
it.each(['blocked', 'localTrash', 'unverified'])('does not equate no sendable work with full confirmation when %s exists', async (field) => {
  const h = setup(); h.queue.summary.mockResolvedValue({ pending: 0, waiting: 0, blocked: 0, localTrash: 0, unverified: 0, [field]: 1 });
  await h.coordinator.step(); const result = await h.coordinator.step();
  expect(result.status).toBe('attention'); expect(syncSummaryLabel(result.summary)).toContain('1 篇');
});
it('stops after a late download changes the account context', async () => {
  const h = setup(); h.request.mockImplementation(async () => { h.invalidate(); return { events: [], hasMore: false, nextCursor: 'next' }; });
  await expect(h.coordinator.step()).rejects.toMatchObject({ code: 'SYNC_CONTEXT_CHANGED' });
  expect(h.mirror.applyChanges).not.toHaveBeenCalled(); expect(h.queue.next).not.toHaveBeenCalled();
});
it('continues checking downloads when the remote round still has pages', async () => {
  const h = setup(); h.request.mockResolvedValue({ events: [], hasMore: true, nextCursor: 'next' });
  await h.coordinator.step(); expect((await h.coordinator.step()).status).toBe('downloading');
  expect(h.coordinator.activity()).toBe('downloading');
});
