/** One instance is bound to one immutable account repository and auth epoch.
 * step() does at most one page, so the UI can schedule retries without a busy loop.
 * request is the existing authenticated client's request method (returns data).
 */
export async function retryFailedSnapshot({ mirror, request, isCurrent }) {
  const check = () => { if (!isCurrent()) throw Object.assign(new Error('账号已切换，同步已停止'), { code: 'SYNC_CONTEXT_CHANGED' }); };
  check(); const state = await mirror.state(); check();
  const pending = state.request;
  if (!pending?.snapshotId || state.staging?.complete) return { reset: false };
  const job = await request(`/sync/snapshots/${encodeURIComponent(pending.snapshotId)}`); check();
  if (job?.snapshotId !== pending.snapshotId) throw new Error('服务器返回了不同的快照任务');
  if (!['failed', 'expired'].includes(job.status)) return { reset: false };
  await mirror.resetRequest(pending.requestId, { restart: true }); check();
  return { reset: true };
}

export function createSnapshotDownloader({ mirror, request, isCurrent }) {
  let running;
  function check() { if (!isCurrent()) throw Object.assign(new Error('账号已切换，同步已停止'), { code: 'SYNC_CONTEXT_CHANGED' }); }
  async function checked(task) { check(); const result = await task(); check(); return result; }
  async function advance() {
    const initial = await checked(() => mirror.state());
    if (initial.staging?.complete) {
      const active = await checked(() => mirror.commit(initial.staging.snapshotId));
      return { status: 'ready', active, changed: true };
    }
    if (initial.active && !initial.request && !initial.staging) return { status: 'ready', active: initial.active, changed: false };
    const pending = await checked(() => mirror.requestSnapshot());
    try {
      let job;
      if (pending.snapshotId) job = await checked(() => request(`/sync/snapshots/${encodeURIComponent(pending.snapshotId)}`));
      else {
        job = await checked(() => request('/sync/snapshots', { method: 'POST', body: { requestId: pending.requestId } }));
        await checked(() => mirror.bindSnapshot(pending.requestId, job.snapshotId));
      }
      if (job.snapshotId !== (pending.snapshotId ?? job.snapshotId)) throw new Error('服务器返回了不同的快照任务');
      if (['queued', 'running'].includes(job.status)) return { status: 'waiting', retryAfterMs: 1500 };
      if (job.status === 'expired') {
        await checked(() => mirror.resetRequest(pending.requestId));
        return { status: 'expired', retryAfterMs: 1500 };
      }
      if (job.status === 'failed') throw Object.assign(new Error('快照生成失败，请稍后手动重试'), { code: 'SNAPSHOT_FAILED' });
      if (job.status !== 'ready' || typeof job.recordCount !== 'string' || !/^(0|[1-9]\d*)$/.test(job.recordCount)) throw new Error('快照任务响应无效');
      const stage = await checked(() => mirror.begin({ snapshotId: job.snapshotId, recordCount: Number(job.recordCount) }));
      const query = new URLSearchParams({ limit: '50' });
      if (stage.nextPageCursor) query.set('pageCursor', stage.nextPageCursor);
      const page = await checked(() => request(`/sync/snapshots/${encodeURIComponent(job.snapshotId)}/pages?${query}`));
      const saved = await checked(() => mirror.append(job.snapshotId, stage.nextPageCursor, page));
      if (!saved.complete) return { status: 'downloading', received: saved.received, total: saved.expectedCount, retryAfterMs: 0 };
      return { status: 'ready', active: await checked(() => mirror.commit(job.snapshotId)), changed: true };
    } catch (error) {
      if (error.code === 'SNAPSHOT_EXPIRED') {
        await checked(() => mirror.resetRequest(pending.requestId));
        return { status: 'expired', retryAfterMs: 1500 };
      }
      // Unknown POST outcomes keep their request ID; failed page writes keep cursor.
      throw error;
    }
  }
  return { step() { return running ??= advance().finally(() => { running = undefined; }); } };
}
