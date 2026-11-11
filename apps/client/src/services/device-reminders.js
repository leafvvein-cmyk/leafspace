import { isNative as nativePlatform, platform as currentPlatform, requireNativePlugin } from './platform.js';

const RECURRING_IDS = Array.from({ length: 7 }, (_, index) => 9201 + index);
const FIXED_IDS = Array.from({ length: 35 }, (_, index) => 9301 + index);
const TEST_ID = 9399;
const allIds = [...RECURRING_IDS, ...FIXED_IDS, TEST_ID].map((id) => ({ id }));
export const DEFAULT_REMINDER = Object.freeze({ enabled: false, time: '21:00', days: [1, 2, 3, 4, 5, 6, 7], timezonePolicy: 'device', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

export function normalizeReminder(value = {}) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time ?? '') ? value.time : DEFAULT_REMINDER.time;
  const days = [...new Set(Array.isArray(value.days) ? value.days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7) : DEFAULT_REMINDER.days)].sort();
  const timezonePolicy = value.timezonePolicy === 'fixed' ? 'fixed' : 'device';
  let timezone = typeof value.timezone === 'string' ? value.timezone : DEFAULT_REMINDER.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = DEFAULT_REMINDER.timezone; }
  return { enabled: Boolean(value.enabled), time, days, timezonePolicy, timezone };
}

function parts(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[values.weekday];
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), weekday,
    date: `${values.year}-${values.month}-${values.day}` };
}

export function fixedTime(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = parts(new Date(instant), timezone);
    instant += target - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  }
  const final = parts(new Date(instant), timezone);
  if (final.year !== year || final.month !== month || final.day !== day || final.hour !== hour || final.minute !== minute) return null;
  return new Date(instant);
}

export function fixedOccurrences(settings, now = new Date()) {
  const local = parts(now, settings.timezone), base = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const results = [];
  for (let offset = 0; offset < 28 && results.length < 28; offset++) {
    const day = new Date(base); day.setUTCDate(day.getUTCDate() + offset);
    const iso = day.getUTCDay() || 7;
    if (!settings.days.includes(iso)) continue;
    const date = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
    const instant = fixedTime(date, settings.time, settings.timezone);
    if (instant && instant.getTime() > now.getTime() + 1000) results.push(instant);
  }
  return results;
}

export function createReminderService({ metadata, native = nativePlatform, platform = currentPlatform,
  loadPlugin = async () => (await import('@capacitor/local-notifications')).LocalNotifications,
  requirePlugin = requireNativePlugin,
  now = () => new Date(), setTimer = setInterval, clearTimer = clearInterval, notify = () => {}, openToday = () => {} } = {}) {
  let timer, actionHandle, started = false;
  const plugin = async () => {
    if (!native) return null;
    requirePlugin('LocalNotifications');
    return loadPlugin();
  };
  const load = async () => normalizeReminder(await metadata.getSetting('device-reminder', DEFAULT_REMINDER));
  async function permission() {
    if (!native) return 'foreground-only';
    return (await (await plugin()).checkPermissions()).display;
  }
  async function cancelScheduled(localNotifications) { await localNotifications.cancel({ notifications: allIds }); }
  async function schedule(settings, localNotifications) {
    await cancelScheduled(localNotifications);
    if (platform === 'android') await localNotifications.createChannel({ id: 'diary-reminders', name: '写作提醒', description: '每天提醒为日记留一句话', importance: 3, visibility: 0 });
    const [hour, minute] = settings.time.split(':').map(Number);
    const notifications = settings.timezonePolicy === 'fixed'
      ? fixedOccurrences(settings, now()).map((at, index) => ({ id: FIXED_IDS[index], title: '日记', body: '给今天留一句话', schedule: { at, allowWhileIdle: true }, extra: { route: '/today', kind: 'diary-reminder' }, ...(platform === 'android' ? { channelId: 'diary-reminders' } : {}) }))
      : settings.days.map((day) => ({ id: RECURRING_IDS[day - 1], title: '日记', body: '给今天留一句话', schedule: { on: { weekday: day === 7 ? 1 : day + 1, hour, minute }, allowWhileIdle: true }, extra: { route: '/today', kind: 'diary-reminder' }, ...(platform === 'android' ? { channelId: 'diary-reminders' } : {}) }));
    if (notifications.length) await localNotifications.schedule({ notifications });
  }
  async function save(value, { requestPermission = false } = {}) {
    let settings = normalizeReminder(value);
    if (settings.enabled && !settings.days.length) throw new Error('请至少选择一天');
    if (native) {
      const localNotifications = await plugin();
      let state = (await localNotifications.checkPermissions()).display;
      if (settings.enabled && state === 'prompt' && requestPermission) state = (await localNotifications.requestPermissions()).display;
      if (settings.enabled && state !== 'granted') settings = { ...settings, enabled: false };
      if (settings.enabled) await schedule(settings, localNotifications); else await cancelScheduled(localNotifications);
      await metadata.setSetting('device-reminder-permission', state);
    }
    await metadata.setSetting('device-reminder', settings);
    return { settings, permission: await permission() };
  }
  async function checkForeground() {
    if (native) return;
    const settings = await load(); if (!settings.enabled) return;
    const timezone = settings.timezonePolicy === 'fixed' ? settings.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const current = parts(now(), timezone);
    if (!settings.days.includes(current.weekday) || `${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}` < settings.time) return;
    const key = `device-reminder-last:${settings.timezonePolicy}:${timezone}`;
    if (await metadata.getSetting(key, null) === current.date) return;
    await metadata.setSetting(key, current.date); notify('给今天留一句话');
  }
  async function refresh() {
    const settings = await load();
    if (!settings.enabled) return checkForeground();
    if (!native) return checkForeground();
    const localNotifications = await plugin();
    if ((await localNotifications.checkPermissions()).display === 'granted') await schedule(settings, localNotifications);
  }
  async function test() {
    if (!native) { notify('给今天留一句话'); return { delivered: 'foreground' }; }
    const localNotifications = await plugin();
    if ((await localNotifications.checkPermissions()).display !== 'granted') throw new Error('通知权限尚未开启，请先保存并允许提醒。');
    await localNotifications.cancel({ notifications: [{ id: TEST_ID }] });
    await localNotifications.schedule({ notifications: [{ id: TEST_ID, title: '日记', body: '给今天留一句话', schedule: { at: new Date(now().getTime() + 5000) }, extra: { route: '/today', kind: 'diary-reminder' }, ...(platform === 'android' ? { channelId: 'diary-reminders' } : {}) }] });
    return { delivered: 'scheduled' };
  }
  async function start() {
    if (started) return; started = true;
    if (native) {
      const localNotifications = await plugin();
      actionHandle = await localNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
        if (notification?.extra?.kind === 'diary-reminder' && notification.extra.route === '/today') openToday();
      });
      await refresh();
    } else { await checkForeground(); timer = setTimer(() => checkForeground().catch(() => {}), 30000); }
  }
  async function destroy() { started = false; if (timer) clearTimer(timer); timer = undefined; await actionHandle?.remove(); actionHandle = undefined; }
  return { load, permission, save, refresh, test, start, destroy };
}
