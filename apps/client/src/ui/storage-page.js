import { h, button, toast } from './dom.js';

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function storagePage({ store, navigate, alive = () => true, reportError = () => {} }) {
  const root = h('div', { className: 'settings-layout storage-page' });
  const summary = await store.storageSummary();
  const clear = button('清理可重新下载的缓存', async () => {
    if (clear.disabled || !window.confirm(`清理 ${summary.cacheCount} 张云端图片缓存？再次查看时需要联网下载；本机原图和未上传内容不会删除。`)) return;
    clear.disabled = true;
    try {
      const result = await store.clearDownloadedAssetCache();
      if (!alive()) return;
      toast(`已清理 ${result.clearedCount} 张缓存（${sizeLabel(result.clearedBytes)}）。`);
      await navigate('/settings/storage', { replace: true });
    } catch (error) { clear.disabled = false; reportError(error); }
  }, { className: 'button danger', disabled: !summary.cacheCount });
  root.append(
    h('section', { className: 'settings-card storage-summary-card' }, button('返回设置', () => navigate('/settings'), { className: 'text-button' }),
      h('h2', {}, '本机存储概览'), h('div', { className: 'storage-stats' },
        h('div', {}, h('strong', {}, summary.protectedCount), h('span', {}, `本机原件 · ${sizeLabel(summary.protectedBytes)}`)),
        h('div', {}, h('strong', {}, summary.cacheCount), h('span', {}, `可重下缓存 · ${sizeLabel(summary.cacheBytes)}`)))),
    h('section', { className: 'settings-card' }, h('h2', {}, '受保护的本机内容'),
      h('p', {}, '未上传图片、正在重试的图片和从此设备添加的原图都不会被“清缓存”删除。要保护全部文字与图片，请继续保留本机数据库并定期导出完整备份。')),
    h('section', { className: 'settings-card' }, h('h2', {}, '可重新下载的图片缓存'),
      h('p', {}, summary.cacheCount ? '这些图片来自当前账号云端，清理后离线时暂时不可见；联网再次打开日记会重新下载。' : '当前没有可安全清理的云端图片缓存。'), clear));
  return root;
}
