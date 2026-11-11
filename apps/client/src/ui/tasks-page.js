import { h, button, icon, toast } from './dom.js';
import { nativeAppActionCatalog } from '@diary/contracts/app-actions';
import { launchNativeAppAction } from '../services/native-app-actions.js';

const priorityLabels = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const stateLabels = { open: '待完成', completed: '已完成', trash: '已删除' };
const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const internalActionTargets = { '/today': '今天', '/tasks': '待办', '/timeline': '时间线', '/calendar': '日历' };
const nativeAppActions = nativeAppActionCatalog();
const nativeAppActionLabels = Object.fromEntries(nativeAppActions.map((action) => [action.id, action.label]));

function localInputValue(iso) {
  if (!iso) return '';
  const date = new Date(iso), offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function taskInput(task = {}) {
  task ??= {};
  const stamp = new Date().toISOString();
  return {
    id: task.id ?? crypto.randomUUID(), seriesId: task.seriesId ?? null, title: task.title ?? '', note: task.note ?? '',
    dueAt: task.dueAt ?? null, timezone: task.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai',
    priority: task.priority ?? 'normal', recurrence: task.recurrence ?? null,
    reminderMinutesBefore: task.reminderMinutesBefore ?? null, checklist: task.checklist ?? [], actions: task.actions ?? [], linkedEntryId: task.linkedEntryId ?? null,
    status: task.status ?? 'open', revision: task.revision ?? '0', localRevision: task.localRevision ?? 0,
    createdAt: task.createdAt ?? stamp, updatedAt: task.updatedAt ?? stamp, completedAt: task.completedAt ?? null, deletedAt: task.deletedAt ?? null,
  };
}

function editor(task, save) {
  const current = taskInput(task), editing = Boolean(task?.id);
  const title = h('input', { required: true, maxlength: '200', value: current.title, placeholder: '例如：确认项目进度', autocomplete: 'off' });
  const dueAt = h('input', { type: 'datetime-local', value: localInputValue(current.dueAt) });
  const priority = h('select', {}, ...Object.entries(priorityLabels).map(([value, label]) => h('option', { value, selected: current.priority === value }, label)));
  const note = h('textarea', { maxlength: '5000', rows: '4', placeholder: '补充说明（可选）' }, current.note);
  const checklist = h('textarea', { rows: '4', placeholder: '每行一个子项（可选）' }, current.checklist.map((item) => item.text).join('\n'));
  const reminder = h('select', {},
    h('option', { value: '', selected: current.reminderMinutesBefore == null }, '不提醒'),
    ...[[0, '到期时'], [10, '提前 10 分钟'], [30, '提前 30 分钟'], [60, '提前 1 小时'], [1440, '提前 1 天']]
      .map(([value, label]) => h('option', { value, selected: current.reminderMinutesBefore === value }, label)));
  const recurrence = h('select', {},
    h('option', { value: '', selected: !current.recurrence }, '不重复'),
    h('option', { value: 'daily', selected: current.recurrence?.frequency === 'daily' }, '每天'),
    h('option', { value: 'weekly', selected: current.recurrence?.frequency === 'weekly' }, '每周'),
    h('option', { value: 'monthly', selected: current.recurrence?.frequency === 'monthly' }, '每月'));
  const recurrenceInterval = h('input', { type: 'number', min: '1', max: '365', value: current.recurrence?.interval ?? 1, 'aria-label': '重复间隔' });
  const intervalUnit = h('span', {}, '天');
  const weekly = h('div', { className: 'task-weekdays', 'aria-label': '每周重复日期' }, ...weekdayLabels.map((label, index) => {
    const checked = current.recurrence?.frequency === 'weekly' ? (current.recurrence.weekdays?.includes(index + 1) ?? false) : false;
    return h('label', { className: 'checkbox-row compact' }, h('input', { type: 'checkbox', value: index + 1, checked }), label);
  }));
  const monthDay = h('input', { type: 'number', min: '1', max: '31', value: current.recurrence?.dayOfMonth ?? (dueAt.value ? Number(dueAt.value.slice(8, 10)) : 1), 'aria-label': '每月日期' });
  const recurrenceDetails = h('div', { className: 'task-recurrence-details' });
  const renderRecurrence = () => {
    recurrenceDetails.hidden = !recurrence.value;
    intervalUnit.textContent = recurrence.value === 'daily' ? '天' : recurrence.value === 'weekly' ? '周' : '个月';
    weekly.hidden = recurrence.value !== 'weekly'; monthDay.parentElement.hidden = recurrence.value !== 'monthly';
  };
  recurrenceDetails.append(h('label', { className: 'task-field compact' }, h('span', {}, '每隔'), h('div', { className: 'task-interval' }, recurrenceInterval, intervalUnit)), weekly,
    h('label', { className: 'task-field compact' }, h('span', {}, '每月日期（月底自动取最后一天）'), monthDay));
  recurrence.addEventListener('change', renderRecurrence); renderRecurrence();
  const actionList = h('div', { className: 'task-action-editor-list' }), actionRows = [];
  const addAction = (value = { type: 'internal', label: '打开今天', target: '/today' }) => {
    if (actionRows.length >= 20) return;
    const id = value.id ?? crypto.randomUUID(), type = h('select', { 'aria-label': '快捷动作类型' },
      h('option', { value: 'internal', selected: value.type === 'internal' }, '打开日记页面'), h('option', { value: 'https', selected: value.type === 'https' }, '打开 HTTPS 网页'),
      ...nativeAppActions.map((action, index) => index === 0 ? h('option', { value: 'external_app', selected: value.type === 'external_app' }, '打开已登记 App') : null));
    const label = h('input', { value: value.label ?? '', maxlength: '80', required: true, autocomplete: 'off', 'aria-label': '快捷动作名称' });
    const internalTarget = h('select', { 'aria-label': '快捷动作站内目标' }, ...Object.entries(internalActionTargets)
      .map(([target, name]) => h('option', { value: target, selected: value.target === target }, name)));
    const httpsTarget = h('input', { value: value.type === 'https' ? value.target : '', type: 'url', maxlength: '2048', placeholder: 'https://example.com', autocomplete: 'off', 'aria-label': '快捷动作 HTTPS 地址' });
    const appTarget = h('select', { 'aria-label': '快捷动作 App 目标' }, ...nativeAppActions.map((action) => h('option', { value: action.id, selected: value.target === action.id }, action.label)));
    const target = h('div', { className: 'task-action-target' });
    const renderTarget = () => target.replaceChildren(type.value === 'internal' ? internalTarget : type.value === 'external_app' ? appTarget : httpsTarget);
    type.addEventListener('change', () => {
      if (type.value === 'https' && label.value === '打开今天') label.value = '打开网页';
      if (type.value === 'external_app' && (!label.value || ['打开今天', '打开网页'].includes(label.value))) label.value = nativeAppActionLabels[appTarget.value] ?? '打开 App';
      renderTarget();
    }); renderTarget();
    const row = { id, type, label, internalTarget, httpsTarget, appTarget, node: null };
    row.node = h('div', { className: 'task-action-editor-row' }, type, label, target,
      button('移除动作', () => { actionRows.splice(actionRows.indexOf(row), 1); row.node.remove(); }, { className: 'text-button danger-text' }));
    actionRows.push(row); actionList.append(row.node);
  };
  current.actions.forEach(addAction);
  const actionEditor = h('section', { className: 'task-action-editor' }, h('div', { className: 'task-action-editor-heading' }, h('div', {}, h('h3', {}, '快捷动作'),
    h('p', { className: 'muted' }, nativeAppActions.length ? '支持站内页面、HTTPS 和产品白名单中的手机 App；执行失败不会自动完成待办。' : '仅支持站内页面和 HTTPS；手机 App 动作将在业务参数确认后从产品白名单开放。')),
    h('div', { className: 'page-actions' }, button('添加站内动作', () => addAction(), { className: 'button subtle' }),
      button('添加网页动作', () => addAction({ type: 'https', label: '打开网页', target: '' }), { className: 'button subtle' }),
      nativeAppActions.length ? button('添加 App 动作', () => addAction({ type: 'external_app', label: nativeAppActions[0].label, target: nativeAppActions[0].id }), { className: 'button subtle' }) : null)), actionList);
  const error = h('p', { className: 'task-form-error', role: 'alert', hidden: true });
  const dialog = h('dialog', { className: 'confirmation task-dialog' });
  const form = h('form', { method: 'dialog', className: 'task-form', onsubmit: async (event) => {
    event.preventDefault(); error.hidden = true;
    const lines = checklist.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const existing = new Map(current.checklist.map((item) => [item.text, item]));
    let nextRecurrence = null;
    if (recurrence.value === 'daily') nextRecurrence = { frequency: 'daily', interval: Number(recurrenceInterval.value) };
    if (recurrence.value === 'weekly') nextRecurrence = { frequency: 'weekly', interval: Number(recurrenceInterval.value),
      weekdays: [...weekly.querySelectorAll('input:checked')].map((input) => Number(input.value)) };
    if (recurrence.value === 'monthly') nextRecurrence = { frequency: 'monthly', interval: Number(recurrenceInterval.value), dayOfMonth: Number(monthDay.value) };
    const next = {
      ...current, title: title.value, note: note.value,
      dueAt: dueAt.value ? new Date(dueAt.value).toISOString() : null, priority: priority.value,
      recurrence: nextRecurrence,
      reminderMinutesBefore: reminder.value === '' ? null : Number(reminder.value),
      checklist: lines.map((text) => ({ id: existing.get(text)?.id ?? crypto.randomUUID(), text, completed: existing.get(text)?.completed ?? false })),
      actions: actionRows.map((row) => ({ id: row.id, type: row.type.value, label: row.label.value,
        target: row.type.value === 'internal' ? row.internalTarget.value : row.type.value === 'external_app' ? row.appTarget.value : row.httpsTarget.value })),
    };
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try { await save(next); dialog.close(); }
    catch (reason) { error.textContent = reason.message || '保存待办失败'; error.hidden = false; submit.disabled = false; }
  } },
  h('h2', {}, editing ? '编辑待办' : '新建待办'),
  h('label', { className: 'task-field' }, h('span', {}, '标题'), title),
  h('div', { className: 'task-form-grid' },
    h('label', { className: 'task-field' }, h('span', {}, '截止时间'), dueAt),
    h('label', { className: 'task-field' }, h('span', {}, '优先级'), priority),
    h('label', { className: 'task-field' }, h('span', {}, '提醒'), reminder),
    h('label', { className: 'task-field' }, h('span', {}, '重复'), recurrence)),
  recurrenceDetails,
  h('label', { className: 'task-field' }, h('span', {}, '备注'), note),
  h('label', { className: 'task-field' }, h('span', {}, '子项'), checklist),
  actionEditor,
  h('p', { className: 'muted small-note' }, '保存时先写入当前设备；登录账号后再以固定请求同步，断网不会清空。'), error,
  h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), h('button', { type: 'submit', className: 'button primary' }, editing ? '保存修改' : '创建待办')));
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog); dialog.showModal(); title.focus();
}

function dueLabel(task) {
  if (!task.dueAt) return '无截止时间';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(task.dueAt));
}

function recurrenceLabel(recurrence) {
  if (!recurrence) return null;
  if (recurrence.frequency === 'daily') return recurrence.interval === 1 ? '每天重复' : `每 ${recurrence.interval} 天重复`;
  if (recurrence.frequency === 'weekly') {
    const days = (recurrence.weekdays ?? []).map((day) => weekdayLabels[day - 1]).join('、');
    return recurrence.interval === 1 ? `每周${days}重复` : `每 ${recurrence.interval} 周的${days}重复`;
  }
  return recurrence.interval === 1 ? `每月 ${recurrence.dayOfMonth ?? ''} 日重复` : `每 ${recurrence.interval} 个月的 ${recurrence.dayOfMonth ?? ''} 日重复`;
}

export async function tasksPage({ store, sync = null, reminders = null, navigate = () => {}, alive, reportError }) {
  let state = 'open';
  let query = '', priorityFilter = '';
  let syncError = null;
  let reminderState = reminders?.status() ?? null;
  const root = h('div', { className: 'tasks-page' });
  function continueSync() {
    if (!sync) return;
    sync.run().then(async () => { syncError = null; if (reminders) reminderState = await reminders.refresh(); return render(); }).catch((error) => { syncError = error.message; if (alive()) render().catch(reportError); });
  }
  async function changed(operation, { requestPermission = false } = {}) {
    const result = await operation();
    try { if (reminders) reminderState = await reminders.refresh({ requestPermission }); } catch (error) { reportError(error); }
    await render(); continueSync(); return result;
  }
  async function render() {
    const [tasks, summary, conflicts] = await Promise.all([store.listTasks({ state }), sync ? sync.summary() : store.taskSyncSummary(), sync ? sync.conflicts() : []]);
    if (!alive()) return;
    const tabs = h('div', { className: 'task-tabs', role: 'group', 'aria-label': '待办状态' },
      ...Object.entries(stateLabels).map(([value, label]) => button(label, () => { state = value; render().catch(reportError); }, { className: `button${state === value ? ' primary' : ' subtle'}`, 'aria-pressed': state === value })));
    const actions = state === 'open' ? [button('新建待办', () => editor(null, (value) => changed(() => store.saveTask(value), { requestPermission: value.reminderMinutesBefore != null })), { className: 'button primary', glyph: 'plus' })] : [];
    const header = h('header', { className: 'page-header' }, h('div', {}, h('p', { className: 'eyebrow' }, sync ? '先存本机，再同步到账号设备' : '安全保存在当前设备'), h('h1', {}, '待办')), h('div', { className: 'page-actions' }, actions));
    const notice = h('div', { className: 'notice task-sync-notice', role: 'status' }, summary.conflicts ? `${summary.conflicts} 项待办发生跨设备冲突，已停止自动覆盖。`
      : syncError ? `云同步暂不可用：${syncError}。本机修改仍保留。` : sync ? `待上传 ${summary.waiting} 项；企业微信和其他 App 动作将在参数确认后加入。`
        : `${summary.waiting} 项修改仅保存在此设备；登录账号后可跨设备同步。`);
    const reminderNotice = reminderState && ['denied', 'prompt', 'unknown'].includes(reminderState.permission)
      ? h('p', { className: 'notice task-reminder-notice', role: 'status' }, reminderState.permission === 'denied'
        ? '当前设备未授予通知权限；待办会保存，但系统不会弹出提醒。可在系统设置中开启通知。'
        : '待办提醒尚未获得系统通知权限；保存带提醒的待办时会请求一次权限。') : null;
    const search = h('input', { type: 'search', value: query, placeholder: '搜索标题、备注或子项', 'aria-label': '搜索待办', autocomplete: 'off' });
    const prioritySelect = h('select', { 'aria-label': '筛选优先级' }, h('option', { value: '' }, '全部优先级'),
      ...Object.entries(priorityLabels).map(([value, label]) => h('option', { value, selected: priorityFilter === value }, `${label}优先级`)));
    const filters = h('div', { className: 'task-filters' }, search, prioritySelect);
    const conflictSection = conflicts.length ? h('section', { className: 'task-conflicts', 'aria-label': '待办冲突' }, h('h2', {}, '需要选择的待办修改'), ...conflicts.map((conflict) =>
      h('article', { className: 'task-conflict-card' }, h('strong', {}, conflict.local?.title ?? conflict.remote?.title ?? '待办冲突'),
        h('p', {}, `本机：${conflict.local?.note || conflict.local?.title || '已删除'}`), h('p', {}, `云端：${conflict.remote?.note || conflict.remote?.title || '已删除'}`),
        h('div', { className: 'page-actions' }, button('保留本机版本', async () => { try { await sync.resolve(conflict.id, 'local'); await render(); } catch (error) { reportError(error); } }, { className: 'button' }),
          button('保留云端版本', async () => { try { await sync.resolve(conflict.id, 'cloud'); await render(); } catch (error) { reportError(error); } }, { className: 'button subtle' })))) ) : null;
    const list = h('div', { className: 'task-list' });
    const taskCard = (task) => {
      const finished = task.status === 'completed';
      const check = h('button', { type: 'button', className: `task-check${finished ? ' checked' : ''}`, 'aria-label': finished ? `重新打开：${task.title}` : `完成：${task.title}`,
        onclick: async () => { try { await changed(() => store.setTaskStatus(task.id, finished ? 'open' : 'completed', task.localRevision)); } catch (error) { reportError(error); } } }, finished ? icon('check', 18) : '');
      const details = h('div', { className: 'task-details' }, h('h2', {}, task.title),
        task.note && h('p', {}, task.note),
        h('div', { className: 'task-meta' }, h('span', {}, dueLabel(task)), h('span', { className: `task-priority priority-${task.priority}` }, `${priorityLabels[task.priority]}优先级`),
          recurrenceLabel(task.recurrence) && h('span', {}, recurrenceLabel(task.recurrence)),
          task.checklist.length ? h('span', {}, `${task.checklist.filter((item) => item.completed).length}/${task.checklist.length} 子项`) : null),
        task.actions?.length ? h('div', { className: 'task-action-buttons', 'aria-label': `${task.title}的快捷动作` }, ...task.actions.map((action) => button(action.label, async () => {
          const targetLabel = action.type === 'internal' ? internalActionTargets[action.target] : action.type === 'external_app' ? nativeAppActionLabels[action.target] : action.target;
          if (!confirm(`将执行“${action.label}”：${targetLabel ?? '未登记目标'}。是否继续？`)) return;
          if (action.type === 'internal' && internalActionTargets[action.target]) navigate(action.target);
          else if (action.type === 'https') { window.open(action.target, '_blank', 'noopener,noreferrer'); toast('已请求打开网页；如果没有出现，请检查浏览器弹窗设置'); }
          else if (action.type === 'external_app' && nativeAppActionLabels[action.target]) {
            try { await launchNativeAppAction(action.target); toast(`已请求打开“${nativeAppActionLabels[action.target]}”`); }
            catch (error) { toast(error.message); }
          }
          else toast('这个快捷动作尚不受当前版本支持');
        }, { className: 'button subtle' }))) : null);
      const controls = h('div', { className: 'task-controls' });
      if (task.status === 'trash') controls.append(button('恢复', async () => { try { await changed(() => store.setTaskStatus(task.id, 'open', task.localRevision)); } catch (error) { reportError(error); } }, { className: 'button subtle' }));
      else controls.append(button('编辑', () => editor(task, (value) => changed(() => store.saveTask(value, task.localRevision), { requestPermission: value.reminderMinutesBefore != null })), { className: 'button subtle' }),
        button('删除', async () => { try { await changed(() => store.setTaskStatus(task.id, 'trash', task.localRevision)); } catch (error) { reportError(error); } }, { className: 'button subtle' }));
      return h('article', { className: `task-card${finished ? ' completed' : ''}` }, check, details, controls);
    };
    const drawList = () => {
      query = search.value.trim(); priorityFilter = prioritySelect.value;
      const needle = query.toLocaleLowerCase(), visible = tasks.filter((task) => (!priorityFilter || task.priority === priorityFilter)
        && (!needle || [task.title, task.note, ...task.checklist.map((item) => item.text)].some((value) => value.toLocaleLowerCase().includes(needle))));
      list.replaceChildren();
      if (state === 'open' && visible.length) {
        const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const localDay = (value) => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
        const groups = [
          ['逾期', visible.filter((task) => task.dueAt && new Date(task.dueAt) < now)],
          ['今天', visible.filter((task) => task.dueAt && new Date(task.dueAt) >= now && localDay(task.dueAt) === today)],
          ['之后', visible.filter((task) => task.dueAt && localDay(task.dueAt) > today)],
          ['无日期', visible.filter((task) => !task.dueAt)],
        ];
        for (const [label, items] of groups) if (items.length) list.append(h('section', { className: 'task-group', 'aria-label': `${label}待办` }, h('h2', { className: 'task-group-title' }, label), ...items.map(taskCard)));
      } else list.append(...visible.map(taskCard));
      if (!visible.length) list.append(h('div', { className: 'empty-state task-empty' }, h('div', { className: 'empty-icon' }, icon('check', 32)),
        h('h2', {}, tasks.length ? '没有符合筛选的待办' : state === 'open' ? '没有待完成的事情' : `还没有${stateLabels[state]}待办`),
        h('p', {}, tasks.length ? '调整关键词或优先级后再查看。' : state === 'open' ? '把下一件要做的事记下来，日记继续保持安静。' : '切换状态查看其他待办。'),
        !tasks.length && state === 'open' && button('新建第一个待办', () => editor(null, (value) => changed(() => store.saveTask(value), { requestPermission: value.reminderMinutesBefore != null })), { className: 'button primary', glyph: 'plus' })));
    };
    search.addEventListener('input', drawList); prioritySelect.addEventListener('change', drawList); drawList();
    root.replaceChildren(...[header, tabs, notice, reminderNotice, filters, conflictSection, list].filter(Boolean));
  }
  if (sync) { try { await sync.run(); } catch (error) { syncError = error.message; } }
  try { if (reminders) reminderState = await reminders.refresh(); } catch (error) { syncError ??= error.message; }
  await render();
  return root;
}
