import { describe, expect, it, vi } from 'vitest';
import { createTaskReminderService, taskReminderAt } from '../../apps/client/src/services/task-reminders.js';

const task = (overrides = {}) => ({ id: crypto.randomUUID(), title: '绝密任务标题', status: 'open', dueAt: '2026-09-09T10:00:00.000Z',
  reminderMinutesBefore: 30, ...overrides });

function store(tasks = []) {
  const values = new Map();
  return { tasks, values, listTasks: async () => tasks, getSetting: async (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
    setSetting: async (key, value) => values.set(key, structuredClone(value)) };
}

describe('per-task reminder scheduling', () => {
  it('derives an instant only for open tasks with an enabled reminder', () => {
    expect(taskReminderAt(task()).toISOString()).toBe('2026-09-09T09:30:00.000Z');
    expect(taskReminderAt(task({ status: 'completed' }))).toBeNull();
    expect(taskReminderAt(task({ reminderMinutesBefore: null }))).toBeNull();
  });

  it('delivers a generic foreground reminder once for each task and schedule', async () => {
    const repository = store([task()]), notify = vi.fn();
    const service = createTaskReminderService({ store: repository, native: false, now: () => new Date('2026-09-09T09:45:00.000Z'), notify,
      setTimer: () => 1, clearTimer: () => {} });
    await service.checkForeground(); await service.checkForeground();
    expect(notify).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledWith('有一项待办需要处理');
    expect(JSON.stringify([...repository.values])).not.toContain('绝密任务标题');
    repository.tasks[0].dueAt = '2026-09-09T11:00:00.000Z';
    await service.checkForeground(); expect(notify).toHaveBeenCalledOnce();
  });

  it('does not request native permission until the user explicitly saves a reminder', async () => {
    const repository = store([task({ dueAt: '2026-09-09T12:00:00.000Z' })]), listener = vi.fn(), requestPermissions = vi.fn(async () => ({ display: 'granted' }));
    const plugin = { checkPermissions: vi.fn(async () => ({ display: 'prompt' })), requestPermissions, cancel: vi.fn(async () => {}), schedule: vi.fn(async () => {}),
      createChannel: vi.fn(async () => {}), addListener: vi.fn(async (_name, callback) => { listener.mockImplementation(callback); return { remove: vi.fn() }; }) };
    const service = createTaskReminderService({ store: repository, native: true, platform: 'android', loadPlugin: async () => plugin, requirePlugin: () => {},
      now: () => new Date('2026-09-09T09:00:00.000Z') });
    await service.start(); expect(requestPermissions).not.toHaveBeenCalled(); expect(plugin.schedule).not.toHaveBeenCalled();
    await service.refresh({ requestPermission: true }); expect(requestPermissions).toHaveBeenCalledOnce(); expect(plugin.schedule).toHaveBeenCalledOnce();
    const scheduled = plugin.schedule.mock.calls[0][0].notifications[0];
    expect(scheduled).toMatchObject({ title: '待办', body: '有一项待办需要处理', extra: { kind: 'task-reminder', route: '/tasks' }, channelId: 'task-reminders' });
    expect(JSON.stringify(scheduled)).not.toContain('绝密任务标题'); await service.destroy();
  });

  it('cancels stale notification ids and limits the native queue to fifty unique entries', async () => {
    const tasks = Array.from({ length: 60 }, (_, index) => task({ dueAt: new Date(Date.parse('2026-09-10T10:00:00Z') + index * 60000).toISOString() }));
    const repository = store(tasks); repository.values.set('task-reminder-native-ids', [123, 456]);
    const plugin = { checkPermissions: vi.fn(async () => ({ display: 'granted' })), cancel: vi.fn(async () => {}), schedule: vi.fn(async () => {}),
      createChannel: vi.fn(async () => {}), addListener: vi.fn(async () => ({ remove: vi.fn() })) };
    const service = createTaskReminderService({ store: repository, native: true, platform: 'ios', loadPlugin: async () => plugin, requirePlugin: () => {},
      now: () => new Date('2026-09-09T09:00:00Z') });
    await service.refresh();
    expect(plugin.cancel).toHaveBeenCalledWith({ notifications: [{ id: 123 }, { id: 456 }] });
    const scheduled = plugin.schedule.mock.calls[0][0].notifications;
    expect(scheduled).toHaveLength(50); expect(new Set(scheduled.map(({ id }) => id)).size).toBe(50);
    expect(repository.values.get('task-reminder-native-ids')).toHaveLength(50);
  });
});
