import { h, button } from './dom.js';

export async function exportsPage({ store, request, alive, reportError, downloadUrl }) {
  const root = h('section', { className: 'settings-layout' });
  let pending = await store.getSetting('pending-cloud-export', null), busy = false, cursor = null;
  const format = h('select', {}, h('option', { value: 'markdown_zip' }, 'Markdown ZIP'), h('option', { value: 'json_zip' }, 'JSON ZIP'));
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date' });
  const kind = h('select', {}, h('option', { value: '' }, '全部类型'), h('option', { value: 'daily' }, '每日一页'), h('option', { value: 'moment' }, '随记'));
  const includeImages = h('input', { type: 'checkbox', checked: true });
  const status = h('p', { role: 'status', className: 'muted' }), list = h('div', { className: 'settings-layout' });
  const active = () => alive() && root.isConnected;
  const controls = () => { [format, from, to, kind, includeImages].forEach((input) => { input.disabled = busy || Boolean(pending); }); create.disabled = busy; create.querySelector('span').textContent = pending ? '重试上次导出请求' : '创建云端导出'; };
  const create = button('创建云端导出', async () => {
    if (!active() || busy) return;
    busy = true; controls();
    try {
      if (!pending) {
        if (!from.checkValidity() || !to.checkValidity() || from.value && to.value && from.value > to.value) throw new Error('请检查日期范围');
        pending = { requestId: crypto.randomUUID(), format: format.value, includeImages: includeImages.checked,
          ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}), ...(kind.value ? { kind: kind.value } : {}) };
        await store.setSetting('pending-cloud-export', pending);
      }
      const job = await request('/exports', { method: 'POST', body: pending });
      await store.setSetting('pending-cloud-export', null); pending = null;
      if (!active()) return;
      status.textContent = `任务已登记：${job.jobId}。请刷新查看生成进度。`;
      await load(true);
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) { await store.setSetting('pending-cloud-export', null); pending = null; }
      if (active()) { status.textContent = '请求未完成；重试会沿用原请求编号。'; reportError(error); }
    } finally { busy = false; controls(); }
  }, { className: 'button primary' });
  const more = button('加载更多任务', () => load(false), { hidden: true });
  const refresh = button('刷新任务状态', () => load(true));
  let loading = false;
  async function load(reset) {
    if (!active() || loading) return;
    loading = true; refresh.disabled = true; more.disabled = true;
    try {
      const page = await request(`/exports${!reset && cursor ? `?before=${cursor}` : ''}`);
      if (!active()) return;
      if (reset) list.replaceChildren();
      for (const job of page.items) {
        const names = { queued: '排队中', running: '生成中', ready: '可下载', failed: '生成失败', cancelled: '已取消', expired: '已过期' };
        const download = button('申请私有下载链接', async () => {
          if (!active() || download.disabled) return;
          download.disabled = true;
          try {
            const link = await request(`/exports/${job.jobId}/download`, { method: 'POST' });
            if (active()) download.replaceWith(h('a', { className: 'button primary', href: downloadUrl(link.url, job.jobId), target: '_blank', rel: 'noopener noreferrer' }, '下载 ZIP（链接短时有效）'));
          } catch (error) { if (active()) reportError(error); }
          finally { download.disabled = false; }
        });
        const cancel = button('取消并清理导出副本', async () => {
          if (!active() || cancel.disabled || !window.confirm('取消这个导出任务并清理其临时副本？原日记不会删除。')) return;
          cancel.disabled = true;
          try { await request(`/exports/${job.jobId}`, { method: 'DELETE' }); if (active()) await load(true); }
          catch (error) { if (active()) reportError(error); }
          finally { cancel.disabled = false; }
        });
        list.append(h('section', { className: 'settings-card' }, h('h2', {}, names[job.status] ?? '状态待确认'),
          h('p', { className: 'muted' }, `创建时间：${new Date(job.createdAt).toLocaleString()} · ${job.progress}%`),
          job.expiresAt && h('p', {}, `有效期至：${new Date(job.expiresAt).toLocaleString()}`),
          job.error && h('p', { className: 'notice' }, '任务生成失败，请缩小范围或稍后重新创建。'),
          h('div', { className: 'account-actions' }, job.status === 'ready' && download, ['queued', 'running', 'ready', 'failed'].includes(job.status) && cancel)));
      }
      cursor = page.nextCursor; more.hidden = !page.hasMore;
      if (!list.childElementCount) status.textContent = '还没有云端导出任务。';
    } catch (error) { if (active()) reportError(error); }
    finally { loading = false; refresh.disabled = false; more.disabled = false; }
  }
  root.append(h('p', { className: 'notice' }, '云端导出只包含任务开始时已经同步的固定版本；勾选图片时会把这些日记引用的云端原图放入 ZIP。导出文件未加密，请妥善保存。'),
    h('section', { className: 'settings-card' }, h('label', {}, '格式', format), h('label', {}, '开始日期（可留空）', from), h('label', {}, '结束日期（可留空）', to), h('label', {}, '记录类型', kind),
      h('label', { className: 'checkbox-row' }, includeImages, '包含已同步图片'), create),
    status, refresh, list, more);
  controls();
  return { root, load: () => load(true) };
}
