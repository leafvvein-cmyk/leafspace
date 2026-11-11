import { describe, expect, it, vi } from 'vitest';
import { createReminderService, fixedOccurrences, fixedTime, normalizeReminder } from '../../apps/client/src/services/device-reminders.js';

function metadata() {
  const values = new Map();
  return { values, getSetting: vi.fn(async (key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback)),
    setSetting: vi.fn(async (key, value) => values.set(key, structuredClone(value))) };
}

function nativePlugin(permission = 'granted') {
  let state = permission;
  return { checkPermissions: vi.fn(async () => ({ display: state })), requestPermissions: vi.fn(async () => ({ display: state })),
    cancel: vi.fn(async () => {}), schedule: vi.fn(async () => ({})), createChannel: vi.fn(async () => {}),
    addListener: vi.fn(async (_name, listener) => ({ remove: vi.fn(async () => {}), listener })), setPermission(value) { state = value; } };
}

describe('device reminders', () => {
  it('normalizes the device-only contract without accepting invalid days or timezones', () => {
    expect(normalizeReminder({ enabled: true, time: '99:80', days: [1, 1, 0, 8], timezonePolicy: 'other', timezone: 'invalid/zone' }))
      .toEqual({ enabled: true, time: '21:00', days: [1], timezonePolicy: 'device', timezone: expect.any(String) });
    expect(normalizeReminder({ days: [] }).days).toEqual([]);
  });
  it('converts a fixed wall-clock reminder and produces only future selected weekdays', () => {
    expect(fixedTime('2026-09-08', '21:00', 'Asia/Shanghai').toISOString()).toBe('2026-09-08T13:00:00.000Z');
    const occurrences = fixedOccurrences({ time: '21:00', timezone: 'Asia/Shanghai', days: [2] }, new Date('2026-09-08T12:00:00Z'));
    expect(occurrences[0].toISOString()).toBe('2026-09-08T13:00:00.000Z');
    expect(occurrences).toHaveLength(4);
  });
  it('shows a foreground Web reminder once per local diary date without requesting browser permission', async () => {
    const store = metadata(), notify = vi.fn();
    store.values.set('device-reminder', { enabled: true, time: '20:00', days: [2], timezonePolicy: 'fixed', timezone: 'Asia/Shanghai' });
    const service = createReminderService({ metadata: store, native: false, now: () => new Date('2026-09-08T13:30:00Z'), notify,
      setTimer: vi.fn(() => 7), clearTimer: vi.fn() });
    await service.start(); await service.refresh();
    expect(notify).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledWith('给今天留一句话');
    expect(await service.permission()).toBe('foreground-only');
  });
  it('does not schedule or repeatedly request when native permission is denied', async () => {
    const store = metadata(), plugin = nativePlugin('denied');
    const service = createReminderService({ metadata: store, native: true, platform: 'android', loadPlugin: async () => plugin, requirePlugin: vi.fn() });
    const result = await service.save({ enabled: true, time: '21:00', days: [1], timezonePolicy: 'device', timezone: 'Asia/Shanghai' }, { requestPermission: true });
    expect(result.settings.enabled).toBe(false); expect(plugin.requestPermissions).not.toHaveBeenCalled(); expect(plugin.schedule).not.toHaveBeenCalled();
    expect(plugin.cancel).toHaveBeenCalledTimes(1);
  });
  it('asks a prompt permission once and schedules content-free weekly native reminders', async () => {
    const store = metadata(), plugin = nativePlugin('prompt');
    plugin.requestPermissions.mockImplementation(async () => { plugin.setPermission('granted'); return { display: 'granted' }; });
    const service = createReminderService({ metadata: store, native: true, platform: 'android', loadPlugin: async () => plugin, requirePlugin: vi.fn() });
    const result = await service.save({ enabled: true, time: '07:25', days: [1, 7], timezonePolicy: 'device', timezone: 'Asia/Shanghai' }, { requestPermission: true });
    expect(result.settings.enabled).toBe(true); expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    const notifications = plugin.schedule.mock.calls[0][0].notifications;
    expect(notifications.map((item) => item.schedule.on.weekday)).toEqual([2, 1]);
    expect(JSON.stringify(notifications)).not.toMatch(/正文|标题|password|token/i);
    expect(new Set(notifications.map((item) => item.body))).toEqual(new Set(['给今天留一句话']));
  });
  it('uses bounded absolute schedules for a fixed zone and opens today only for its own action', async () => {
    const store = metadata(), plugin = nativePlugin('granted'), openToday = vi.fn();
    const service = createReminderService({ metadata: store, native: true, platform: 'ios', loadPlugin: async () => plugin, requirePlugin: vi.fn(),
      now: () => new Date('2026-09-08T12:00:00Z'), openToday });
    await service.save({ enabled: true, time: '21:00', days: [2], timezonePolicy: 'fixed', timezone: 'Asia/Shanghai' });
    const scheduled = plugin.schedule.mock.calls[0][0].notifications;
    expect(scheduled).toHaveLength(4); expect(scheduled[0].schedule.at.toISOString()).toBe('2026-09-08T13:00:00.000Z');
    await service.start();
    const listener = plugin.addListener.mock.calls[0][1];
    listener({ notification: { extra: { kind: 'other', route: '/today' } } }); expect(openToday).not.toHaveBeenCalled();
    listener({ notification: { extra: { kind: 'diary-reminder', route: '/today' } } }); expect(openToday).toHaveBeenCalledTimes(1);
  });
});
