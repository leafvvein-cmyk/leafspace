import { localDate, offsetDate, isDate, makeDraft, MOODS, contentText } from '@diary/contracts';
import { entryMarkdown } from '@diary/contracts/markdown';
import { exportsPage } from './exports-page.js';
import { isNative, platform } from '../services/platform.js';
import { readingContent } from './reading.js';
import { conflictComparison, conflictReason } from './conflicts.js';
import { h, icon, button, iconButton, toast, downloadFile } from './dom.js';
import { contentAssetIds } from '../services/local-assets.js';
import { createVaultController } from '../services/vault-crypto.js';
import { createVaultSync } from '../services/vault-sync.js';
import { createTaskSync } from '../services/task-sync.js';
import { createTaskReminderService } from '../services/task-reminders.js';

/** One immutable repository per workspace instance. Async callbacks from an
 * old account can never resolve a mutable global store belonging to a new one. */
export function createWorkspace({ repository, user, onNavigate, onReplace, accountPanel, readRemoteEntry, requestCloud, downloadCloudAsset, exportDownloadUrl, purgeCloudEntries, reminders, deviceLock, biometric, learningMigration, canResolveConflict = () => false, onLocalChange = () => {} }) {
const pendingWrites = new Set();
let destroyed = false;
const store = new Proxy(repository, { get(target, key) {
  if (!['save', 'saveAsset', 'retryAssetUpload', 'clearDownloadedAssetCache', 'trash', 'restore', 'setSetting', 'copyConflict', 'keepCloud', 'saveMergeDraft', 'saveTask', 'setTaskStatus', 'saveVaultConfig', 'saveVaultItem', 'deleteVaultItem', 'prepareVaultKeyRotation', 'activateVaultKeyRotation', 'cancelPreparedVaultKeyRotation', 'bindVaultKeyRotation', 'completeVaultKeyRotation'].includes(key)) return target[key];
  return (...args) => {
    if (destroyed) return Promise.reject(new Error('这个日记空间已关闭，修改未写入其他账号。'));
    const operation = Promise.resolve().then(() => target[key](...args));
    pendingWrites.add(operation);
    operation.then(() => { pendingWrites.delete(operation); if (!destroyed && !['setSetting', 'saveMergeDraft'].includes(key)) onLocalChange(); }, () => pendingWrites.delete(operation));
    return operation;
  };
} });
const vaultSync = user && requestCloud ? createVaultSync({ store, request: requestCloud, isCurrent: () => alive() && Boolean(user) }) : null;
const vault = createVaultController(store, { sync: vaultSync });
const taskSync = user && requestCloud ? createTaskSync({ store, request: requestCloud, isCurrent: () => alive() && Boolean(user) }) : null;
const taskReminders = createTaskReminderService({ store, native: isNative, platform, notify: toast, openTasks: () => navigate('/tasks') });
const unsubscribeVault = vault.subscribe(() => { if (alive() && location.pathname === '/vault') render(); });
const localPlace = isNative ? '此手机 App' : '此浏览器';
const phoneLayout = matchMedia('(max-width: 767px)');
const app = h('div', { className: 'workspace-host' });
const alive = () => !destroyed && app.isConnected;
let activeEditor = null;
let renderVersion = 0;
let searchVersion = 0;
let searchTimer;
let dayBoundaryTimer;
let syncRefresh = null;
const timelineState = { limit: 50, scroll: 0, filters: { kind: '', mood: '', tag: '', from: '', to: '' } };
const searchState = { q: '', kind: '', mood: '', tag: '', from: '', to: '', scroll: 0, limit: 50 };
const spaceName = user ? `${user.displayName || user.username}的日记` : '本机学习空间';
const tabChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`diary-v2:${repository.namespace}`) : null;
const imageDownloads = new Map();

async function resolveImage(entryId, assetId) {
  const local = await store.getAsset(assetId); if (local) return local;
  if (!user || !requestCloud || !downloadCloudAsset) throw new Error('此图片尚未下载到本机');
  if (!imageDownloads.has(assetId)) imageDownloads.set(assetId, (async () => {
    const metadata = await requestCloud(`/assets/${assetId}`);
    if (metadata.status !== 'ready' || !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)) throw new Error('云端图片尚未准备好');
    const link = await requestCloud(`/assets/${assetId}/read-url`, { method: 'POST', body: { variant: 'original' } });
    const bytes = await downloadCloudAsset(link.url);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return store.saveAsset({ id: assetId, entryId, mimeType: 'image/webp', size: bytes.byteLength,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''), width: metadata.width, height: metadata.height,
      status: 'ready', cacheSource: 'remote', createdAt: new Date().toISOString(), bytes });
  })().finally(() => imageDownloads.delete(assetId)));
  return imageDownloads.get(assetId);
}

const navItems = [
  { href: '/today', label: '今天', glyph: 'book' },
  { href: '/tasks', label: '待办', glyph: 'check' },
  { href: '/timeline', label: '时间线', glyph: 'timeline' },
  { href: '/calendar', label: '日历', glyph: 'calendar' },
  { href: '/search', label: '搜索', glyph: 'search' },
  { href: '/tags', label: '标签', glyph: 'tag' },
];

function navLink(item, pathname) {
  return h('a', { href: item.href, className: `nav-link${pathname === item.href ? ' selected' : ''}`, 'aria-current': pathname === item.href ? 'page' : null, onclick: (event) => { event.preventDefault(); navigate(item.href); } }, icon(item.glyph), h('span', {}, item.label));
}

function formatDay(date, options = {}) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', ...options }).format(new Date(`${date}T12:00:00Z`));
}

function datePicker(date) {
  const input = h('input', { type: 'date', value: date, 'aria-label': '选择日记日期', className: 'date-picker', onchange: () => { if (isDate(input.value)) navigate(`/today?date=${input.value}`); } });
  return h('div', { className: 'date-controls' }, iconButton('前一天', 'left', () => navigate(`/today?date=${offsetDate(date, -1)}`)), input, iconButton('后一天', 'right', () => navigate(`/today?date=${offsetDate(date, 1)}`)));
}

function pageHeader(title, subtitle, actions = []) {
  return h('header', { className: 'page-header' }, h('div', {}, subtitle && h('p', { className: 'eyebrow' }, subtitle), h('h1', {}, title)), h('div', { className: 'page-actions' }, actions));
}

function emptyState(title, detail, action, glyph = 'book') {
  return h('div', { className: 'empty-state' }, h('div', { className: 'empty-icon' }, icon(glyph, 32)), h('h2', {}, title), h('p', {}, detail), action);
}

async function exportLearning() {
  if (!alive()) return;
  await activeEditor?.flush();
  const backup = await store.exportLocal();
  if (!alive()) return;
  await downloadFile(`日记本机备份-${localDate()}.json`, JSON.stringify(backup, null, 2));
  toast(isNative ? '已打开系统导出。请确认保存结果；导出文件未加密。' : '备份已交给浏览器下载。文件未加密，请妥善保存。');
}

function shell(pathname) {
  const sidebar = h('aside', { className: 'sidebar', 'aria-label': '主导航' },
    h('a', { className: 'brand', href: '/today', onclick: (event) => { event.preventDefault(); navigate('/today'); } }, h('span', { className: 'brand-mark' }, icon('book', 27)), h('span', {}, '日记', h('small', {}, 'DIARY'))),
    button('写一条随记', () => navigate(`/entries/new?kind=moment&date=${localDate()}`), { glyph: 'plus', className: 'button primary new-entry' }),
    h('nav', { className: 'main-navigation' }, navItems.map((item) => navLink(item, pathname))),
    h('div', { className: 'sidebar-bottom' },
      navLink({ href: '/vault', label: '密码本', glyph: 'lock' }, pathname),
      navLink({ href: '/trash', label: '回收站', glyph: 'trash' }, pathname),
      navLink({ href: '/settings', label: '设置', glyph: 'settings' }, pathname),
      h('div', { className: 'space-card' }, h('div', { className: 'space-title' }, icon('offline', 17), spaceName), h('p', {}, user?.offline ? '本机 PIN 离线模式；当前不进行云同步' : user ? '修改先存本机，联网后尝试同步；状态见设置' : `内容只保存在${localPlace}`), button(user?.offline ? '联网重新登录' : user ? '账号与安全' : '账号密码登录', () => navigate(user?.offline ? '/login' : user ? '/settings/account' : '/login'), { className: 'text-button' }), button('备份本机内容', () => exportLearning().catch(reportError), { className: 'text-button', glyph: 'download' })))),
    bottom = h('nav', { className: 'bottom-navigation', 'aria-label': '手机主导航' },
      [...navItems.slice(0, 3), { href: '/settings', label: '我的', glyph: 'settings' }].map((item) => navLink(item, pathname))),
    main = h('main', { id: 'main', tabindex: '-1', className: 'main-content' });
  return { root: h('div', { className: 'app-shell' }, sidebar, main, bottom), main };
}

function navigate(url, options) { return alive() ? onNavigate(url, options) : Promise.resolve(false); }

function reportError(error) { if (alive()) toast(error.message || '操作未完成，请重试。'); }

function watchDayBoundary(entry, anchor) {
  clearInterval(dayBoundaryTimer); dayBoundaryTimer = undefined;
  if (entry.kind !== 'daily' || entry.entryDate !== localDate()) return;
  const openedDate = entry.entryDate;
  const check = () => {
    const currentDate = localDate();
    if (!alive() || !anchor.isConnected || currentDate === openedDate) return;
    clearInterval(dayBoundaryTimer); dayBoundaryTimer = undefined;
    anchor.before(h('aside', { className: 'day-change-notice', role: 'status', 'aria-live': 'polite' },
      h('div', {}, h('strong', {}, '已是新的一天'), h('p', {}, `这篇仍保存在 ${formatDay(openedDate)}，不会自动改日期。`)),
      button('另写今天', () => navigate(`/today?date=${currentDate}`), { className: 'button subtle compact', glyph: 'plus' })));
  };
  dayBoundaryTimer = setInterval(check, 15000);
}

async function confirmTrash(id) {
  await activeEditor?.flush();
  if (!alive()) return;
  const dialog = h('dialog', { className: 'confirmation' },
    h('h2', {}, '移到回收站？'), h('p', {}, '这篇记录不会立即消失，你可以在回收站恢复。'),
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), button('移到回收站', async () => {
      try { if (!alive()) return; await store.trash(id); dialog.close(); if (!alive()) return; toast('已移到本机回收站'); await navigate('/timeline'); }
      catch (error) { reportError(error); }
    }, { className: 'button danger' })));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
}

async function attachEditor(entry, target, extra = {}) {
  if (!target.isConnected) return;
  const version = renderVersion;
  const { createEditorView } = await import('./editor.js');
  if (!alive() || !target.isConnected || version !== renderVersion) return;
  activeEditor = createEditorView(entry, {
    onSave: store.save,
    onAddImage: store.saveAsset,
    onPickImage: isNative ? (source) => import('../services/native-image-picker.js').then(({ pickNativeImage }) => pickNativeImage(source)) : null,
    resolveAsset: (assetId) => resolveImage(entry.id, assetId),
    onAssetState: async (content) => {
      const ids = contentAssetIds(content);
      if (!ids.length) return { total: 0, waiting: 0, failed: 0, ready: 0, missing: 0, canUpload: Boolean(user) };
      const assets = await Promise.all(ids.map((id) => store.getAsset(id)));
      return assets.reduce((state, asset) => {
        if (!asset) state.missing++;
        else if (asset.status === 'error') state.failed++;
        else if (asset.status === 'ready') state.ready++;
        else state.waiting++;
        return state;
      }, { total: ids.length, waiting: 0, failed: 0, ready: 0, missing: 0, canUpload: Boolean(user) });
    },
    onSaved: (saved) => {
      if (!alive()) return;
      tabChannel?.postMessage({ entryId: saved.id, revision: saved.localRevision });
      if (location.pathname === '/entries/new' && activeEditor?.id === saved.id) {
        onReplace(`/entries/${saved.id}/edit`);
      }
    },
    onTrash: confirmTrash,
    onRecovered: (saved) => navigate(`/entries/${saved.id}/edit`, { replace: true }),
    ...extra,
  });
  target.append(activeEditor.root);
  watchDayBoundary(entry, activeEditor.root);
}

async function todayPage(main, query) {
  const date = isDate(query.get('date')) ? query.get('date') : localDate();
  const entries = await store.day(date);
  const daily = entries.find((entry) => entry.kind === 'daily') ?? await store.dailyDraft(date) ?? makeDraft({ entryDate: date });
  const dailyExists = daily.localRevision > 0 || daily.revision !== '0';
  const moments = entries.filter((entry) => entry.kind === 'moment').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  main.append(pageHeader(date === localDate() ? '今天' : formatDay(date), formatDay(date, { year: 'numeric', weekday: 'long' }), [
    datePicker(date), iconButton('搜索日记', 'search', () => navigate('/search')), button('写随记', () => navigate(`/entries/new?kind=moment&date=${date}`), { glyph: 'plus', className: 'button primary compact' }),
  ]));
  const writing = h('div', { className: 'writing-main' });
  const aside = h('aside', { className: 'day-aside', 'aria-label': '当天随记' },
    h('div', { className: 'date-stamp', 'aria-hidden': 'true' }, h('span', { className: 'stamp-month' }, `${Number(date.slice(5, 7))} 月`), h('strong', {}, date.slice(8)), h('span', { className: 'stamp-weekday' }, formatDay(date, { weekday: 'long' }).split('日').pop())),
    h('div', { className: 'section-heading' }, h('h2', {}, '这一天的随记'), h('span', { className: 'count-badge' }, moments.length)),
    moments.length ? h('div', { className: 'moment-list' }, moments.map((entry) => entryCard(entry, { compact: true }))) : h('div', { className: 'moment-empty' }, h('span', { className: 'quiet-line' }), h('p', {}, '路上的风景，突然的念头。'), h('p', { className: 'muted' }, '随时留在这里。')),
    button('记下一瞬间', () => navigate(`/entries/new?kind=moment&date=${date}`), { glyph: 'plus', className: 'button subtle full-width' }),
    h('p', { className: 'local-note' }, icon('offline', 15), '已保存的文字可在本机继续查看。'));
  main.append(h('div', { className: 'today-layout' }, writing, aside));
  if (phoneLayout.matches) {
    writing.append(h('section', { className: 'today-summary' },
      h('p', { className: 'eyebrow' }, '每日一页'),
      h('h2', {}, daily.title || (dailyExists ? '留在这一天的文字' : '今天，想留住些什么？')),
      h('p', { className: 'summary-excerpt' }, contentText(daily.content).trim() || '一件小事，一种心情，写多少都可以。'),
      h('div', { className: 'summary-bottom' }, h('span', { className: 'muted' }, daily.localRevision ? '已保存在此设备' : dailyExists ? '已下载云端副本' : '还没有今天的日记'),
        button(dailyExists ? '继续写' : '开始写', () => navigate(dailyExists ? `/entries/${daily.id}/edit` : `/entries/new?kind=daily&date=${date}`), { className: 'button primary', glyph: 'edit' }))));
  } else await attachEditor(daily, writing);
}

function purgeEligible(entry) {
  return Boolean(user && purgeCloudEntries && entry.deletedAt && entry.purgeAfter && /^[1-9]\d{0,17}$/.test(entry.revision ?? ''));
}

function trashRetention(entry) {
  if (!user) return '只保存在当前设备，不会自动清空。';
  if (!entry.purgeAfter) return '尚未获得云端删除确认；不能声称已从云端永久清除。';
  const days = Math.max(0, Math.ceil((Date.parse(entry.purgeAfter) - Date.now()) / 86400000));
  return `云端计划在 ${new Date(entry.purgeAfter).toLocaleDateString('zh-CN')} 自动清理（约 ${days} 天）。`;
}

function confirmPurge(entries) {
  if (!purgeCloudEntries || !entries.length || entries.length > 20) return;
  const phrase = '永久删除';
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `输入“${phrase}”确认` });
  const accept = button(`永久删除 ${entries.length} 篇`, async () => {
    if (accept.disabled || input.value !== phrase || !alive()) return;
    accept.disabled = true; input.disabled = true;
    try {
      const result = await purgeCloudEntries(entries.map((entry) => ({ id: entry.id, baseRevision: entry.revision })));
      if (!result || !alive()) { accept.disabled = false; input.disabled = false; return; }
      dialog.close(); dialog.remove(); onLocalChange();
      toast(`已在云端永久删除 ${result.purged.length} 篇，正在更新本机列表。`);
      await navigate('/sync');
    } catch (error) { accept.disabled = false; input.disabled = false; reportError(error); }
  }, { className: 'button danger', disabled: true });
  input.addEventListener('input', () => { accept.disabled = input.value !== phrase; });
  const close = () => { if (input.disabled) return; dialog.close(); dialog.remove(); };
  const dialog = h('dialog', { className: 'confirmation' }, h('h2', {}, `永久删除 ${entries.length} 篇日记？`),
    h('p', { className: 'notice' }, '这会删除云端正文、标签关联，并使可能包含这些内容的快照和云端导出失效。操作不可恢复。'),
    h('ul', {}, entries.map((entry) => h('li', {}, entry.title || `${entry.entryDate} 的日记`))),
    h('label', { className: 'form-field' }, h('span', {}, `输入“${phrase}”确认`), input),
    h('p', { className: 'muted' }, '下一步还会要求输入当前账号密码。其他离线设备上已下载的副本不会被远程擦除。'),
    h('div', { className: 'account-actions' }, button('取消', close), accept));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  document.body.append(dialog); dialog.showModal(); input.focus();
}

function entryCard(entry, { compact = false, trash = false, selectable = false, selected = false, onSelect, onOpen } = {}) {
  const mood = MOODS.find((item) => item.value === entry.mood);
  const title = entry.title || `${formatDay(entry.entryDate)}的${entry.kind === 'daily' ? '日记' : '随记'}`;
  const eligible = trash && purgeEligible(entry);
  return h('article', { className: `entry-card${compact ? ' compact-card' : ''}` },
    h('div', { className: 'entry-meta' }, h('span', {}, entry.kind === 'daily' ? '每日一页' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(entry.occurredAt))), mood && h('span', { className: 'mood-chip' }, mood.label)),
    h('a', { className: 'entry-card-link', href: `/entries/${entry.id}`, onclick: (event) => { event.preventDefault(); onOpen?.(); navigate(`/entries/${entry.id}`); } }, h('h3', {}, title)),
    h('p', { className: 'entry-excerpt' }, contentText(entry.content).trim() || '只有标题的记录'),
    selectable && h('label', { className: 'checkbox-row entry-selector' }, h('input', { type: 'checkbox', checked: selected,
      onchange: (event) => onSelect?.(entry, event.target.checked, event.target) }), '选择这篇'),
    !compact && h('div', { className: 'card-bottom' }, h('div', { className: 'tag-chips' }, entry.tags.map((tag) => h('span', { className: 'tag-chip' }, `# ${tag.name}`))), h('span', { className: 'local-status' }, icon('check', 13), '本机已保存')),
    trash && h('p', { className: 'muted' }, trashRetention(entry)),
    trash && h('div', { className: 'account-actions' },
      eligible && h('label', { className: 'checkbox-row' }, h('input', { type: 'checkbox', checked: selected,
        onchange: (event) => onSelect?.(entry, event.target.checked, event.target) }), '选择'),
      button('恢复', async () => { try { await store.restore(entry.id); toast('已恢复'); await render(); } catch (error) { reportError(error); } }, { className: 'text-button', glyph: 'back' }),
      eligible && button('彻底删除', () => confirmPurge([entry]), { className: 'button danger' })));
}

async function listPage(main, { trash = false, tag } = {}) {
  const paged = !trash && !tag;
  const filters = paged ? timelineState.filters : {};
  const [allEntries, allActive] = await Promise.all([
    store.list({ state: trash ? 'trash' : 'active', tag, ...filters }),
    paged ? store.list({ state: 'active' }) : Promise.resolve([]),
  ]);
  const entries = paged ? allEntries.slice(0, timelineState.limit) : allEntries;
  main.append(pageHeader(trash ? '回收站' : tag ? `# ${tag}` : '时间线', trash ? '本机记录可在这里恢复' : '把每个普通日子，慢慢串起来', [iconButton('搜索日记', 'search', () => navigate('/search'))]));
  if (paged) {
    const type = h('select', { 'aria-label': '时间线记录类型' }, h('option', { value: '' }, '全部记录'), h('option', { value: 'daily' }, '每日一页'), h('option', { value: 'moment' }, '随记'));
    const mood = h('select', { 'aria-label': '时间线心情' }, h('option', { value: '' }, '全部心情'), MOODS.map((item) => h('option', { value: item.value }, item.label)));
    const tagFilter = h('select', { 'aria-label': '时间线标签' }, h('option', { value: '' }, '全部标签'),
      [...new Set(allActive.flatMap((entry) => entry.tags.map((item) => item.name)))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => h('option', { value: name }, `# ${name}`)));
    const from = h('input', { type: 'date', 'aria-label': '时间线开始日期' }), to = h('input', { type: 'date', 'aria-label': '时间线结束日期' });
    type.value = filters.kind; mood.value = filters.mood; tagFilter.value = filters.tag; from.value = filters.from; to.value = filters.to;
    const applyFilters = () => {
      timelineState.filters = { kind: type.value, mood: mood.value, tag: tagFilter.value, from: from.value, to: to.value };
      timelineState.limit = 50; timelineState.scroll = 0; render().catch(reportError);
    };
    [type, mood, tagFilter, from, to].forEach((control) => control.addEventListener('change', applyFilters));
    main.append(h('section', { className: 'search-controls timeline-filters', 'aria-label': '时间线筛选' },
      h('div', { className: 'filter-row' }, type, mood, tagFilter, h('label', {}, '从', from), h('label', {}, '到', to),
        button('清除筛选', () => { timelineState.filters = { kind: '', mood: '', tag: '', from: '', to: '' }; timelineState.limit = 50; timelineState.scroll = 0; render().catch(reportError); }, { className: 'text-button' }))));
  }
  const selected = new Map(); let batchButton;
  const updateBatch = () => {
    if (!batchButton) return;
    batchButton.disabled = !selected.size;
    batchButton.querySelector('span').textContent = trash
      ? (selected.size ? `永久删除已选 ${selected.size} 篇` : '批量彻底删除')
      : (selected.size ? `移入回收站 ${selected.size} 篇` : '批量移到回收站');
  };
  if (trash) {
    main.append(h('p', { className: 'notice' }, user ? '只有云端已确认进入回收站的记录才能永久删除；尚未上传的本机内容会继续保留。' : '这是独立的本机回收站，不会自动上传或清空。'));
    if (user) {
      batchButton = button('批量彻底删除', () => confirmPurge([...selected.values()]), { className: 'button danger', disabled: true });
      main.append(batchButton);
    }
  } else if (paged && entries.length) {
    batchButton = button('批量移到回收站', async () => {
      const chosen = [...selected.values()];
      if (!chosen.length || !window.confirm(`把明确选中的 ${chosen.length} 篇记录移到回收站？未显示和未选择的记录不会改变。`)) return;
      batchButton.disabled = true; let completed = 0;
      try {
        for (const entry of chosen) { await store.trash(entry.id); completed++; }
        toast(`已将选中的 ${completed} 篇记录移到回收站。`);
      } catch (error) {
        toast(`已移动 ${completed} 篇；其余记录没有被当作成功处理。${error.message || ''}`);
      }
      if (alive()) await render();
    }, { className: 'button danger', disabled: true });
    main.append(batchButton);
  }
  if (!entries.length) {
    const filtering = paged && Object.values(filters).some(Boolean);
    main.append(emptyState(trash ? '回收站是空的' : filtering ? '没有符合筛选的记录' : '故事从今天开始',
      trash ? '移到回收站的内容会出现在这里。' : filtering ? '清除或调整筛选条件，所有原记录都仍然保留。' : '第一篇日记，不必很长。',
      !trash && (filtering ? button('清除筛选', () => { timelineState.filters = { kind: '', mood: '', tag: '', from: '', to: '' }; timelineState.limit = 50; timelineState.scroll = 0; render().catch(reportError); }, { className: 'button' }) : button('写今天的日记', () => navigate('/today'), { className: 'button primary', glyph: 'edit' })))); return;
  }
  const groups = new Map();
  for (const entry of entries) { if (!groups.has(entry.entryDate)) groups.set(entry.entryDate, []); groups.get(entry.entryDate).push(entry); }
  const list = h('div', { className: 'timeline-list' });
  for (const [date, items] of groups) list.append(h('section', { className: 'timeline-group' }, h('h2', { className: 'timeline-date' }, formatDay(date, { year: 'numeric', weekday: 'short' })), h('div', { className: 'entry-grid' }, items.map((entry) => entryCard(entry, { trash, selectable: paged, selected: selected.has(entry.id), onOpen: paged ? () => { timelineState.scroll = window.scrollY; } : null, onSelect: (item, checked, checkbox) => {
    if (checked) {
      if (selected.size >= 20) { checkbox.checked = false; toast('一次最多选择 20 篇。'); return; }
      selected.set(item.id, item);
    } else selected.delete(item.id);
    updateBatch();
  } })))));
  main.append(list);
  if (paged && entries.length < allEntries.length) main.append(button(`加载更多（还有 ${allEntries.length - entries.length} 篇）`, async () => {
    const scroll = window.scrollY; timelineState.limit += 50; await render(); requestAnimationFrame(() => window.scrollTo(0, scroll));
  }, { className: 'button' }));
  if (paged && timelineState.scroll) requestAnimationFrame(() => { if (alive() && location.pathname === '/timeline') window.scrollTo(0, timelineState.scroll); });
}

async function entryPage(main, pathname, query) {
  const id = pathname.split('/')[2];
  let entry = id === 'new' ? makeDraft({ kind: query.get('kind') === 'moment' ? 'moment' : 'daily', entryDate: isDate(query.get('date')) ? query.get('date') : localDate() }) : await store.get(id) ?? await store.draft(id);
  if (!main.isConnected) return;
  if (!entry) { main.append(emptyState('这篇记录暂时找不到', '它可能已被删除，或保存在另一个浏览器中。', button('返回今天', () => navigate('/today')))); return; }
  if (id === 'new' && entry.kind === 'daily') {
    const existing = (await store.day(entry.entryDate)).find((item) => item.kind === 'daily') ?? await store.dailyDraft(entry.entryDate);
    if (!alive() || !main.isConnected) return;
    if (existing) {
      entry = existing;
      onReplace(`/entries/${existing.id}/edit`);
    }
  }
  const editing = id === 'new' || pathname.endsWith('/edit');
  document.body.classList.toggle('editing-page', editing && !entry.deletedAt);
  main.append(pageHeader(entry.kind === 'daily' ? '每日一页' : '随记', formatDay(entry.entryDate, { year: 'numeric', weekday: 'long' }), [
    button('返回时间线', () => navigate('/timeline'), { className: 'button subtle', glyph: 'back' }),
    !editing && button('导出 Markdown', async () => {
      try {
        if (!alive() || !main.isConnected) return;
        const exported = entryMarkdown(entry);
        if (!window.confirm(`导出当前显示的这篇日记为明文 Markdown？${exported.missingAssets.length ? '\n此文本文件不包含图片原文件，正文会标注缺少的图片。' : ''}\n这不是完整账号备份，请妥善保存。`)) return;
        await downloadFile(`日记-${entry.entryDate}-${entry.id}.md`, exported.markdown, 'text/markdown;charset=utf-8');
        if (alive() && main.isConnected) toast(isNative ? '已打开系统分享，请确认文件保存结果。' : 'Markdown 已交给浏览器下载。');
      } catch (error) { if (alive() && main.isConnected) reportError(error); }
    }, { glyph: 'download' }),
    !editing && button('打印 / 保存 PDF', () => window.print(), { className: 'button subtle' }),
    !entry.deletedAt && !editing && button('编辑日记', () => navigate(`/entries/${entry.id}/edit`), { className: 'button primary', glyph: 'edit' }),
    !entry.deletedAt && !editing && iconButton('移到回收站', 'trash', () => confirmTrash(entry.id)),
  ]));
  if (entry.deletedAt) {
    main.append(h('div', { className: 'reading-sheet' }, h('p', { className: 'notice' }, '此记录在回收站中，恢复后可继续编辑。'), h('h2', {}, entry.title || '无标题'), h('div', { className: 'plain-reading' }, contentText(entry.content)), button('恢复记录', async () => { try { await store.restore(entry.id); await render(); } catch (error) { reportError(error); } }, { className: 'button primary' })));
  } else if (editing) await attachEditor(entry, main, { onBack: () => navigate('/timeline'), focus: id === 'new' });
  else main.append(h('article', { className: 'reading-sheet' },
    h('h2', {}, entry.title || '无标题'), h('div', { className: 'tag-chips' }, entry.tags.map((tag) => h('span', { className: 'tag-chip' }, `# ${tag.name}`))), readingContent(entry.content, { resolveAsset: (assetId) => resolveImage(entry.id, assetId) })));
}

async function calendarPage(main, query) {
  const month = /^\d{4}-\d{2}$/.test(query.get('month') ?? '') && isDate(`${query.get('month')}-01`) ? query.get('month') : localDate().slice(0, 7);
  const first = `${month}-01`;
  const nextMonth = offsetDate(first, 32).slice(0, 7);
  const previousMonth = offsetDate(first, -1).slice(0, 7);
  const lastDay = offsetDate(`${nextMonth}-01`, -1);
  const entries = await store.list({ from: first, to: lastDay });
  main.append(pageHeader('日历', '按日期翻阅你的记录', [iconButton('上个月', 'left', () => navigate(`/calendar?month=${previousMonth}`)), h('strong', { className: 'calendar-month' }, `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`), iconButton('下个月', 'right', () => navigate(`/calendar?month=${nextMonth}`))]));
  const grid = h('div', { className: 'calendar-grid' });
  for (const day of ['一', '二', '三', '四', '五', '六', '日']) grid.append(h('div', { className: 'weekday' }, day));
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  for (let n = 0; n < offset; n++) grid.append(h('div', { className: 'calendar-blank', 'aria-hidden': 'true' }));
  for (let day = 1; day <= Number(lastDay.slice(8)); day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const dayEntries = entries.filter((entry) => entry.entryDate === date), count = dayEntries.length;
    const mood = MOODS.find((item) => item.value === (dayEntries.find((entry) => entry.kind === 'daily' && entry.mood)?.mood ?? dayEntries.find((entry) => entry.mood)?.mood));
    grid.append(h('button', { type: 'button', className: `calendar-day${date === localDate() ? ' is-today' : ''}${count ? ' has-entries' : ''}`, 'aria-label': `${formatDay(date)}，${count ? `${count} 篇记录${mood ? `，心情${mood.label}` : ''}` : '尚无记录，点击补写'}`, onclick: () => navigate(`/today?date=${date}`) },
      h('span', {}, day), mood && h('span', { className: `calendar-mood mood-${mood.value}`, 'aria-hidden': 'true' }, mood.face), count && h('span', { className: 'calendar-count' }, `${count} 篇`)));
  }
  main.append(h('section', { className: 'calendar-sheet' }, grid), h('p', { className: 'muted small-note' }, `只统计${localPlace}已保存的内容。点击日期，可以继续或补写那一天。`));
}

async function searchPage(main) {
  const allEntries = await store.list();
  main.append(pageHeader('搜索', `在已保存在${localPlace}的日记中查找`));
  const results = h('div', { className: 'entry-grid search-results', 'aria-live': 'polite' });
  const input = h('input', { type: 'search', placeholder: '搜索标题、正文或标签…', 'aria-label': '搜索日记', maxlength: 100, value: searchState.q });
  const kind = h('select', { 'aria-label': '记录类型' }, h('option', { value: '' }, '全部记录'), h('option', { value: 'daily' }, '每日一页'), h('option', { value: 'moment' }, '随记'));
  const mood = h('select', { 'aria-label': '心情筛选' }, h('option', { value: '' }, '全部心情'), MOODS.map((item) => h('option', { value: item.value }, item.label)));
  const tag = h('select', { 'aria-label': '标签筛选' }, h('option', { value: '' }, '全部标签'),
    [...new Set(allEntries.flatMap((entry) => entry.tags.map((item) => item.name)))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => h('option', { value: name }, `# ${name}`)));
  const from = h('input', { type: 'date', 'aria-label': '开始日期' });
  const to = h('input', { type: 'date', 'aria-label': '结束日期' });
  kind.value = searchState.kind; mood.value = searchState.mood; tag.value = searchState.tag; from.value = searchState.from; to.value = searchState.to;
  async function search() {
    if (!alive() || !results.isConnected) return;
    const request = ++searchVersion;
    Object.assign(searchState, { q: input.value, kind: kind.value, mood: mood.value, tag: tag.value, from: from.value, to: to.value });
    const found = await store.list({ q: searchState.q, kind: searchState.kind, mood: searchState.mood, tag: searchState.tag, from: searchState.from, to: searchState.to });
    if (request !== searchVersion || !results.isConnected) return;
    const visible = found.slice(0, searchState.limit);
    const children = found.length
      ? visible.map((entry) => entryCard(entry, { onOpen: () => { searchState.scroll = window.scrollY; } }))
      : [emptyState('没有找到匹配的记录', '换个词试试，或清除筛选条件。', null, 'search')];
    if (visible.length < found.length) children.push(button(`加载更多搜索结果（还有 ${found.length - visible.length} 篇）`, async () => {
      const scroll = window.scrollY; searchState.limit += 50; await search(); requestAnimationFrame(() => window.scrollTo(0, scroll));
    }, { className: 'button' }));
    results.replaceChildren(...children);
    if (searchState.scroll) requestAnimationFrame(() => { if (alive() && location.pathname === '/search') window.scrollTo(0, searchState.scroll); });
  }
  input.addEventListener('input', () => { clearTimeout(searchTimer); searchState.limit = 50; searchState.scroll = 0; searchTimer = setTimeout(() => search().catch(reportError), 300); });
  [kind, mood, tag, from, to].forEach((control) => control.addEventListener('change', () => { searchState.limit = 50; searchState.scroll = 0; search().catch(reportError); }));
  main.append(h('section', { className: 'search-controls' }, h('label', { className: 'search-box' }, icon('search'), input), h('div', { className: 'filter-row' }, kind, mood, tag, h('label', {}, '从', from), h('label', {}, '到', to), button('清除筛选', () => { input.value = ''; kind.value = ''; mood.value = ''; tag.value = ''; from.value = ''; to.value = ''; searchState.limit = 50; searchState.scroll = 0; search().catch(reportError); }, { className: 'text-button' }))), results);
  await search();
}

async function tagsPage(main) {
  const entries = await store.list();
  const tags = new Map();
  for (const entry of entries) for (const tag of entry.tags) tags.set(tag.name, (tags.get(tag.name) ?? 0) + 1);
  main.append(pageHeader('标签', '给生活里反复出现的事，留一个位置'));
  if (!tags.size) { main.append(emptyState('还没有标签', '在日记的标签栏输入“生活”或“工作”，就能在这里按标签整理。', button('去写日记', () => navigate('/today'), { className: 'button primary' }), 'tag')); return; }
  const list = h('div', { className: 'tag-grid' });
  const change = async (name, count, remove = false) => {
    let next = null;
    if (!remove) {
      next = window.prompt(`把标签“${name}”重命名为：`, name);
      if (next === null || next === name) return;
    } else if (!window.confirm(`从 ${count} 篇记录中移除标签“${name}”？日记内容不会删除。`)) return;
    try {
      const { applyTagChange } = await import('../services/tag-management.js');
      const result = await applyTagChange({ store, from: name, to: remove ? null : next,
        onProgress: ({ completed, total }) => toast(`正在更新标签 ${completed}/${total}…`) });
      if (result.changed) onLocalChange();
      toast(result.changed ? `已更新 ${result.changed} 篇记录，正在等待同步。` : '没有需要更新的记录。'); await render();
    } catch (error) { reportError(error); }
  };
  for (const [name, count] of tags) list.append(h('section', { className: 'tag-manage-card' },
    button(`${name} · ${count} 篇`, () => navigate(`/tags/view?name=${encodeURIComponent(name)}`), { glyph: 'tag', className: 'tag-tile' }),
    h('div', { className: 'account-actions' }, button('重命名', () => change(name, count), { className: 'text-button' }), button('移除标签', () => change(name, count, true), { className: 'text-button' }))));
  main.append(list);
}

async function settingsPage(main) {
  const entries = await store.list();
  const theme = await store.getSetting('theme', 'system');
  const storedFontSize = await store.getSetting('fontSize', 18), fontSize = Number.isInteger(storedFontSize) && storedFontSize >= 16 && storedFontSize <= 24 ? storedFontSize : 18;
  const storedFamily = await store.getSetting('fontFamily', 'serif'), fontFamily = ['serif', 'sans', 'system'].includes(storedFamily) ? storedFamily : 'serif';
  const storedWidth = await store.getSetting('writingWidth', 848), writingWidth = Number.isInteger(storedWidth) && storedWidth >= 600 && storedWidth <= 920 ? storedWidth : 848;
  if (!alive() || !main.isConnected) return;
  const storageNotice = isNative ? '账号空间支持云端同步，但卸载 App 或清除应用数据仍会移除本机副本；请确认同步状态并保留导出备份。' : '账号空间支持云端同步，但清除浏览器站点数据仍会移除本机副本；请确认同步状态并保留导出备份。';
  main.append(pageHeader('我的日记本', spaceName));
  const appearance = h('select', { 'aria-label': '外观主题', onchange: async (event) => { try { const value = event.target.value; await store.setSetting('theme', value); if (alive()) applyTheme(value); } catch (error) { reportError(error); } } }, h('option', { value: 'system' }, '跟随系统'), h('option', { value: 'light' }, '浅色'), h('option', { value: 'dark' }, '深色'));
  appearance.value = theme;
  const size = h('input', { type: 'range', min: 16, max: 24, step: 1, value: fontSize, 'aria-label': '正文字号' });
  const sizeLabel = h('output', {}, `${fontSize}px`);
  size.addEventListener('input', () => { document.documentElement.style.setProperty('--writing-size', `${size.value}px`); sizeLabel.textContent = `${size.value}px`; });
  size.addEventListener('change', () => store.setSetting('fontSize', Number(size.value)).catch(reportError));
  const family = h('select', { 'aria-label': '正文字体', onchange: async () => {
    try { await store.setSetting('fontFamily', family.value); if (alive()) document.documentElement.dataset.writingFont = family.value; }
    catch (error) { reportError(error); }
  } }, h('option', { value: 'serif' }, '书写衬线体'), h('option', { value: 'sans' }, '清晰无衬线体'), h('option', { value: 'system' }, '系统字体'));
  family.value = fontFamily;
  const width = h('input', { type: 'range', min: 600, max: 920, step: 20, value: writingWidth, 'aria-label': '电脑书写宽度' });
  const widthLabel = h('output', {}, `${writingWidth}px`);
  width.addEventListener('input', () => { document.documentElement.style.setProperty('--writing-width', `${width.value}px`); widthLabel.textContent = `${width.value}px`; });
  width.addEventListener('change', () => store.setSetting('writingWidth', Number(width.value)).catch(reportError));
  main.append(h('div', { className: 'settings-layout' },
    accountPanel(),
    h('section', { className: 'settings-card' }, h('h2', {}, '应用'), button('同步与冲突', () => navigate('/sync'), { className: 'setting-link' }), button('日记锁与隐私', () => navigate('/settings/privacy'), { className: 'setting-link' }), button('写作提醒', () => navigate('/settings/reminders'), { className: 'setting-link' }), button('关于与安装', () => navigate('/settings/about'), { className: 'setting-link', glyph: 'download' })),
    h('section', { className: 'settings-card profile-summary' }, h('div', { className: 'profile-mark' }, icon('book', 32)), h('h2', {}, '记录，就是值得'), h('div', { className: 'stats-row' }, h('div', {}, h('strong', {}, entries.length), h('span', {}, '篇记录')), h('div', {}, h('strong', {}, new Set(entries.map((entry) => entry.entryDate)).size), h('span', {}, '个写作日'))), h('p', { className: 'muted' }, storageNotice)),
    h('section', { className: 'settings-card' }, h('h2', {}, '外观与阅读'), h('label', { className: 'setting-row' }, h('span', {}, '外观主题'), appearance), h('label', { className: 'setting-row' }, h('span', {}, '正文字体'), family), h('label', { className: 'setting-row' }, h('span', {}, '正文字号'), h('div', { className: 'range-control' }, size, sizeLabel)), h('label', { className: 'setting-row desktop-writing-width' }, h('span', {}, '电脑书写宽度'), h('div', { className: 'range-control' }, width, widthLabel))),
    h('section', { className: 'settings-card' }, h('h2', {}, '内容与存储'), button('密码本', () => navigate('/vault'), { className: 'setting-link', glyph: 'lock' }), button('标签', () => navigate('/tags'), { className: 'setting-link', glyph: 'tag' }), button('回收站', () => navigate('/trash'), { className: 'setting-link', glyph: 'trash' }), button('存储空间', () => navigate('/settings/storage'), { className: 'setting-link' }), button('图片上传问题', () => navigate('/settings/images'), { className: 'setting-link', glyph: 'image' }), learningMigration && button('复制学习内容到账号', () => navigate('/settings/migrate'), { className: 'setting-link' }), button('导出本机全部内容', () => exportLearning().catch(reportError), { className: 'setting-link', glyph: 'download' }), h('p', { className: 'muted' }, '普通导出包含日记、草稿、冲突副本、本机图片和待办；密码本始终排除，请在密码本页面单独导出加密备份。')),
    h('section', { className: 'settings-card version-card' }, h('h2', {}, '开发进度'), h('p', {}, '多端开发版 · 0.1.0'), h('p', {}, isNative ? `${platform === 'android' ? 'Android' : 'iOS'} App · SQLite 本机存储` : '网页版 · IndexedDB 本机存储'), h('p', { className: 'muted' }, '账号密码登录、同步、私有图片、日记锁和提醒代码已接入；安装包、正式部署与真机验收仍未完成。'))));
}

async function syncPage(main) {
  main.append(pageHeader('同步中心', '本机修改与保留的冲突版本'), accountPanel());
  if (user) main.append(button('云端批量导出', () => navigate('/settings/exports'), { glyph: 'download' }));
  const list = h('div', { className: 'settings-layout' }), status = h('p', { role: 'status', className: 'muted' }, '正在读取冲突记录与备份…');
  let cursor = null, loading = false;
  const more = button('加载更多', () => load(), { hidden: true });
  main.append(status, list, more);
  async function load() {
    if (loading || !alive() || !main.isConnected) return;
    loading = true; more.disabled = true;
    try {
      const page = await store.listConflicts({ before: cursor });
      if (!alive() || !main.isConnected) return;
      for (const item of page.items) list.append(h('section', { className: 'settings-card' }, h('h2', {}, item.title),
        h('p', { className: 'muted' }, item.resolutionKind === 'keep-cloud' ? '已处理：保留云端版本，本机稿已归档'
          : item.resolutionKind === 'merged-local' ? '已在本机合并；上传结果请查看同步状态'
          : item.copyEntryId ? '已另存随记；原记录仍需处理' : conflictReason(item.code)),
        button(item.resolutionKind === 'keep-cloud' ? '查看处理记录与备份' : '比较保留版本', () => navigate(`/conflicts/${item.id}`), { className: 'button primary' })));
      status.textContent = list.childElementCount ? '以下记录保留了冲突或上传失败时的版本。' : '当前空间没有保存的冲突记录。';
      cursor = page.nextCursor; more.hidden = !page.hasMore;
    } catch (error) { status.textContent = '读取失败，请重试。'; more.hidden = false; reportError(error); }
    finally { loading = false; more.disabled = false; }
  }
  await load();
}

async function conflictPageView(main, path) {
  const id = path.split('/')[2];
  if (!/^[a-f0-9-]{36}$/i.test(id ?? '')) throw new Error('冲突记录编号无效');
  const bundle = await store.getConflict(id);
  if (!alive() || !main.isConnected) return;
  main.append(pageHeader('版本比较', '原有内容始终保留'));
  if (!bundle) { main.append(emptyState('找不到这次冲突', '它可能属于另一个账号空间。', button('返回同步中心', () => navigate('/sync')))); return; }
  if (path.endsWith('/merge')) {
    if (bundle.record.resolution) {
      main.append(emptyState('这次冲突已处理', '已有合并草稿仍保留在冲突备份中。', button('查看备份', () => navigate(`/conflicts/${id}`)))); return;
    }
    const source = bundle.record.mergeDraft?.entry ?? bundle.record.local;
    if (!source) throw new Error('没有可用于合并的本机稿，请先导出备份');
    document.title = '手动合并草稿 · 日记';
    main.append(h('p', { className: 'notice' }, '合并草稿单独保存在此设备。确认提交后才替换本机日记并尝试上传，原稿会归档。'),
      button('返回版本比较', () => navigate(`/conflicts/${id}`)));
    const reference = (title, entry) => h('details', { className: 'settings-card' },
      h('summary', {}, title), h('h2', {}, entry?.title || '无标题记录'),
      entry?.content ? readingContent(entry.content) : h('p', {}, '没有可显示的正文'));
    main.append(reference('查看冲突时的本机稿', bundle.record.local), reference('查看冲突时的另一版本', bundle.record.remote));
    if (user && readRemoteEntry) {
      const livePanel = h('div');
      const refresh = button('读取最新云端内容供参考', async () => {
        if (!alive() || !main.isConnected || refresh.disabled) return;
        refresh.disabled = true;
        try {
          const remote = await readRemoteEntry(bundle.record.entryId);
          if (!alive() || !main.isConnected) return;
          livePanel.replaceChildren(reference(`刚读取的云端版本 ${remote.revision}`, remote));
        } catch (error) { if (alive() && main.isConnected) reportError(error); }
        finally { refresh.disabled = false; }
      });
      main.append(refresh, livePanel);
    }
    const draft = { ...structuredClone(source), localRevision: bundle.record.mergeDraft?.revision ?? 0 };
    await attachEditor(draft, main, { onSave: (entry, revision) => store.saveMergeDraft(id, entry, revision),
      onSaved: () => {}, onTrash: null, onRecovered: null, onBack: () => navigate(`/conflicts/${id}`) });
    const mergeEditor = activeEditor;
    if (user && readRemoteEntry) {
      const submit = button('检查云端并确认提交合并', async () => {
        if (submit.disabled || !alive() || !main.isConnected || !canResolveConflict()) return;
        submit.disabled = true;
        const release = () => { submit.disabled = false; if (activeEditor === mergeEditor) mergeEditor.resume(); };
        try {
          await mergeEditor.prepareLeave();
          const saved = (await store.getConflict(id)).record.mergeDraft;
          if (!saved) throw new Error('请先编辑并保存合并草稿，再确认提交');
          const remote = await readRemoteEntry(bundle.record.entryId);
          if (!alive() || !main.isConnected || !canResolveConflict()) { release(); return; }
          const dialog = h('dialog', { className: 'confirmation' });
          const close = () => { dialog.close(); dialog.remove(); release(); };
          const accept = button('确认替换本机日记并尝试上传', async () => {
            if (accept.disabled) return;
            accept.disabled = true;
            try {
              if (!canResolveConflict() || !alive() || !main.isConnected) throw new Error('页面或登录状态已变化');
              await store.keepCloud(id, { expectedLocalRevision: bundle.latestLocal?.localRevision, remote, mergeRevision: saved.revision });
              close();
              if (alive() && main.isConnected) await navigate(`/entries/${bundle.record.entryId}`);
            } catch (error) { close(); if (alive() && main.isConnected) reportError(error); }
          }, { className: 'button primary' });
          const cloudPreview = reference(`云端版本 ${remote.revision}`, remote); cloudPreview.open = true;
          const mergePreview = reference('即将保存的合并结果', saved.entry); mergePreview.open = true;
          dialog.append(h('h2', {}, '确认提交合并？'), h('p', {}, '标题、正文、标签和心情使用合并稿；日期和类型沿用云端。上传前云端再次变化时会产生新的冲突，不会强行覆盖。'),
            cloudPreview, mergePreview, h('div', { className: 'account-actions' }, button('取消，继续编辑', close), accept));
          dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
          main.append(dialog); dialog.showModal();
        } catch (error) { release(); if (alive() && main.isConnected) reportError(error); }
      }, { className: 'button primary' });
      main.append(submit);
    }
    return;
  }
  main.append(conflictComparison(bundle, { namespace: repository.namespace, navigate, copyConflict: store.copyConflict,
    keepCloud: (...args) => {
      if (!canResolveConflict()) throw new Error('登录状态已变化，请重新打开页面');
      return store.keepCloud(...args);
    }, readRemoteEntry: user ? readRemoteEntry : null,
    isCurrent: () => alive() && main.isConnected, reportError }));
}

function applyTheme(theme) {
  const dark = theme === 'dark' || theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

async function render() {
  if (!alive()) return;
  clearTimeout(searchTimer); clearInterval(dayBoundaryTimer); dayBoundaryTimer = undefined; searchVersion++;
  const version = ++renderVersion;
  activeEditor?.destroy(); activeEditor = null;
  document.body.classList.remove('focus-mode', 'editing-page');
  const path = location.pathname === '/' ? '/today' : location.pathname;
  const query = new URLSearchParams(location.search);
  const layout = shell(path);
  app.replaceChildren(layout.root);
  if (user?.offline) layout.main.append(h('aside', { className: 'notice', role: 'status' }, '离线账号副本：修改只保存在此设备，当前不会上传、下载或执行云端安全操作。联网后请重新登录并检查同步状态。'));
  document.title = `${[...navItems, { href: '/settings', label: '我的' }, { href: '/trash', label: '回收站' }, { href: '/vault', label: '密码本' }].find((item) => item.href === path)?.label ?? '写日记'} · 日记`;
  try {
    if (path === '/sync') document.title = '同步中心 · 日记';
    if (path.startsWith('/conflicts/')) document.title = '版本比较 · 日记';
    if (path === '/sync') await syncPage(layout.main);
    else if (path.startsWith('/conflicts/')) await conflictPageView(layout.main, path);
    else if (path === '/today') await todayPage(layout.main, query);
    else if (path === '/tasks') {
      const { tasksPage } = await import('./tasks-page.js');
      const page = await tasksPage({ store, sync: taskSync, reminders: taskReminders, navigate, alive: () => alive() && layout.main.isConnected, reportError });
      if (alive() && layout.main.isConnected) layout.main.append(page);
    }
    else if (path === '/vault') {
      const { vaultPage } = await import('./vault-page.js');
      const page = await vaultPage({ controller: vault, alive: () => alive() && layout.main.isConnected });
      if (alive() && layout.main.isConnected) layout.main.append(page);
    }
    else if (path === '/timeline') await listPage(layout.main);
    else if (path === '/trash') await listPage(layout.main, { trash: true });
    else if (path === '/calendar') await calendarPage(layout.main, query);
    else if (path === '/search') await searchPage(layout.main);
    else if (path === '/tags/view') await listPage(layout.main, { tag: query.get('name') });
    else if (path === '/tags') await tagsPage(layout.main);
    else if (path.startsWith('/entries/')) await entryPage(layout.main, path, query);
    else if (path === '/settings/privacy') {
      document.title = '日记锁与隐私 · 日记';
      if (!deviceLock) layout.main.append(emptyState('日记锁暂时不可用', '当前设备没有初始化锁定服务。', button('返回设置', () => navigate('/settings'))));
      else { const { privacyPage } = await import('./privacy-page.js'); const page = await privacyPage({ service: deviceLock, navigate, native: isNative, biometric }); if (alive() && layout.main.isConnected) layout.main.append(page); }
    }
    else if (path === '/settings/reminders') {
      document.title = '写作提醒 · 日记';
      if (!reminders) layout.main.append(emptyState('提醒暂时不可用', '当前设备没有初始化提醒服务。', button('返回设置', () => navigate('/settings'))));
      else { const { remindersPage } = await import('./reminders-page.js'); const page = await remindersPage({ service: reminders, navigate, native: isNative }); if (alive() && layout.main.isConnected) layout.main.append(page); }
    }
    else if (path === '/settings/migrate') {
      document.title = '复制学习空间 · 日记';
      if (!learningMigration) layout.main.append(emptyState('请先登录账号', '登录后才能明确选择目标账号并复制学习内容。', button('返回设置', () => navigate('/settings'))));
      else { const { learningMigrationPage } = await import('./learning-migration-page.js'); const page = await learningMigrationPage({ migration: learningMigration, navigate }); if (alive() && layout.main.isConnected) layout.main.append(page); }
    }
    else if (path === '/settings/images') {
      document.title = '图片上传问题 · 日记';
      layout.main.append(pageHeader('图片上传问题', '保留在此设备、等待重新上传的原图'));
      const { imageProblemsPage } = await import('./image-problems-page.js');
      const page = await imageProblemsPage({ store, navigate, alive: () => alive() && layout.main.isConnected, reportError });
      if (alive() && layout.main.isConnected) layout.main.append(page);
    }
    else if (path === '/settings/storage') {
      document.title = '存储空间 · 日记';
      layout.main.append(pageHeader('存储空间', '区分可重新下载的缓存与必须保留的本机原件'));
      const { storagePage } = await import('./storage-page.js');
      const page = await storagePage({ store, navigate, alive: () => alive() && layout.main.isConnected, reportError });
      if (alive() && layout.main.isConnected) layout.main.append(page);
    }
    else if (path === '/settings/exports') {
      document.title = '云端导出 · 日记';
      layout.main.append(pageHeader('云端导出', '按固定云端快照生成归档'));
      if (!user || user.offline) layout.main.append(emptyState('请先联网登录账号', '离线模式不能创建或下载云端导出。本机内容可使用本机备份入口。', button('账号密码登录', () => navigate('/login'))));
      else {
        const page = await exportsPage({ store, request: requestCloud, alive: () => alive() && layout.main.isConnected,
          reportError, downloadUrl: exportDownloadUrl });
        if (alive() && layout.main.isConnected) { layout.main.append(page.root); await page.load(); }
      }
    }
    else if (path.startsWith('/settings')) await settingsPage(layout.main);
    else layout.main.append(emptyState('找不到这个页面', '请从导航返回你的日记。', button('返回今天', () => navigate('/today'))));
  } catch (error) {
    if (version === renderVersion) layout.main.append(emptyState('暂时无法打开', error.message, button('重试', () => render())));
  }
}

function refreshFromSync() {
  const path = location.pathname;
  const refreshable = ['/today', '/timeline', '/calendar', '/search', '/trash', '/tags', '/tags/view'].includes(path)
    || path.startsWith('/entries/') && !path.endsWith('/edit');
  if (!alive() || activeEditor || !refreshable) return Promise.resolve(false);
  if (syncRefresh) return syncRefresh;
  syncRefresh = Promise.resolve().then(async () => {
    if (!alive() || activeEditor) return false;
    await render(); return true;
  }).catch((error) => { reportError(error); return false; }).finally(() => { syncRefresh = null; });
  return syncRefresh;
}

tabChannel?.addEventListener('message', ({ data }) => {
  if (alive() && activeEditor?.id === data.entryId) toast('这篇日记在另一个窗口有更新。继续保存时会检查版本，避免覆盖。');
});

taskReminders.start().catch(reportError);

return {
  root: app, render, refreshFromSync, exportLocal: exportLearning,
  snapshot: () => activeEditor?.snapshot() ?? null,
  get dirty() { return activeEditor?.dirty ?? false; },
  flush: () => activeEditor?.flush() ?? Promise.resolve(),
  resume: () => activeEditor?.resume(),
  pause: () => activeEditor?.pause(),
  async prepareLeave() { await activeEditor?.prepareLeave(); await Promise.all([...pendingWrites]); },
  async applyAppearance() {
    const [theme, storedSize, storedFamily, storedWidth] = await Promise.all([store.getSetting('theme', 'system'), store.getSetting('fontSize', 18),
      store.getSetting('fontFamily', 'serif'), store.getSetting('writingWidth', 848)]);
    const size = Number.isInteger(storedSize) && storedSize >= 16 && storedSize <= 24 ? storedSize : 18;
    const family = ['serif', 'sans', 'system'].includes(storedFamily) ? storedFamily : 'serif';
    const width = Number.isInteger(storedWidth) && storedWidth >= 600 && storedWidth <= 920 ? storedWidth : 848;
    if (alive()) {
      applyTheme(theme); document.documentElement.style.setProperty('--writing-size', `${size}px`);
      document.documentElement.style.setProperty('--writing-width', `${width}px`); document.documentElement.dataset.writingFont = family;
    }
  },
  destroy() {
    destroyed = true; renderVersion++; searchVersion++; clearTimeout(searchTimer); clearInterval(dayBoundaryTimer);
    activeEditor?.destroy(); activeEditor = null; unsubscribeVault(); vault.destroy(); taskReminders.destroy().catch(() => {}); tabChannel?.close(); app.remove();
  },
};
}
