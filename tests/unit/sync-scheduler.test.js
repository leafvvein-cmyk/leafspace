import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSyncScheduler, syncDownloadLabel } from '../../apps/client/src/services/sync-scheduler.js';

const schedulers = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { schedulers.splice(0).forEach((value) => value.destroy()); vi.useRealTimers(); });
function setup(options = {}) {
  const events = new EventTarget(), visibilityEvents = new EventTarget();
  const puller = { step: vi.fn().mockResolvedValue({ status: 'idle', retryAfterMs: 30000 }) };
  const locks = { request: vi.fn(async (_name, _options, work) => work({})) };
  const onState = vi.fn();
  const scheduler = createSyncScheduler({ puller, locks, namespace: 'user:test',
    isCurrent: () => true, online: () => true, visible: () => true,
    events, visibilityEvents, random: () => 1, onState, ...options });
  schedulers.push(scheduler);
  return { scheduler, puller, locks, events, visibilityEvents, onState };
}
it('downloads under a separate account lock and polls without claiming uploads', async () => {
  const h = setup(); h.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  expect(h.locks.request).toHaveBeenCalledWith('diary-v2:sync:user:test', { mode: 'exclusive', ifAvailable: true }, expect.any(Function));
  expect(h.scheduler.view().status).toBe('idle');
  expect(syncDownloadLabel('idle')).toContain('仅下载');
  await vi.advanceTimersByTimeAsync(29999); expect(h.puller.step).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(h.puller.step).toHaveBeenCalledTimes(2);
});
it('publishes a one-shot changed signal when a pull applied remote data', async () => {
  const h = setup(); h.puller.step.mockResolvedValueOnce({ status: 'idle', retryAfterMs: 30000, changed: true });
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle', changed: true }));
  h.scheduler.retry(); await vi.advanceTimersByTimeAsync(0);
  expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'idle', changed: false }));
});
it('pauses offline and hidden, and resumes on matching lifecycle events', async () => {
  let online = false, visible = true;
  const h = setup({ online: () => online, visible: () => visible });
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(60000);
  expect(h.scheduler.view().status).toBe('offline'); expect(h.puller.step).not.toHaveBeenCalled();
  online = true; h.events.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0);
  expect(h.puller.step).toHaveBeenCalledTimes(1);
  visible = false; h.visibilityEvents.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60000); expect(h.puller.step).toHaveBeenCalledTimes(1);
  visible = true; h.visibilityEvents.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0); expect(h.puller.step).toHaveBeenCalledTimes(2);
});
it('backs off repeated network errors and allows immediate manual retry', async () => {
  const h = setup(); h.puller.step.mockRejectedValue(new Error('network'));
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  expect(h.scheduler.view().status).toBe('retrying');
  await vi.advanceTimersByTimeAsync(1999); expect(h.puller.step).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(h.puller.step).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3999); expect(h.puller.step).toHaveBeenCalledTimes(2);
  h.scheduler.retry(); await vi.advanceTimersByTimeAsync(0); expect(h.puller.step).toHaveBeenCalledTimes(3);
});
it('does not overlap steps or publish a late success after account invalidation', async () => {
  let current = true, resolve;
  const h = setup({ isCurrent: () => current });
  h.puller.step.mockImplementation(() => new Promise((done) => { resolve = done; }));
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  h.scheduler.retry(); await vi.advanceTimersByTimeAsync(1000);
  expect(h.puller.step).toHaveBeenCalledTimes(1);
  current = false; resolve({ status: 'idle', retryAfterMs: 30000 });
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.scheduler.view().status).toBe('stopped');
  expect(h.onState.mock.calls.some(([state]) => state.status === 'idle')).toBe(false);
  expect(h.puller.step).toHaveBeenCalledTimes(1);
});
it('runs one immediate follow-up when a local change wakes an active step', async () => {
  let resolve;
  const h = setup();
  h.puller.step.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  h.scheduler.retry(); await vi.advanceTimersByTimeAsync(1000);
  expect(h.puller.step).toHaveBeenCalledTimes(1);
  resolve({ status: 'idle', retryAfterMs: 30000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.puller.step).toHaveBeenCalledTimes(2);
});
it('yields to another tab without invoking the puller', async () => {
  const h = setup({ locks: { request: async (_name, _options, work) => work(null) } });
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  expect(h.scheduler.view().status).toBe('another-window'); expect(h.puller.step).not.toHaveBeenCalled();
});
it('fails closed without browser locks but supports the native single coordinator', async () => {
  const web = setup({ locks: null }); web.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  expect(web.scheduler.view().status).toBe('unsupported'); expect(web.puller.step).not.toHaveBeenCalled();
  const native = setup({ locks: null, native: true }); native.scheduler.start(); await vi.advanceTimersByTimeAsync(0);
  expect(native.puller.step).toHaveBeenCalledTimes(1);
});
it('stops automatic retries for terminal failures and removes listeners on destruction', async () => {
  const h = setup(); h.puller.step.mockRejectedValue(Object.assign(new Error('failed'), { code: 'SNAPSHOT_FAILED' }));
  h.scheduler.start(); await vi.advanceTimersByTimeAsync(600000);
  expect(h.scheduler.view().status).toBe('failed'); expect(h.puller.step).toHaveBeenCalledTimes(1);
  h.scheduler.destroy(); h.scheduler.start(); h.events.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(600000); expect(h.puller.step).toHaveBeenCalledTimes(1);
});
