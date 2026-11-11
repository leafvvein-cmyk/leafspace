import { createSnapshotDownloader, retryFailedSnapshot } from './snapshot-downloader.js';

// Pulling remote data is not upload acknowledgement. UI must show those separately.
export function createSyncPuller({ mirror, request, isCurrent }) {
  const snapshot = createSnapshotDownloader({ mirror, request, isCurrent });
  let running;
  function check() { if (!isCurrent()) throw Object.assign(new Error('账号已切换，同步已停止'), { code: 'SYNC_CONTEXT_CHANGED' }); }
  async function checked(task) { check(); const value = await task(); check(); return value; }
  async function advance() {
    const state = await checked(() => mirror.state());
    if (!state.active || state.request || state.staging) {
      const result = await snapshot.step(); check();
      return result.status === 'ready' ? { status: 'snapshot-ready', retryAfterMs: 0, changed: Boolean(result.changed) } : result;
    }
    try {
      const query = new URLSearchParams({ cursor: state.active.cursor, limit: '50' });
      const page = await checked(() => request(`/sync/changes?${query}`));
      await checked(() => mirror.applyChanges(state.active.cursor, page));
      return { status: page.hasMore ? 'downloading' : 'idle', retryAfterMs: page.hasMore ? 0 : 30000, changed: page.events.length > 0 };
    } catch (error) {
      if (['SYNC_CURSOR_EXPIRED', 'SYNC_RESNAPSHOT_REQUIRED'].includes(error.code)) {
        await checked(() => mirror.requestSnapshot());
        return { status: 'rebuilding', retryAfterMs: 0 };
      }
      throw error;
    }
  }
  return { recoverFailed: () => retryFailedSnapshot({ mirror, request, isCurrent }),
    step() { return running ??= advance().finally(() => { running = undefined; }); } };
}
