import { h, button, downloadFile } from './dom.js';
import { readingContent } from './reading.js';

export function conflictReason(code) {
  return ({ REVISION_CONFLICT: '其他设备保存了不同版本', DAILY_ALREADY_EXISTS: '这个日期已有每日记录',
    ENTRY_TRASHED: '日记已在云端移到回收站', ENTRY_PURGED: '日记已在云端永久删除，不能恢复原编号',
    ASSET_NOT_READY: '图片尚未上传完成', LOCAL_CONFLICT: '本机出现了不同版本',
  })[code] ?? '上传未完成，需要检查保留的内容';
}

export function conflictComparison(bundle, { namespace, navigate, isCurrent, reportError, copyConflict, keepCloud, readRemoteEntry }) {
  const { record, latestLocal } = bundle;
  function version(title, entry, selected) {
    let body;
    try { body = entry?.content ? readingContent(entry.content) : h('p', { className: 'muted' }, '没有可显示的正文。'); }
    catch { body = h('p', { className: 'notice' }, '正文格式暂时无法显示，请先导出备份。'); }
    return h('section', { className: `settings-card conflict-version${selected ? ' is-selected' : ''}`, 'aria-label': title },
      h('p', { className: 'eyebrow' }, title), h('h2', {}, entry?.title || '无标题记录'),
      entry && h('p', { className: 'muted' }, `${entry.entryDate ?? ''} · ${entry.deletedAt ? '回收站' : '未删除'} · 版本 ${entry.revision ?? '本机'}`), body);
  }
  const local = version('冲突时保留的本机稿', record.local, true), remote = version('冲突时返回的另一版本', record.remote, false);
  const tabs = [];
  const choose = (index) => {
    [local, remote].forEach((panel, i) => panel.classList.toggle('is-selected', i === index));
    tabs.forEach((tab, i) => tab.setAttribute('aria-pressed', String(i === index)));
  };
  tabs.push(button('本机稿', () => choose(0), { 'aria-pressed': 'true' }), button('另一版本', () => choose(1), { 'aria-pressed': 'false' }));
  const copyButton = button(record.copyEntryId ? '打开已另存的随记' : '将冲突时本机稿另存为随记', async () => {
    if (!isCurrent() || copyButton.disabled) return;
    copyButton.disabled = true;
    try {
      const result = await copyConflict(record.id);
      if (!isCurrent()) return;
      copyButton.querySelector('span').textContent = '打开已另存的随记';
      await navigate(`/entries/${result.entryId}`);
    } catch (error) { reportError(error); }
    finally { copyButton.disabled = false; }
  }, { className: 'button primary' });
  const cloudButton = button('读取云端版本并确认保留', async () => {
    if (!isCurrent() || cloudButton.disabled) return;
    cloudButton.disabled = true;
    try {
      const cloud = await readRemoteEntry(record.entryId);
      if (!isCurrent()) return;
      const dialog = h('dialog', { className: 'confirmation' });
      const close = () => { dialog.close(); dialog.remove(); cloudButton.disabled = false; };
      const accept = button('确认保留这个云端版本', async () => {
        if (!isCurrent() || accept.disabled) { close(); return; }
        accept.disabled = true;
        try {
          const result = await keepCloud(record.id, { expectedLocalRevision: latestLocal?.localRevision, remote: cloud });
          close();
          if (isCurrent()) await navigate(`/entries/${result.entryId}`);
        } catch (error) { close(); if (isCurrent()) reportError(error); }
      }, { className: 'button primary' });
      dialog.append(h('h2', {}, '确认使用云端内容？'),
        h('p', {}, '这会停止原记录尚未发送的本机修改；本机稿会归档在冲突备份中。上传结果未确认时不会执行。'),
        version('刚读取的云端版本', cloud, true),
        h('div', { className: 'account-actions' }, button('取消', close), accept));
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
      cloudButton.closest('.account-actions').append(dialog);
      dialog.showModal();
    } catch (error) { cloudButton.disabled = false; if (isCurrent()) reportError(error); }
  });
  return h('div', {}, h('p', { className: 'notice' }, record.resolution?.kind === 'keep-cloud'
    ? '此冲突已选择保留云端版本，本机备份仍可导出。'
    : record.resolution?.kind === 'merged-local' ? '合并结果已在本机保存，上传结果请查看同步中心；原稿和合并草稿仍可导出。' : conflictReason(record.error?.code ?? 'LOCAL_CONFLICT')),
    h('p', { className: 'muted' }, '这里显示冲突发生时保留的版本，不是实时云端内容。查看或导出不会解除冲突，也不会覆盖任何日记。'),
    h('div', { className: 'account-actions' }, button('返回同步中心', () => navigate('/sync')),
      latestLocal && button('查看当前日记', () => navigate(`/entries/${record.entryId}`)),
      record.local && copyButton,
      record.local && !record.resolution && button(record.mergeDraft ? '继续编辑合并草稿' : '手动编辑合并草稿', () => navigate(`/conflicts/${record.id}/merge`)),
      readRemoteEntry && !record.resolution && cloudButton,
      button('导出这次冲突备份', async () => {
        try {
          if (!isCurrent()) return;
          await downloadFile(`日记冲突-${record.id}.json`, JSON.stringify({ exportSchemaVersion: 1, source: 'conflict-backup', namespace,
            exportedAt: new Date().toISOString(), conflict: record, latestLocal }, null, 2));
        } catch (error) { reportError(error); }
      }, { glyph: 'download' })),
    h('p', { className: 'muted' }, '另存使用新编号，账号空间内会尝试上传副本；不会放弃原记录或解除原冲突。备份为明文，请妥善保存。'),
    h('div', { className: 'conflict-mobile-tabs', role: 'group', 'aria-label': '选择比较版本' }, tabs),
    h('div', { className: 'conflict-columns' }, local, remote));
}
