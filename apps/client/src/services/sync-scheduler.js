// One bounded pull step per lock acquisition; downloading never acknowledges uploads.
export function createSyncScheduler({ puller, namespace, isCurrent, onState = () => {}, activity = () => 'downloading',
  native = false, locks = globalThis.navigator?.locks,
  online = () => globalThis.navigator?.onLine !== false,
  visible = () => globalThis.document?.visibilityState !== 'hidden',
  events = globalThis.window, visibilityEvents = globalThis.document,
  random = Math.random }) {
  let stopped = true, disposed = false, running = false, wakePending = false, timer, failures = 0;
  let state = { status: 'stopped' };
  const emit = (value) => { state = { ...state, ...value, changed: Boolean(value.changed) }; onState({ ...state }); };
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const schedule = (delay) => {
    clear();
    if (!stopped) timer = setTimeout(() => { void run(); }, delay);
  };
  function eligible() {
    if (!isCurrent()) { stop(); return false; }
    if (!online()) { emit({ status: 'offline' }); return false; }
    if (!visible()) { emit({ status: 'paused' }); return false; }
    return true;
  }
  async function run() {
    if (stopped || running) return;
    clear();
    if (!eligible()) return;
    wakePending = false;
    running = true;
    let delay;
    try {
      const work = async () => {
        if (stopped || !eligible()) return null;
        emit({ status: activity() });
        return puller.step();
      };
      // Native has one JS coordinator per app. Browsers without Web Locks must
      // not silently race another tab over the same snapshot staging area.
      if (!native && !locks?.request) { emit({ status: 'unsupported' }); return; }
      const result = native ? await work() : await locks.request(`diary-v2:sync:${namespace}`,
        { mode: 'exclusive', ifAvailable: true }, (lock) => lock ? work() : { status: 'another-window', retryAfterMs: 3000 });
      if (stopped || !eligible() || !result) return;
      failures = 0; emit({ status: result.status, errorCode: null, changed: Boolean(result.changed), ...(result.summary ? { summary: result.summary } : {}) });
      delay = Math.max(100, Math.min(300000, result.retryAfterMs ?? 30000));
    } catch (error) {
      if (stopped || !eligible()) return;
      if (['SYNC_CONTEXT_CHANGED', 'AUTH_CONTEXT_CHANGED'].includes(error.code)) { stop(); return; }
      failures += 1;
      delay = Math.min(300000, 2000 * 2 ** Math.min(failures - 1, 8)) * (0.8 + random() * 0.2);
      const terminal = error.code === 'SNAPSHOT_FAILED' || (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
      emit({ status: terminal ? 'failed' : 'retrying', errorCode: error.code ?? null });
      if (terminal) delay = undefined;
    } finally {
      running = false;
      if (!stopped && wakePending) { wakePending = false; schedule(0); }
      else if (!stopped && delay !== undefined) schedule(delay);
    }
  }
  function wake() {
    if (stopped) return;
    clear();
    if (!eligible()) return;
    if (running) { wakePending = true; return; }
    schedule(0);
  }
  function stop() { stopped = true; wakePending = false; clear(); emit({ status: 'stopped' }); }
  events?.addEventListener('online', wake);
  events?.addEventListener('offline', wake);
  visibilityEvents?.addEventListener('visibilitychange', wake);
  return {
    view: () => ({ ...state }),
    start() { if (disposed || !stopped) return; stopped = false; wake(); },
    retry: wake,
    recover() { if (stopped || disposed) return; puller.requestRecovery?.(); wake(); },
    destroy() {
      disposed = true; stop();
      events?.removeEventListener('online', wake);
      events?.removeEventListener('offline', wake);
      visibilityEvents?.removeEventListener('visibilitychange', wake);
    },
  };
}

export function syncDownloadLabel(status) {
  return ({ stopped: '下载已停止', offline: '当前离线，联网后继续下载', paused: '应用在后台，回到前台后继续下载',
    downloading: '正在下载云端副本…', waiting: '正在准备云端副本…', expired: '副本已过期，正在重新准备',
    rebuilding: '正在重建云端副本…', 'snapshot-ready': '云端副本已下载，正在检查后续更新',
    idle: '云端副本已更新（仅下载）', 'another-window': '另一窗口正在下载，稍后继续',
    retrying: '下载暂未成功，将自动重试', failed: '下载未完成，请重试；若持续失败请保留本机备份',
    unsupported: '当前浏览器不支持安全的跨窗口下载，请使用新版浏览器',
  })[status] ?? '等待下载';
}
