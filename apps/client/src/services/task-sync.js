const fields = ['title','note','dueAt','timezone','priority','recurrence','reminderMinutesBefore','checklist','linkedEntryId'];
const payload = (task) => Object.fromEntries(fields.map((key) => [key, structuredClone(task[key])]));
const samePayload = (first, second) => fields.every((key) => JSON.stringify(first[key]) === JSON.stringify(second[key]));
const actions = (task) => (task.actions ?? []).map(({ id, type, label, target }) => ({ id, type, label, target }));
const sameActions = (first, second) => JSON.stringify(actions(first)) === JSON.stringify(actions(second));

export function createTaskSync({ store, request, isCurrent = () => true }) {
  let running = null;
  async function load(id) {
    try { return await request(`/tasks/${id}`); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async function executeJob(job) {
    let remote = await load(job.taskId), local = job.payload;
    if (!remote) {
      const result = await request('/tasks', { method: 'POST', body: { taskId: local.id, requestId: job.requestIds.create, payload: payload(local) } });
      remote = result.task;
    } else if (local.revision !== '0' && local.revision !== remote.revision) {
      const error = new Error('待办已在其他设备修改'); error.code = 'REVISION_CONFLICT'; error.remote = remote; throw error;
    }

    if (remote.status === 'trash' && local.status !== 'trash') {
      remote = (await request(`/tasks/${local.id}/restore`, { method: 'POST', body: { requestId: job.requestIds.restore, baseRevision: remote.revision } })).task;
    }
    if (!samePayload(local, remote)) {
      remote = (await request(`/tasks/${local.id}`, { method: 'PATCH', body: { requestId: job.requestIds.update, baseRevision: remote.revision, patch: payload(local) } })).task;
    }
    if (!sameActions(local, remote)) {
      if (!job.requestIds.actions) throw new Error('旧版待办同步请求缺少快捷动作编号，请重新编辑这条待办后重试');
      remote = (await request(`/tasks/${local.id}/actions`, { method: 'PUT', body: { requestId: job.requestIds.actions, baseRevision: remote.revision, actions: actions(local) } })).task;
    }
    if (local.status === 'trash' && remote.status !== 'trash') {
      remote = (await request(`/tasks/${local.id}?baseRevision=${encodeURIComponent(remote.revision)}`, { method: 'DELETE', idempotencyKey: job.requestIds.state })).task;
    } else if (local.status === 'completed' && remote.status !== 'completed') {
      remote = (await request(`/tasks/${local.id}/complete`, { method: 'POST', body: { requestId: job.requestIds.state, baseRevision: remote.revision } })).task;
    } else if (local.status === 'open' && remote.status === 'completed') {
      remote = (await request(`/tasks/${local.id}/reopen`, { method: 'POST', body: { requestId: job.requestIds.state, baseRevision: remote.revision } })).task;
    }
    return remote;
  }
  async function pull() {
    let cursor = null;
    do {
      if (!isCurrent()) throw new Error('登录账号已变化，待办同步已停止');
      const page = await request(`/tasks?state=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      await store.applyTaskCloudItems(page.items); cursor = page.nextCursor;
    } while (cursor);
  }
  async function execute() {
    for (let count = 0; count < 500; count++) {
      if (!isCurrent()) throw new Error('登录账号已变化，待办同步已停止');
      const job = await store.nextTaskSyncJob(); if (!job) break;
      try { await store.completeTaskSyncJob(job.id, await executeJob(job)); }
      catch (error) {
        if (error.code === 'REVISION_CONFLICT') {
          await store.failTaskSyncJob(job.id, error.remote ?? error.details?.currentTask ?? null); continue;
        }
        throw error;
      }
    }
    await pull(); return store.taskSyncSummary();
  }
  return {
    run() { if (!running) running = execute().finally(() => { running = null; }); return running; },
    summary: () => store.taskSyncSummary(),
    conflicts: () => store.listTaskConflicts(),
    async resolve(jobId, choice) { await store.resolveTaskConflict(jobId, choice); return this.run(); },
  };
}
