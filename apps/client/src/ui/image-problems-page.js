import { h, button, icon, toast } from './dom.js';

function entryTitle(entry) {
  return entry?.title?.trim() || (entry?.kind === 'daily' ? `${entry.entryDate} 的日记` : '未命名随记');
}

export async function imageProblemsPage({ store, navigate, alive = () => true, reportError = () => {} }) {
  const root = h('div', { className: 'asset-problems' });
  const problems = await store.listAssetProblems();
  if (!problems.length) {
    root.append(h('div', { className: 'empty-state' }, h('div', { className: 'empty-icon' }, icon('image', 32)),
      h('h2', {}, '没有待处理的图片'), h('p', {}, '连续上传失败的图片会保留在此设备，并显示在这里供你手动重试。'),
      button('返回设置', () => navigate('/settings'))));
    return root;
  }

  root.append(h('p', { className: 'notice', role: 'status' }, `有 ${problems.length} 张图片连续上传失败。原图仍保存在此设备；请检查网络后逐项重试。`));
  const list = h('div', { className: 'settings-layout asset-problem-list' });
  root.append(list);
  for (const problem of problems) {
    const entry = await store.get(problem.entryId);
    const retry = button('重新上传', async () => {
      if (retry.disabled) return;
      retry.disabled = true;
      try {
        await store.retryAssetUpload(problem.id);
        if (!alive()) return;
        card.remove();
        toast('图片已重新加入上传队列。');
        if (!list.childElementCount) {
          root.replaceChildren(h('div', { className: 'empty-state' }, h('div', { className: 'empty-icon' }, icon('check', 32)),
            h('h2', {}, '图片已重新加入队列'), h('p', {}, '联网时会自动继续上传；同步状态可在“同步与冲突”中查看。'),
            button('返回设置', () => navigate('/settings'))));
        }
      } catch (error) { retry.disabled = false; reportError(error); }
    }, { className: 'button primary' });
    const card = h('section', { className: 'settings-card asset-problem-card', 'data-asset-id': problem.id },
      h('div', { className: 'asset-problem-heading' }, h('span', { className: 'asset-problem-icon' }, icon('image', 24)),
        h('div', {}, h('h2', {}, entryTitle(entry)), h('p', { className: 'muted' }, `${problem.uploadAttempts || 3} 次尝试均未完成`))),
      h('p', {}, problem.error?.message || '图片上传未完成，请检查网络后重试。'),
      h('p', { className: 'asset-error-code' }, `问题代码：${problem.error?.code || 'UPLOAD_FAILED'}`),
      h('div', { className: 'account-actions' }, entry && button('查看相关日记', () => navigate(`/entries/${problem.entryId}`)), retry));
    list.append(card);
  }
  return root;
}
