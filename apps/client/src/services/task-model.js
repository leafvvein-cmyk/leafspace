import { normalizeTaskRecurrence } from '@diary/contracts/task-recurrence';
import { isConfiguredNativeAppAction } from '@diary/contracts/app-actions';

const priorities = new Set(['low', 'normal', 'high', 'urgent']);
const statuses = new Set(['open', 'completed', 'trash']);
const internalTargets = new Set(['/today', '/tasks', '/timeline', '/calendar']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) throw new Error(`${label}无效`);
  return new Date(value).toISOString();
}

function timezone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error('待办时区无效');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { throw new Error('待办时区无效'); }
  return value;
}

export function validateTask(input) {
  if (!input || typeof input !== 'object') throw new Error('待办内容无效');
  const title = String(input.title ?? '').trim();
  if (!title || [...title].length > 200) throw new Error('待办标题应为 1–200 个字符');
  const note = String(input.note ?? '');
  if ([...note].length > 5000) throw new Error('待办备注不能超过 5000 个字符');
  if (!priorities.has(input.priority ?? 'normal')) throw new Error('待办优先级无效');
  if (!statuses.has(input.status ?? 'open')) throw new Error('待办状态无效');
  const checklist = input.checklist ?? [];
  if (!Array.isArray(checklist) || checklist.length > 100) throw new Error('待办子项不能超过 100 项');
  const seen = new Set();
  for (const item of checklist) {
    if (typeof item?.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('待办子项编号无效或重复');
    seen.add(item.id);
    if (!String(item.text ?? '').trim() || [...String(item.text)].length > 500 || typeof item.completed !== 'boolean') throw new Error('待办子项内容无效');
  }
  const actions = input.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 20) throw new Error('待办快捷动作不能超过 20 项');
  const actionIds = new Set();
  for (const action of actions) {
    if (!uuid.test(action?.id) || actionIds.has(action.id) || !['internal', 'https', 'external_app'].includes(action.type)) throw new Error('待办快捷动作无效或重复');
    actionIds.add(action.id);
    if (typeof action.label !== 'string' || !action.label.trim() || [...action.label.trim()].length > 80) throw new Error('待办快捷动作名称无效');
    if (typeof action.target !== 'string' || !action.target || action.target.length > 2048) throw new Error('待办快捷动作目标无效');
    if (action.type === 'internal' && !internalTargets.has(action.target)) throw new Error('站内快捷动作目标无效');
    if (action.type === 'https') { try { if (new URL(action.target).protocol !== 'https:') throw new Error(); } catch { throw new Error('网页快捷动作必须使用有效的 HTTPS 地址'); } }
    if (action.type === 'external_app' && !isConfiguredNativeAppAction(action.target)) throw new Error('原生 App 动作目标不在产品白名单');
  }
  if (input.reminderMinutesBefore != null && (!Number.isInteger(input.reminderMinutesBefore) || input.reminderMinutesBefore < 0 || input.reminderMinutesBefore > 40320)) throw new Error('待办提醒时间无效');
  const dueAt = iso(input.dueAt, '待办截止时间', { nullable: true });
  const normalizedTimezone = timezone(input.timezone ?? 'Asia/Shanghai');
  const recurrence = normalizeTaskRecurrence(input.recurrence ?? null, dueAt, normalizedTimezone);
  return {
    ...structuredClone(input), title, note, dueAt, timezone: normalizedTimezone,
    priority: input.priority ?? 'normal', recurrence,
    reminderMinutesBefore: input.reminderMinutesBefore ?? null, checklist: structuredClone(checklist),
    actions: actions.map((action) => ({ id: action.id, type: action.type, label: action.label.trim(), target: action.target })),
    linkedEntryId: input.linkedEntryId ?? null, status: input.status ?? 'open',
  };
}

export function newTask(input = {}) {
  const stamp = new Date().toISOString();
  return validateTask({
    id: crypto.randomUUID(), seriesId: null, title: '', note: '', dueAt: null, timezone: 'Asia/Shanghai', priority: 'normal',
    recurrence: null, reminderMinutesBefore: null, checklist: [], actions: [], linkedEntryId: null, status: 'open', revision: '0', localRevision: 0,
    createdAt: stamp, updatedAt: stamp, completedAt: null, deletedAt: null, ...input,
  });
}

export function taskSort(a, b) {
  if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  if (a.dueAt) return -1;
  if (b.dueAt) return 1;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
