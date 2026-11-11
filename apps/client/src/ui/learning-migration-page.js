import { h, button, toast } from './dom.js';

export async function learningMigrationPage({ migration, navigate }) {
  const root = h('section', { className: 'settings-layout migration-page' });
  const status = h('p', { role: 'status', className: 'muted' });
  const preview = await migration.preview();
  const card = h('section', { className: 'settings-card' }, button('返回设置', () => navigate('/settings'), { className: 'text-button' }),
    h('p', { className: 'eyebrow' }, '明确复制，不自动归属'), h('h1', {}, '复制学习空间内容'),
    h('p', {}, `目标账号：${migration.targetLabel}。源学习空间会完整保留；账号里的现有日记不会被删除或覆盖。`),
    h('div', { className: 'stats-row' },
      h('div', {}, h('strong', {}, preview.total), h('span', {}, '项内容')),
      h('div', {}, h('strong', {}, preview.images), h('span', {}, '张本机图片'))),
    h('p', { className: 'muted' }, `其中正常记录 ${preview.active} 篇、回收站 ${preview.trash} 篇、未成篇草稿 ${preview.drafts} 项。每日记录遇到同日账号内容时会进入冲突中心，不会覆盖。`), status);
  root.append(card);
  if (!preview.total) {
    card.append(h('p', { className: 'notice' }, '学习空间目前没有需要复制的内容。'), button('回到账号日记', migration.openAccount, { className: 'button primary' }));
    return root;
  }
  const acknowledged = h('input', { type: 'checkbox' });
  const copy = button('复制到这个账号', async () => {
    if (!acknowledged.checked || copy.disabled) return;
    copy.disabled = true; acknowledged.disabled = true; status.textContent = '正在复制，请保持页面打开…';
    try {
      const result = await migration.copy((progress) => { if (root.isConnected) status.textContent = `正在复制 ${progress.done}/${progress.total}…`; });
      if (!root.isConnected) return;
      status.textContent = result.reused ? '这些版本以前已经复制过，没有建立重复副本。'
        : `已复制 ${result.copied} 项；${result.conflicts} 项进入冲突中心；缺少 ${result.missingImages} 张源图片。`;
      toast('学习空间复制操作已完成，源内容仍保留。');
      actions.append(button('打开账号日记并开始同步', migration.openAccount, { className: 'button primary' }),
        result.conflicts > 0 && button('进入账号后查看冲突', () => migration.openAccount('/sync')));
    } catch (error) {
      status.textContent = `复制没有完成：${error.message}。源学习空间没有删除，请保留页面并重试。`;
      copy.disabled = false; acknowledged.disabled = false;
    }
  }, { className: 'button primary', disabled: true });
  acknowledged.addEventListener('change', () => { copy.disabled = !acknowledged.checked; });
  const actions = h('div', { className: 'account-actions' }, button('先导出学习空间备份', migration.exportSource, { glyph: 'download' }), copy);
  card.append(h('label', { className: 'checkbox-row' }, acknowledged, `我确认把以上内容复制到账号“${migration.targetLabel}”，并保留原学习空间`), actions,
    h('p', { className: 'muted' }, '重复操作只复制新增或变更的源内容。图片和记录会改用新的内部编号，避免与账号现有数据混淆。'));
  return root;
}
