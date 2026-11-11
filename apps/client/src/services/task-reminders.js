import { isNative as nativePlatform, platform as currentPlatform, requireNativePlugin } from './platform.js';

const CHANNEL = 'task-reminders';
const MAX_NATIVE_REMINDERS = 50;
const MAX_MISSED_MS = 24 * 60 * 60 * 1000;

export function taskReminderAt(task) {
  if (task?.status !== 'open' || !task.dueAt || !Number.isInteger(task.reminderMinutesBefore)) return null;
  const value = new Date(task.dueAt).getTime() - task.reminderMinutesBefore * 60000;
  return Number.isFinite(value) ? new Date(value) : null;
}

function notificationId(taskId, used) {
  let hash = 2166136261;
  for (const character of taskId) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  let id = 100000 + (hash >>> 0) % 1900000000;
  while (used.has(id)) id = id >= 1900099999 ? 100000 : id + 1;
  used.add(id); return id;
}

export function createTaskReminderService({ store, native = nativePlatform, platform = currentPlatform,
  loadPlugin = async () => (await import('@capacitor/local-notifications')).LocalNotifications, requirePlugin = requireNativePlugin,
  now = () => new Date(), setTimer = setInterval, clearTimer = clearInterval, notify = () => {}, openTasks = () => {} } = {}) {
  let timer, actionHandle, started = false, refreshChain = Promise.resolve(), lastState = { permission: native ? 'unknown' : 'foreground-only', scheduled: 0 };
  const serialized = (operation) => {
    const result = refreshChain.then(operation); refreshChain = result.catch(() => {}); return result;
  };
  const plugin = async () => { if (!native) return null; requirePlugin('LocalNotifications'); return loadPlugin(); };
  async function candidateTasks() {
    const current = now().getTime();
    return (await store.listTasks({ state: 'open' })).map((task) => ({ task, at: taskReminderAt(task) })).filter(({ at }) => at && at.getTime() > current + 1000)
      .sort((a, b) => a.at - b.at || a.task.id.localeCompare(b.task.id)).slice(0, MAX_NATIVE_REMINDERS);
  }
  async function performForeground() {
    if (native) return { permission: await permission(), scheduled: 0 };
    const current = now().getTime(), fired = await store.getSetting('task-reminders-fired', {}), nextFired = {};
    for (const task of await store.listTasks({ state: 'open' })) {
      const at = taskReminderAt(task); if (!at) continue;
      const stamp = at.toISOString();
      if (at.getTime() <= current && current - at.getTime() <= MAX_MISSED_MS && fired[task.id] !== stamp) notify('有一项待办需要处理');
      if (at.getTime() > current - MAX_MISSED_MS && (fired[task.id] === stamp || at.getTime() <= current)) nextFired[task.id] = stamp;
    }
    await store.setSetting('task-reminders-fired', nextFired);
    lastState = { permission: 'foreground-only', scheduled: 0 }; return lastState;
  }
  async function permission() {
    if (!native) return 'foreground-only';
    return (await (await plugin()).checkPermissions()).display;
  }
  function checkForeground() { return serialized(performForeground); }
  function refresh({ requestPermission = false } = {}) {
    if (!native) return checkForeground();
    return serialized(async () => {
    const localNotifications = await plugin();
    let state = (await localNotifications.checkPermissions()).display;
    if (requestPermission && state === 'prompt') state = (await localNotifications.requestPermissions()).display;
    const previous = await store.getSetting('task-reminder-native-ids', []);
    if (previous.length) await localNotifications.cancel({ notifications: previous.map((id) => ({ id })) });
    if (state !== 'granted') { await store.setSetting('task-reminder-native-ids', []); lastState = { permission: state, scheduled: 0 }; return lastState; }
    if (platform === 'android') await localNotifications.createChannel({ id: CHANNEL, name: '待办提醒', description: '在你设置的时间提醒待办', importance: 3, visibility: 0 });
    const used = new Set(), notifications = (await candidateTasks()).map(({ task, at }) => ({ id: notificationId(task.id, used), title: '待办',
      body: '有一项待办需要处理', schedule: { at, allowWhileIdle: true }, extra: { route: '/tasks', kind: 'task-reminder', taskId: task.id },
      ...(platform === 'android' ? { channelId: CHANNEL } : {}) }));
    if (notifications.length) await localNotifications.schedule({ notifications });
    await store.setSetting('task-reminder-native-ids', notifications.map(({ id }) => id));
    lastState = { permission: state, scheduled: notifications.length }; return lastState;
    });
  }
  async function start() {
    if (started) return; started = true;
    if (native) {
      const localNotifications = await plugin();
      actionHandle = await localNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
        if (notification?.extra?.kind === 'task-reminder' && notification.extra.route === '/tasks') openTasks(notification.extra.taskId);
      });
      await refresh();
    } else { await checkForeground(); timer = setTimer(() => checkForeground().catch(() => {}), 30000); }
  }
  async function destroy() { started = false; if (timer) clearTimer(timer); timer = undefined; await refreshChain; await actionHandle?.remove(); actionHandle = undefined; }
  return { permission, refresh, start, destroy, checkForeground, status: () => ({ ...lastState }) };
}
