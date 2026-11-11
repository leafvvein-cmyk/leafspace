export function createSyncUploader({ queue, request, isCurrent }) {
  let running;
  const check = () => { if (!isCurrent()) throw Object.assign(new Error('账号已切换，上传已停止'), { code: 'SYNC_CONTEXT_CHANGED' }); };
  async function step() {
    check(); const job = await queue.next(); check();
    if (!job) return { status: 'no-upload-work' };
    // The immutable job was committed before any HTTP request can be sent.
    const response = await request('/sync/mutations', { method: 'POST', body: { mutations: [job.mutation] } });
    check();
    if (!Array.isArray(response?.results) || response.results.length !== 1) throw new Error('上传响应格式无效');
    const result = await queue.complete(job.mutation.mutationId, response.results[0]); check();
    return result;
  }
  return { step: () => running ??= step().finally(() => { running = undefined; }) };
}
