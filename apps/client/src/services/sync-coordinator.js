import { createSyncPuller } from './sync-puller.js';
import { createSyncUploader } from './sync-uploader.js';
import { createAssetUploader } from './asset-uploader.js';

export function createSyncCoordinator({ mirror, queue, assets, request, upload, isCurrent }) {
  const puller = createSyncPuller({ mirror, request, isCurrent });
  const uploader = createSyncUploader({ queue, request, isCurrent });
  const assetUploader = assets && upload ? createAssetUploader({ assets, request, upload, isCurrent }) : null;
  let phase = 'download', running, caughtUp = false, recoveryRequested = false;
  const check = () => { if (!isCurrent()) throw Object.assign(new Error('账号已切换，同步已停止'), { code: 'SYNC_CONTEXT_CHANGED' }); };
  async function advance() {
    if (recoveryRequested) {
      check(); await puller.recoverFailed(); check();
      recoveryRequested = false; phase = 'download'; caughtUp = false;
    }
    check(); const before = await mirror.state(); check();
    if (!before.active || before.request || before.staging) phase = 'download';
    let result;
    if (phase === 'download') {
      result = await puller.step(); check();
      caughtUp = result.status === 'idle';
      const after = await mirror.state(); check();
      if (after.active && !after.request && !after.staging) phase = assetUploader ? 'assets' : 'upload';
      // Alternate bounded steps so incoming changes and local edits both advance.
      if (phase === 'upload') result = { ...result, retryAfterMs: 100 };
    } else if (phase === 'assets') {
      result = await assetUploader.step(); check(); phase = result.status === 'no-asset-work' ? 'upload' : 'download';
      result = { ...result, status: result.status === 'no-asset-work' ? 'upload-pending' : 'asset-processed', retryAfterMs: 100 };
    } else {
      result = await uploader.step(); check();
      phase = 'download';
      result = { ...result, status: result.status === 'no-upload-work' ? (caughtUp ? 'sync-idle' : 'downloading') : 'upload-processed',
        retryAfterMs: result.status === 'no-upload-work' && caughtUp ? 30000 : 100 };
    }
    const state = await mirror.state(); check();
    let summary = await queue.summary({ generation: state.active?.snapshotPosition?.generation }); check();
    if (assets?.assetUploadSummary) summary = { ...summary, assets: await assets.assetUploadSummary() }; check();
    if (result.status === 'sync-idle' && (summary.pending || summary.waiting)) result = { ...result, status: 'upload-pending', retryAfterMs: 100 };
    if (result.status === 'sync-idle' && (summary.blocked || summary.localTrash || summary.unverified)) result.status = 'attention';
    return { ...result, summary };
  }
  return { requestRecovery: () => { recoveryRequested = true; },
    activity: () => phase === 'download' ? 'downloading' : 'uploading',
    step: () => running ??= advance().finally(() => { running = undefined; }) };
}

export function syncLabel(status) {
  return ({ stopped: '同步已停止', offline: '当前离线，联网后继续同步', paused: '应用在后台，回到前台后继续同步',
    downloading: '正在检查云端更新…', uploading: '正在上传已保存的修改…', waiting: '正在准备云端副本…',
    expired: '云端副本已过期，正在重新准备', rebuilding: '正在重新下载云端副本…',
    'snapshot-ready': '云端副本已下载，继续检查本机修改', idle: '云端这一轮检查完成，继续核对本机修改',
    'upload-processed': '本次上传已处理，正在核对剩余修改', 'upload-pending': '有修改等待上传…',
    'asset-processed': '图片已安全上传，正在同步正文…',
    'sync-idle': '本轮已保存的修改已确认，云端检查完成', attention: '有本机内容需要留意，详见下方状态',
    'another-window': '另一窗口正在同步，稍后继续', retrying: '同步暂未成功，将自动重试',
    failed: '同步未完成，请重试并保留本机备份', unsupported: '当前浏览器不支持安全的跨窗口同步，请使用新版浏览器',
  })[status] ?? '等待同步';
}

export function syncSummaryLabel(summary) {
  if (!summary) return '尚未检查上传队列。';
  const assets = summary.assets ? `，图片待上传 ${summary.assets.waiting} 张，图片失败 ${summary.assets.failed} 张` : '';
  return `上次检查：待上传 ${summary.pending + summary.waiting} 篇，待处理 ${summary.blocked} 篇，仅在本机回收站 ${summary.localTrash} 篇，确认信息待核对 ${summary.unverified} 篇${assets}。`;
}
