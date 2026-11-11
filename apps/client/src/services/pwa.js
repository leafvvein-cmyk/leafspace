export function createPwa({ native = false, prepareUpdate, cancelUpdate, notify }) {
  const enabled = !native && typeof __DIARY_PWA__ !== 'undefined' && __DIARY_PWA__;
  const buildId = typeof __DIARY_BUILD_ID__ === 'string' ? __DIARY_BUILD_ID__ : 'development';
  let registration, installEvent, installing = false, updating = false, ready = false, installed = matchMedia('(display-mode: standalone)').matches;
  let status = native ? '原生 App 通过安装包更新，不使用网页离线缓存。' : enabled ? '正在准备离线页面…' : '开发预览不启用离线缓存。请用正式构建检查安装功能。';
  const listeners = new Set();
  const view = () => ({ enabled, buildId, status, installed, installing, ready, updating, canInstall: Boolean(installEvent), canUpdate: Boolean(registration?.waiting) });
  const publish = () => listeners.forEach((listener) => listener(view()));
  const changed = (message) => { status = message; publish(); };
  window.addEventListener('beforeinstallprompt', (event) => { if (!enabled) return; event.preventDefault(); installEvent = event; publish(); });
  window.addEventListener('appinstalled', () => { installed = true; installEvent = null; changed('已安装为独立窗口。'); });
  if (enabled && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', ({ data, ports }) => {
      if (data?.type === 'DIARY_BUILD_QUERY') ports[0]?.postMessage({ buildId });
    });
  }
  function waiting() {
    if (!registration?.waiting) return;
    changed('有新版本。保存草稿后，可在这里更新。'); notify?.('有新版本，可到“关于与安装”保存后更新。');
  }
  return {
    view,
    subscribe(listener) { listeners.add(listener); listener(view()); return () => listeners.delete(listener); },
    async start() {
      if (!enabled) return;
      if (!isSecureContext || !('serviceWorker' in navigator)) { changed('此环境不支持离线安装，请使用 HTTPS 下的新版浏览器。'); return; }
      try {
        registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed') waiting();
            if (worker.state === 'redundant') changed('离线页面更新未完成，当前版本和本机日记保持不变。');
          });
        });
        waiting();
        navigator.serviceWorker.ready.then(() => {
          ready = true;
          if (!registration.waiting) changed('离线页面已就绪。本机学习空间可断网打开；已登录账号只有此前启用本机 PIN，才能离线解锁本机副本。');
          registration.active?.postMessage({ type: 'DIARY_CLEAN_BUILDS' });
        }).catch(() => {});
      } catch { changed('离线页面准备失败，可联网继续使用；本机日记没有被清空。'); }
    },
    async check() {
      if (!registration) { changed('当前尚未注册离线页面，请联网后重开页面。'); return; }
      try { await registration.update(); if (registration.waiting) waiting(); else changed('已检查更新；新资源如在下载，完成后会提示。'); }
      catch { changed('检查更新失败，请确认网络后重试。'); }
    },
    async install() {
      if (!enabled || installing || installed) return;
      if (!installEvent) { changed('浏览器未提供安装按钮。可在浏览器菜单查找“安装应用”；iPhone Safari 使用“分享 → 添加到主屏幕”。'); return; }
      const event = installEvent; installEvent = null;
      installing = true; changed('请在浏览器提示中确认安装。');
      try { await event.prompt(); const choice = await event.userChoice; if (!installed) changed(choice.outcome === 'accepted' ? '已接受安装，请等待浏览器确认。' : '已取消安装，仍可使用网页版。'); }
      catch { if (!installed) changed('安装未完成，请使用浏览器菜单重试。'); }
      finally { installing = false; publish(); }
    },
    async update() {
      if (!registration?.waiting || updating) return;
      updating = true; changed('正在保存草稿…');
      try {
        await prepareUpdate();
        const worker = registration.waiting;
        if (!worker) throw new Error('新版本状态已改变，请重新检查更新。');
        updating = true; changed('草稿已保存，正在切换版本…');
        await new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          let acknowledged = false, controlled = false;
          const cleanup = () => {
            clearTimeout(timer); channel.port1.close(); channel.port2.close();
            navigator.serviceWorker.removeEventListener('controllerchange', onController);
          };
          const finish = () => {
            if (!acknowledged || !controlled) return;
            cleanup(); resolve();
          };
          const onController = () => {
            // An unrelated worker taking control is not confirmation of this update.
            controlled = navigator.serviceWorker.controller === worker;
            finish();
          };
          const timer = setTimeout(() => {
            cleanup(); reject(new Error('更新切换超时，已恢复当前页面操作，请重新检查更新。'));
          }, 10000);
          navigator.serviceWorker.addEventListener('controllerchange', onController);
          channel.port1.onmessage = ({ data }) => {
            if (!data?.ok) { cleanup(); reject(new Error(data?.message || '未能更新')); return; }
            acknowledged = true;
            controlled = navigator.serviceWorker.controller === worker;
            finish();
          };
          try { worker.postMessage({ type: 'DIARY_ACTIVATE_UPDATE' }, [channel.port2]); }
          catch (error) { cleanup(); reject(error); }
        });
        location.reload(); // Only after this tab saved and the requested worker took control.
      } catch (error) { updating = false; cancelUpdate(); changed(error.message); }
    },
  };
}
