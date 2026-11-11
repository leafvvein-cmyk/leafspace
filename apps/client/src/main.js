import './styles.css';
import { localDate } from '@diary/contracts';
import { openDiaryStore, isNative, platform, bindNativeLifecycle } from './services/platform.js';
import { apiBase, ApiError, createAuthClient, validateCredentials } from './services/auth-client.js';
import { nativeSessionStore, nativeLockSecretStore } from './services/secure-session-store.js';
import { internalPath } from './services/navigation.js';
import { createWorkspace } from './ui/workspace.js';
import { createAuthPage, createRecoveryPage, askPassword } from './ui/auth-pages.js';
import { accountPage, devicesPage, deleteAccountPage, deletionReceiptPage } from './ui/account-pages.js';
import { h, button, toast, downloadFile } from './ui/dom.js';
import { createPwa } from './services/pwa.js';
import { aboutPage } from './ui/about-page.js';
import { createSyncCoordinator, syncLabel, syncSummaryLabel } from './services/sync-coordinator.js';
import { createSyncScheduler } from './services/sync-scheduler.js';

const app = document.querySelector('#app');
document.querySelector('.skip-link')?.addEventListener('click', (event) => {
  const main = document.querySelector('#main');
  if (!main) return;
  event.preventDefault();
  main.focus({ preventScroll: true });
  main.scrollIntoView({ block: 'start', behavior: 'instant' });
});
const repositories = new Map();
let auth, metadata, current, workspace, recovery = null, blocked = false, operationBusy = false;
let routeVersion = 0, queue = Promise.resolve();
let activeUrl = `${location.pathname}${location.search}`;
let auxiliaryPage;
let syncScheduler;
let reminders;
let deviceLock, biometric, lockOverlay;
let nativeActive = true;
function startSync() {
  syncScheduler?.destroy(); syncScheduler = null;
  const owner = current;
  if (!owner?.user || owner.user.offline) return;
  const isCurrent = () => current === owner && !blocked && auth.view().status === 'online'
    && auth.view().epoch === owner.epoch && auth.view().user?.id === owner.user.id;
  const coordinator = createSyncCoordinator({ mirror: owner.repository.syncMirror, queue: owner.repository.uploadQueue, assets: owner.repository,
    request: (...args) => auth.request(...args), upload: (...args) => auth.upload(...args), isCurrent });
  syncScheduler = createSyncScheduler({ puller: coordinator, activity: coordinator.activity, namespace: owner.namespace, isCurrent, native: isNative,
    visible: () => nativeActive && document.visibilityState !== 'hidden',
    onState: ({ status, summary, errorCode, changed }) => {
      if (current !== owner) return;
      for (const node of app.querySelectorAll('[data-download-status]')) node.textContent = syncLabel(status);
      for (const node of app.querySelectorAll('[data-sync-summary]')) node.textContent = syncSummaryLabel(summary);
      for (const node of app.querySelectorAll('[data-retry-snapshot]')) node.hidden = errorCode !== 'SNAPSHOT_FAILED';
      if (changed) workspace?.refreshFromSync();
    } });
  syncScheduler.start();
}
const pwa = createPwa({ native: isNative, notify: toast,
  prepareUpdate: () => serialize(async () => {
    if (operationBusy || blocked || recovery) throw new Error('请先完成当前操作并保存恢复码，再更新页面。');
    await saveBeforeLeave(); operationBusy = true; app.inert = true;
  }),
  cancelUpdate: () => { operationBusy = false; app.inert = blocked; workspace?.resume(); },
});
const stack = [activeUrl];
const errorNotice = (error) => toast(error.message || '操作未完成，请重试。');
const serialize = (task) => { const result = queue.catch(() => {}).then(task); queue = result; return result; };
function newReceiptToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const openRepository = (namespace) => {
  if (!repositories.has(namespace)) repositories.set(namespace, openDiaryStore(namespace).catch((error) => { repositories.delete(namespace); throw error; }));
  return repositories.get(namespace);
};
async function publicApiMeta() {
  const base = apiBase({ native: isNative, configured: import.meta.env.VITE_API_BASE_URL, origin: location.origin });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/meta`, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok || typeof body?.data?.apiVersion !== 'string' || typeof body.data.buildId !== 'string'
      || !Array.isArray(body.data.supportedContentSchemas)) throw new Error('API 版本响应无效');
    return body.data;
  } finally { clearTimeout(timer); }
}
function closeDialogs() { document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close()); }
function replaceUrl(url) {
  history.replaceState({}, '', internalPath(url, location.href));
  activeUrl = `${location.pathname}${location.search}`; stack[stack.length - 1] = activeUrl;
}
async function saveBeforeLeave() {
  try { await workspace?.prepareLeave(); }
  catch (error) { workspace?.resume(); throw error; }
}
function destroyWorkspace() { workspace?.destroy(); workspace = null; }
function clearBlocker() {
  blocked = false; document.querySelector('#session-blocker')?.remove();
  app.inert = Boolean(deviceLock?.view().locked);
  if (app.inert) app.setAttribute('aria-hidden', 'true'); else app.removeAttribute('aria-hidden');
}
function lockStateChanged(state) {
  if (!state.locked) {
    lockOverlay?.remove(); lockOverlay = null;
    app.inert = blocked;
    if (blocked) app.setAttribute('aria-hidden', 'true'); else app.removeAttribute('aria-hidden');
    workspace?.resume(); return;
  }
  // verify() emits the failed state before rejecting. Preserve the visible
  // overlay so its submit handler can show the PIN error on a connected node.
  if (state.reason === 'failed' && lockOverlay?.isConnected) return;
  closeDialogs(); app.inert = true; app.setAttribute('aria-hidden', 'true'); workspace?.pause?.(); workspace?.flush().catch(errorNotice);
  lockOverlay?.remove();
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
  const input = h('input', { type: 'password', inputmode: 'numeric', pattern: '\\d{6}', maxlength: 6, autocomplete: 'current-password', 'aria-label': '6 位本机 PIN' });
  const submit = h('button', { type: 'submit', className: 'button primary' }, '解锁日记');
  const form = h('form', { className: 'auth-form' }, h('label', { className: 'form-field' }, h('span', {}, '6 位本机 PIN'), input), alert, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try { await deviceLock.verify(input.value); input.value = ''; }
    catch (error) { input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; input.focus(); }
  });
  const accountUnlock = auth?.view().status === 'online' && button('使用账号密码联网解锁', async () => {
    if (operationBusy) return; operationBusy = true; accountUnlock.disabled = true;
    try {
      const password = await askPassword('联网验证当前账号密码后，只解锁这台设备的界面。');
      if (password === null) return;
      await auth.request('/auth/reauth', { method: 'POST', body: { password, scope: 'unlock_device' } });
      deviceLock.unlockTrusted('account');
    } catch (error) { alert.textContent = error.message; alert.hidden = false; }
    finally { operationBusy = false; accountUnlock.disabled = false; }
  }, { className: 'text-button' });
  const systemUnlock = state.settings.systemUnlock && biometric && button('使用生物识别或设备凭据', async () => {
    if (operationBusy) return; operationBusy = true; systemUnlock.disabled = true; alert.hidden = true;
    try { if (await biometric.authenticate()) deviceLock.unlockTrusted('system'); }
    catch (error) { alert.textContent = error.message; alert.hidden = false; }
    finally { operationBusy = false; if (systemUnlock.isConnected) systemUnlock.disabled = false; }
  }, { className: 'button' });
  lockOverlay = h('section', { id: 'device-lock-screen', className: 'device-lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': '日记已锁定' },
    h('div', { className: 'settings-card lock-card' }, h('p', { className: 'eyebrow' }, '日记'), h('h1', {}, '内容已锁定'),
      h('p', {}, state.reason === 'background' ? '应用进入后台时已立即遮挡正文。' : state.reason === 'idle' ? '长时间没有操作，已自动锁定。' : '请输入本机 PIN 继续。'),
      auth?.view().offlineEligible && h('p', { className: 'notice' }, '云端账号暂时无法确认。正确解锁后只打开这个账号保存在本机的副本，不会上传或下载。'),
      form, systemUnlock, accountUnlock, h('p', { className: 'muted' }, '系统验证不可用时，仍需使用本机 PIN；离线状态不能绕过日记锁。')));
  document.body.append(lockOverlay); input.focus();
}
function sessionInvalidated({ reason }) {
  const path = location.pathname;
  if (['/login', '/register', '/recover'].includes(path)) return;
  if ((!current?.user && !['/settings/account', '/settings/devices', '/onboarding/recovery'].includes(path)) || (operationBusy && ['login-transition', 'local-signout'].includes(reason))) return;
  recovery = null; blocked = true; closeDialogs(); app.inert = true; app.setAttribute('aria-hidden', 'true');
  syncScheduler?.destroy(); syncScheduler = null;
  if (document.querySelector('#session-blocker')) return;
  const status = h('p', { role: 'status', className: 'muted' }, '原账号的本机内容仍保留，不会转到其他账号。');
  const acknowledged = h('input', { type: 'checkbox', id: 'rescue-acknowledged' });
  const leaveAfterExport = button('备份已确认，继续登录', () => serialize(async () => {
    if (!acknowledged.checked) return;
    // Explicitly confirmed recovery is the only path that may release an
    // editor whose last write failed. Persisted diary databases are untouched.
    destroyWorkspace(); clearBlocker(); await go('/login', { replace: true });
  }), { className: 'button', disabled: true });
  acknowledged.addEventListener('change', () => { leaveAfterExport.disabled = !acknowledged.checked; });
  const rescueConfirmation = h('div', { hidden: true },
    h('p', {}, '请先确认备份文件可以打开且包含当前草稿。继续后会关闭未保存的编辑页面，本机已保存记录不会删除。'),
    h('label', { className: 'checkbox-row', for: 'rescue-acknowledged' }, acknowledged, '我已确认救援备份包含当前草稿'), leaveAfterExport);
  const overlay = h('section', { id: 'session-blocker', className: 'session-blocker', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': '请重新确认登录' },
    h('div', { className: 'settings-card recovery-card' }, h('h1', {}, '请重新确认登录'),
      h('p', {}, '登录状态未能确认，或账号在另一个窗口发生变化。'), status,
      h('div', { className: 'account-actions' },
        button('保存本机草稿并去登录', () => serialize(async () => {
          try { await saveBeforeLeave(); destroyWorkspace(); clearBlocker(); await go('/login', { replace: true }); }
          catch (error) { status.textContent = `草稿暂未保存：${error.message}。可先导出救援备份，原内容仍留在当前窗口。`; }
        }), { className: 'button primary' }),
        button('导出救援备份', async () => {
          try { await exportCurrent({ rescue: true }); rescueConfirmation.hidden = false; }
          catch (error) { status.textContent = `导出未完成：${error.message}。请保留当前窗口。`; }
        }, { glyph: 'download' })), rescueConfirmation));
  document.body.append(overlay);
  overlay.querySelector('button')?.focus();
  workspace?.prepareLeave().catch(() => { status.textContent = '有草稿未能保存。请保留当前窗口，并先导出救援备份。'; });
}
async function exportCurrent({ rescue = false, accountUser } = {}) {
  const owner = current, editor = workspace;
  if (!owner) return;
  if (!rescue) await editor?.flush();
  const repository = accountUser ? await openRepository(`user:${accountUser.id}`) : owner.repository;
  const content = await repository.exportLocal();
  if (owner !== current) throw new Error('日记空间已改变，请重新选择要导出的内容。');
  if (rescue) content.unsavedEditor = editor?.snapshot() ?? null;
  await downloadFile(`日记${rescue ? '救援' : '本机'}备份-${localDate()}.json`, JSON.stringify(content, null, 2));
  toast('已发起导出。文件为明文，请确认保存并妥善保管。');
}
async function exportLearningSpace() {
  const repository = await openRepository('learning');
  const content = await repository.exportLocal();
  await downloadFile(`日记学习空间备份-${localDate()}.json`, JSON.stringify(content, null, 2));
  toast('已发起学习空间明文备份，请确认文件保存结果。');
}
async function selectSpace(user = null, epoch = crypto.randomUUID(), { persistPreference = true } = {}) {
  await saveBeforeLeave();
  const namespace = user ? `user:${user.id}` : 'learning';
  const repository = await openRepository(namespace);
  // Do not destroy the old editor until the new database has opened.
  closeDialogs(); destroyWorkspace(); recovery = null;
  current = Object.freeze({ user, epoch, namespace, repository });
  document.querySelector('#toast')?.remove(); clearBlocker();
  startSync();
  if (persistPreference) await metadata.setSetting('preferred-space', user ? 'account' : 'learning');
  stack.splice(0, stack.length, '/today');
}
async function go(url, { replace = false, pop = false, back = false } = {}) {
  await saveBeforeLeave(); closeDialogs();
  const target = internalPath(url, location.href);
  if (recovery && target !== '/onboarding/recovery') recovery = null;
  history[replace ? 'replaceState' : 'pushState']({}, '', target);
  activeUrl = `${location.pathname}${location.search}`;
  if (back && stack.length > 1) stack.pop();
  else if (pop) { const index = stack.lastIndexOf(activeUrl); if (index >= 0) stack.splice(index + 1); else stack.push(activeUrl); }
  else if (!replace) stack.push(activeUrl);
  stack[stack.length - 1] = activeUrl;
  await renderRoute(); return true;
}
function navigate(url, options = {}) {
  const owner = current;
  return serialize(async () => {
    if (owner !== current || blocked) return false;
    try { return await go(url, options); }
    catch (error) { if (options.pop) history.pushState({}, '', activeUrl); workspace?.resume(); errorNotice(error); return false; }
  });
}
function ownedAction(action) {
  const owner = current, epoch = auth.view().epoch, version = routeVersion;
  const check = () => {
    if (owner !== current || epoch !== auth.view().epoch || version !== routeVersion || blocked) throw new ApiError('AUTH_CONTEXT_CHANGED', '账号或页面已改变，请重新操作。');
  };
  return (...args) => serialize(async () => {
    check(); operationBusy = true;
    try { return await action(check, ...args); }
    finally { operationBusy = false; }
  });
}
async function reauthenticate(check, scope, target) {
  const password = await askPassword('这项操作涉及账号安全，请输入当前密码。');
  check(); if (password === null) return null;
  const targetFields = Array.isArray(target) ? { targetIds: target } : target ? { targetId: target } : {};
  const result = await auth.request('/auth/reauth', { method: 'POST', body: { password, scope, ...targetFields } });
  check(); return result.reauthToken;
}
async function generateRecovery(check, { first = false } = {}) {
  const reauthToken = first ? undefined : await reauthenticate(check, 'rotate_recovery_code');
  if (!first && !reauthToken) return;
  let result;
  try { result = await auth.request('/security/recovery-code', { method: 'POST', body: { requestId: crypto.randomUUID(), ...(reauthToken ? { reauthToken } : {}) } }); }
  catch (error) {
    if (['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500) error.message = '恢复码生成结果未能确认，旧码可能已失效。请保留密码，重新验证后生成新码；不会自动重复生成。';
    throw error;
  }
  check(); recovery = { userId: auth.view().user.id, code: result.recoveryCode };
  await go('/onboarding/recovery', { replace: true });
}
function accountPanel() {
  const authState = auth.view();
  const offline = Boolean(current?.user?.offline && authState.offlineEligible);
  const user = authState.status === 'online' ? authState.user : offline ? current.user : null;
  return h('section', { className: 'settings-card account-notice' }, h('h2', {}, user ? user.displayName || user.username : '账号与安全'),
    h('p', { className: 'muted' }, offline ? '已用本机 PIN 离线打开账号副本。当前不会同步；联网后请重新登录确认账号状态。' : user ? (current.user ? '已通过账号密码登录。修改先保存在此设备，联网后自动尝试同步。' : '当前查看独立的本机学习空间，不属于已登录账号。') : '用账号密码登录。原有本机内容保持独立，不会自动迁移。'),
    current.user && !offline && h('div', {}, h('p', { role: 'status', 'data-download-status': true }, syncLabel(syncScheduler?.view().status)),
      h('p', { className: 'muted', 'data-sync-summary': true }, syncSummaryLabel(syncScheduler?.view().summary)),
      h('p', { className: 'muted' }, '云端副本与本机稿分开保存。重新进入列表查看新下载内容；尚未上传的本机稿会保留，冲突不会自动覆盖。'),
      button('立即同步', () => syncScheduler?.retry(), { glyph: 'download' }),
      button('查看同步问题', () => navigate('/sync')),
      button('重新准备失败的云端副本', () => syncScheduler?.recover(), { 'data-retry-snapshot': true,
        hidden: syncScheduler?.view().errorCode !== 'SNAPSHOT_FAILED', title: '保留本机日记与待上传修改，仅重试已确认失败的云端准备任务' })),
    h('div', { className: 'account-actions' },
      button(offline ? '联网重新登录' : user ? '账号与安全' : '账号密码登录', () => navigate(offline ? '/login' : user ? '/settings/account' : '/login'), { className: 'button primary' }),
      user && !current.user && button('回到账号日记', ownedAction(async (check) => { check(); await selectSpace(auth.view().user, auth.view().epoch); await go('/today', { replace: true }); })),
      !user && button('创建账号', () => navigate('/register'))));
}
async function logout(check) {
  const answer = await new Promise((resolve) => {
    let selected = false;
    const dialog = h('dialog', { className: 'confirmation' }, h('h2', {}, '退出这个账号？'),
      h('p', {}, '可能仍有未上传或待处理的修改，退出不会删除本机内容。可以先导出备份，再退出；下次登录同一账号可继续同步。'),
      h('div', { className: 'account-actions' }, button('取消', () => dialog.close()),
        button('导出后退出', () => { selected = 'export'; dialog.close(); }),
        button('保留本机副本并退出', () => { selected = 'keep'; dialog.close(); }, { className: 'button danger' })));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(selected); }); document.body.append(dialog); dialog.showModal();
  });
  check(); if (!answer) return;
  if (answer === 'export') { await exportCurrent({ accountUser: auth.view().user }); check(); }
  await auth.logout(); await selectSpace(); await go('/login', { replace: true });
  toast('已退出登录。本机日记副本仍保留。');
}
async function renderRoute() {
  auxiliaryPage?.destroy(); auxiliaryPage = null;
  const version = ++routeVersion, path = location.pathname === '/' ? '/today' : location.pathname;
  const deletionRoute = path.match(/^\/account-deletions\/([0-9a-f-]{36})$/i);
  if (deletionRoute) {
    destroyWorkspace(); document.body.classList.remove('editing-page', 'focus-mode');
    document.title = '注销回执 · 日记';
    const saved = await metadata.getSetting('pending-account-deletion', null);
    if (!saved || saved.deletionId !== deletionRoute[1]) {
      app.replaceChildren(h('main', { className: 'account-page' }, h('section', { className: 'settings-card receipt-card' }, h('h1', {}, '无法读取这张回执'), h('p', {}, '回执凭据只保存在发起注销的设备上，不会通过网址传递。'), button('返回登录页', () => navigate('/login'))))); return;
    }
    app.replaceChildren(h('main', { className: 'account-page' }, h('p', { role: 'status' }, '正在读取注销状态…')));
    try {
      const receipt = await auth.deletionStatus(saved.deletionId, saved.receiptToken);
      if (version !== routeVersion) return;
      app.replaceChildren(deletionReceiptPage({ receipt, refresh: () => navigate(path, { replace: true }), navigate }));
    } catch (error) {
      if (version !== routeVersion) return;
      app.replaceChildren(h('main', { className: 'account-page' }, h('section', { className: 'settings-card receipt-card' }, h('h1', {}, '暂时无法确认清理状态'), h('p', { role: 'alert' }, error.message), h('p', {}, '如果刚才网络中断，注销请求可能尚未到达，也可能已经生效。保留此设备数据并稍后刷新；不要反复创建不同请求。'), h('div', { className: 'account-actions' }, button('刷新回执', () => navigate(path, { replace: true })), button('返回登录页', () => navigate('/login'))))));
    }
    return;
  }
  if (path === '/settings/about') {
    destroyWorkspace(); document.body.classList.remove('editing-page', 'focus-mode');
    document.title = '关于与安装 · 日记';
    auxiliaryPage = aboutPage({ pwa, navigate, native: isNative, loadMeta: publicApiMeta,
      localSchema: { database: 3, backup: 3, content: 1 } });
    app.replaceChildren(auxiliaryPage.root); return;
  }
  const authPath = ['/login', '/register', '/recover', '/onboarding/recovery', '/settings/account', '/settings/devices', '/settings/delete-account'].includes(path);
  if (!authPath) {
    const authState = auth.view();
    const onlineOwner = current?.user && authState.status === 'online' && current.epoch === authState.epoch && current.user.id === authState.user?.id;
    const offlineOwner = current?.user?.offline && authState.offlineEligible && current.epoch === authState.epoch && current.user.id === authState.user?.id;
    if (current?.user && !onlineOwner && !offlineOwner) { sessionInvalidated({ reason: 'route-check' }); return; }
    if (!workspace) {
      const owner = current;
      workspace = createWorkspace({ repository: owner.repository, user: owner.user,
        requestCloud: owner.user?.offline ? null : async (path, options) => {
          const valid = () => current === owner && !blocked && auth.view().status === 'online'
            && auth.view().epoch === owner.epoch && auth.view().user?.id === owner.user?.id;
          if (!valid()) throw new Error('登录状态已变化，请重新打开页面');
          const result = await auth.request(path, options);
          if (!valid()) throw new Error('登录状态已变化，请重新打开页面');
          return result;
        },
        exportDownloadUrl: owner.user?.offline ? null : (path, id) => {
          if (!path.startsWith(`/api/v1/exports/${id}/file?ticket=`)) throw new Error('下载链接格式无效');
          const base = apiBase({ native: isNative, configured: import.meta.env.VITE_API_BASE_URL, origin: location.origin });
          const url = new URL(path, base);
          if (url.origin !== new URL(base).origin) throw new Error('下载链接来源无效');
          return url.href;
        },
        downloadCloudAsset: owner.user?.offline ? null : async (path) => {
          if (!/^\/api\/v1\/assets\/[0-9a-f-]{36}\/file\?ticket=[A-Za-z0-9%._-]+$/i.test(path)) throw new Error('图片下载链接格式无效');
          return auth.download(path.replace(/^\/api\/v1/, ''));
        },
        canResolveConflict: () => current === owner && !blocked && auth.view().status === 'online'
          && auth.view().epoch === owner.epoch && auth.view().user?.id === owner.user?.id,
        readRemoteEntry: owner.user?.offline ? null : async (id) => {
          const valid = () => current === owner && !blocked && auth.view().status === 'online'
            && auth.view().epoch === owner.epoch && auth.view().user?.id === owner.user?.id;
          if (!valid()) throw new Error('登录状态已变化，请重新打开页面');
          const entry = await auth.request(`/entries/${encodeURIComponent(id)}`);
          if (!valid()) throw new Error('登录状态已变化，请重新打开页面');
          return entry;
        },
        reminders, deviceLock, biometric,
        learningMigration: auth.view().status === 'online' ? {
          targetLabel: auth.view().user.username,
          preview: async () => {
            const { previewLearningBackup } = await import('./services/learning-migration.js');
            return previewLearningBackup(await (await openRepository('learning')).exportLocal());
          },
          exportSource: exportLearningSpace,
          copy: (onProgress) => serialize(async () => {
            const account = auth.view();
            if (current !== owner || blocked || account.status !== 'online') throw new Error('账号或页面已改变，请重新操作。');
            const { copyLearningSpace } = await import('./services/learning-migration.js');
            const result = await copyLearningSpace({ source: await openRepository('learning'), target: await openRepository(`user:${account.user.id}`), onProgress });
            if (current !== owner || auth.view().epoch !== account.epoch || auth.view().user?.id !== account.user.id) throw new Error('复制完成后账号状态已改变，请重新登录原账号查看。');
            if (owner.user?.id === account.user.id) syncScheduler?.retry();
            return result;
          }),
          openAccount: (path = '/today') => serialize(async () => {
            const account = auth.view();
            if (account.status !== 'online') throw new Error('请重新登录账号。');
            await selectSpace(account.user, account.epoch); await go(path, { replace: true });
          }),
        } : null,
        purgeCloudEntries: owner.user?.offline ? null : (entries) => serialize(async () => {
          const check = () => {
            if (current !== owner || blocked || auth.view().status !== 'online' || auth.view().epoch !== owner.epoch || auth.view().user?.id !== owner.user?.id) throw new ApiError('AUTH_CONTEXT_CHANGED', '账号或页面已改变，请重新操作。');
          };
          check(); operationBusy = true;
          try {
          const ordered = [...entries].sort((a, b) => a.id.localeCompare(b.id));
          const userId = auth.view().user.id, key = JSON.stringify(ordered);
          const settingName = `pending-entry-purge:${userId}`;
          const previous = await metadata.getSetting(settingName, null);
          check();
          if (previous && previous.key !== key) throw new Error(`前一批 ${previous.count ?? '若干'} 篇日记的永久删除结果尚未确认，请先重新选择原来的记录重试。`);
          const requestId = previous?.userId === userId && previous.key === key ? previous.requestId : crypto.randomUUID();
          if (requestId !== previous?.requestId) await metadata.setSetting(settingName, { userId, key, requestId, count: ordered.length });
          check();
          const scope = ordered.length === 1 ? 'purge_entry' : 'purge_entries';
          const reauthToken = await reauthenticate(check, scope, ordered.length === 1 ? ordered[0].id : ordered.map((entry) => entry.id));
          if (!reauthToken) return null;
          try {
            const result = ordered.length === 1
              ? await auth.request(`/entries/${ordered[0].id}/purge`, { method: 'POST', body: { requestId, baseRevision: ordered[0].baseRevision, reauthToken } })
              : await auth.request('/entries/purge-batch', { method: 'POST', body: { requestId, entries: ordered, reauthToken } });
            check(); await metadata.setSetting(settingName, null); return result;
          } catch (error) {
            if (['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500) error.message = '永久删除结果尚未确认。请恢复网络后重试同一批记录；系统会复用原请求编号，不会另建删除操作。';
            else await metadata.setSetting(settingName, null);
            throw error;
          }
          } finally { operationBusy = false; }
        }),
        onNavigate: (url, options) => owner === current ? navigate(url, options) : false,
        onReplace: (url) => { if (owner === current) replaceUrl(url); },
        onLocalChange: () => { if (owner === current) syncScheduler?.retry(); }, accountPanel });
    }
    app.replaceChildren(workspace.root); await workspace.applyAppearance(); await workspace.render(); return;
  }
  destroyWorkspace(); document.body.classList.remove('editing-page', 'focus-mode');
  if (['/login', '/register', '/recover'].includes(path)) {
    document.title = `${path === '/register' ? '注册' : path === '/recover' ? '找回密码' : '登录'} · 日记`;
    app.replaceChildren(createAuthPage({ mode: path.slice(1), navigate,
      continueLocal: () => serialize(async () => { await selectSpace(); await go('/today', { replace: true }); }),
      submit: (values) => serialize(async () => {
        if (version !== routeVersion) return;
        operationBusy = true;
        try {
          if (path === '/recover') {
            const initiating = auth.view();
            try { await auth.resetPassword(values); }
            catch (error) { if (error.fields?.newPassword) error.fields.password = error.fields.newPassword; throw error; }
            if (initiating.user?.username === values.username.trim().toLowerCase()) await auth.forgetRevokedSession({ expectedEpoch: initiating.epoch, expectedUserId: initiating.user.id });
            await selectSpace(null, crypto.randomUUID(), { persistPreference: false }); await go('/login', { replace: true }); toast('密码已重置，请使用新密码登录。'); return;
          }
          const state = await auth.login(values, { register: path === '/register' });
          await selectSpace(state.user, state.epoch);
          if (path === '/register') {
            // Generation is explicit after registration, never a render effect.
            await go('/onboarding/recovery', { replace: true });
          } else await go('/today', { replace: true });
        } finally { operationBusy = false; }
      }) }));
    return;
  }
  if (auth.view().status !== 'online') { replaceUrl('/login'); await renderRoute(); return; }
  if (path === '/onboarding/recovery') {
    document.title = '恢复码 · 日记';
    app.replaceChildren(createRecoveryPage({ code: recovery?.userId === auth.view().user.id ? recovery.code : null, account: auth.view().user.username,
      generate: () => ownedAction((check) => generateRecovery(check))().catch(errorNotice),
      continueWriting: () => navigate('/today', { replace: true }), skip: () => navigate('/today', { replace: true }) }));
    return;
  }
  app.replaceChildren(h('main', { className: 'account-page' }, h('p', { role: 'status' }, '正在读取账号信息…')));
  try {
    if (path === '/settings/account') {
      const profile = await auth.request('/me');
      if (version !== routeVersion || blocked) return;
      app.replaceChildren(accountPage({ profile, navigate, onLogout: ownedAction(logout),
        onProfile: ownedAction(async (check, values) => { const updated = await auth.updateProfile({ ...values, baseRevision: profile.revision }); check(); current = Object.freeze({ ...current, user: current.user ? updated : null }); await renderRoute(); toast('账号资料已保存。'); }),
        onRecovery: ownedAction((check) => generateRecovery(check)),
        onPassword: ownedAction(async (check, values) => {
          validateCredentials({ username: profile.username, ...values }, { register: true });
          const reauthToken = await reauthenticate(check, 'change_password'); if (!reauthToken) return;
          try { await auth.request('/security/password', { method: 'POST', body: { newPassword: values.password, reauthToken, requestId: crypto.randomUUID() } }); }
          catch (error) {
            if (['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500) error.message = '修改密码的结果未能确认，新密码可能已生效。请保留新密码并尝试重新登录；不会自动重复修改。';
            throw error;
          }
          check(); await auth.forgetRevokedSession(); await selectSpace(); await go('/login', { replace: true }); toast('密码已修改，所有设备需要重新登录。');
        }),
        onLocal: ownedAction(async () => { await selectSpace(); await go('/today', { replace: true }); }),
        onDelete: () => navigate('/settings/delete-account') }));
    } else if (path === '/settings/delete-account') {
      const profile = await auth.request('/me');
      if (version !== routeVersion || blocked) return;
      app.replaceChildren(deleteAccountPage({ profile, navigate,
        onBackup: () => exportCurrent({ accountUser: auth.view().user }),
        onDelete: ownedAction(async (check) => {
          const reauthToken = await reauthenticate(check, 'delete_account'); if (!reauthToken) return;
          let pending = await metadata.getSetting('pending-account-deletion', null);
          if (!pending || pending.userId !== profile.id) pending = { userId: profile.id, deletionId: crypto.randomUUID(), requestId: crypto.randomUUID(), receiptToken: newReceiptToken(), createdAt: new Date().toISOString() };
          await metadata.setSetting('pending-account-deletion', pending); check();
          try {
            await auth.request('/account-deletions', { method: 'POST', body: { deletionId: pending.deletionId, requestId: pending.requestId, receiptToken: pending.receiptToken, reauthToken, confirmed: true } });
          } catch (error) {
            if (!['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code) && error.status < 500) throw error;
          }
          check(); await auth.forgetRevokedSession();
          await selectSpace(null, crypto.randomUUID(), { persistPreference: false });
          await go(`/account-deletions/${pending.deletionId}`, { replace: true });
        }) }));
    } else {
      const data = await auth.request('/sessions');
      if (version !== routeVersion || blocked) return;
      const userId = auth.view().user.id;
      app.replaceChildren(devicesPage({ items: data.items, navigate,
        onRevoke: ownedAction(async (check, id) => {
          const token = await reauthenticate(check, 'revoke_session', id); if (!token) return;
          try { await auth.request(`/sessions/${id}`, { method: 'DELETE', reauthToken: token }); }
          catch (error) {
            if (error.status == null || error.status === 0 || ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500) {
              error.message = '退出该设备的结果尚未确认。服务器可能已经完成操作；请刷新设备列表确认。再次选择同一设备只会针对这个固定会话，不会影响后来登录的设备。';
            }
            throw error;
          }
          check(); await renderRoute(); toast('已退出该设备。');
        }),
        onRevokeOthers: ownedAction(async (check) => {
          const settingName = `pending-revoke-others:${userId}`;
          const previous = await metadata.getSetting(settingName, null); check();
          const requestId = previous?.userId === userId ? previous.requestId : crypto.randomUUID();
          const token = await reauthenticate(check, 'revoke_others'); if (!token) return;
          if (requestId !== previous?.requestId) await metadata.setSetting(settingName, { userId, requestId, createdAt: new Date().toISOString() });
          check();
          try {
            await auth.request('/sessions/revoke-others', { method: 'POST', body: { reauthToken: token, requestId } });
            check(); await metadata.setSetting(settingName, null); await renderRoute(); toast('其他设备已退出。');
          } catch (error) {
            if (error.status == null || error.status === 0 || ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code) || error.status >= 500) {
              error.message = '退出其他设备的结果尚未确认。恢复网络后再次点击，将复用原请求编号，不会影响之后新登录的设备。';
            } else await metadata.setSetting(settingName, null);
            throw error;
          }
        }) }));
    }
  } catch (error) {
    if (version === routeVersion && !blocked) app.replaceChildren(h('main', { className: 'account-page' }, h('h1', {}, '暂时无法读取账号'), h('p', { role: 'alert' }, error.message), button('重试', () => navigate(activeUrl, { replace: true })), button('返回日记', () => navigate('/today'))));
  }
}

window.addEventListener('popstate', () => {
  if (operationBusy || blocked) { history.pushState({}, '', activeUrl); return; }
  navigate(`${location.pathname}${location.search}`, { replace: true, pop: true });
});
window.addEventListener('beforeunload', (event) => { if (workspace?.dirty || operationBusy) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) workspace?.flush().catch(() => {}); deviceLock?.onActive(!document.hidden); });
document.addEventListener('keydown', (event) => {
  deviceLock?.activity();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); workspace?.flush().catch(errorNotice); }
  if (event.key === 'Escape') document.body.classList.remove('focus-mode');
});
document.addEventListener('pointerdown', () => deviceLock?.activity(), { passive: true });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => workspace?.applyAppearance().catch(errorNotice));
matchMedia('(max-width: 767px)').addEventListener('change', () => { if (workspace && !operationBusy) navigate(activeUrl, { replace: true }); });

try {
  metadata = await openRepository('device');
  const [{ createReminderService }, { createDeviceLock }] = await Promise.all([import('./services/device-reminders.js'), import('./services/device-lock.js')]);
  reminders = createReminderService({ metadata, native: isNative, platform, notify: toast, openToday: () => navigate('/today') });
  deviceLock = createDeviceLock({ metadata, secrets: isNative ? nativeLockSecretStore : undefined, native: isNative, onChange: lockStateChanged });
  await deviceLock.initialize();
  if (isNative) {
    try { const { createNativeBiometric } = await import('./services/native-biometric.js'); biometric = await createNativeBiometric(); }
    catch { biometric = null; }
  }
  let baseUrl;
  try { baseUrl = apiBase({ native: isNative, configured: import.meta.env.VITE_API_BASE_URL, origin: location.origin }); }
  catch (error) { if (!isNative) throw error; }
  auth = createAuthClient({ baseUrl, native: isNative, platform, metadata, secrets: isNative ? nativeSessionStore : undefined,
    channel: !isNative && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('diary-v2:authentication') : null, onInvalidated: sessionInvalidated });
  const state = await auth.initialize();
  lockStateChanged({ ...deviceLock.view(), reason: 'initialize' });
  const preferred = await metadata.getSetting('preferred-space', 'account');
  const lockState = deviceLock.view();
  const offlineAccount = state.status === 'expired' && state.offlineEligible && preferred !== 'learning'
    && lockState.locked && lockState.settings.enabled && lockState.settings.hasPin;
  const selectedUser = state.status === 'online' && preferred !== 'learning' ? state.user
    : offlineAccount ? { ...state.user, offline: true } : null;
  await selectSpace(selectedUser, state.epoch ?? crypto.randomUUID(), { persistPreference: false });
  document.documentElement.dataset.platform = platform;
  await bindNativeLifecycle({ save: () => workspace?.flush() ?? Promise.resolve(), reportError: errorNotice,
    onActive: (active) => { nativeActive = active; deviceLock?.onActive(active); syncScheduler?.retry(); if (active) reminders?.refresh().catch(errorNotice); },
    back: async () => {
      if (operationBusy || blocked) return false;
      if (stack.length > 1) { await navigate(stack.at(-2), { replace: true, back: true }); return false; }
      if (activeUrl === '/today' || activeUrl === '/') { try { await saveBeforeLeave(); workspace?.resume(); return true; } catch (error) { errorNotice(error); return false; } }
      await navigate('/today', { replace: true }); return false;
    } });
  await renderRoute();
  await reminders.start().catch(errorNotice);
  pwa.start();
  if (offlineAccount) toast('账号暂时无法联网确认。输入本机 PIN 后可使用此设备上的账号副本；当前不会同步。');
  else if (state.status === 'expired') toast('账号会话暂未恢复，请重新登录。原账号本机副本仍保留；未配置本机 PIN 时不能离线打开账号空间。');
} catch (error) {
  app.replaceChildren(h('main', { className: 'account-page' }, h('h1', {}, '暂时无法打开日记本'), h('p', { role: 'alert' }, error.message), h('p', {}, '请保留已有站点或 App 数据，不要卸载或清空。'), button('重试', () => location.reload())));
}
