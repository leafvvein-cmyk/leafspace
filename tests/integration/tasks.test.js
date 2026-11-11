import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app.js';
import { config as defaults } from '../../apps/api/src/config.js';
import { createPool } from '../../apps/api/src/db.js';
import { migrate } from '../../apps/api/src/migrate.js';

let admin, pool, server, origin;
const databaseName = `diary_tasks_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
const config = { ...defaults, secret: 'task-integration-test-secret-not-for-production', authIpLimit: 10000 };

beforeAll(async () => {
  const url = new URL(defaults.databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329' || !/^diary_tasks_test_[0-9a-f_]+$/.test(databaseName)) throw new Error('Task integration tests require the dedicated loopback PostgreSQL instance.');
  url.pathname = '/postgres';
  admin = createPool(url.href);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  url.pathname = `/${databaseName}`;
  pool = createPool(url.href);
  await migrate(pool);
  const app = createApp({ pool, config, imageStorage: { remove: async () => {} }, exportStorage: { remove: async () => {} } });
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = `http://127.0.0.1:${server.address().port}/api/v1`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await pool?.end();
  if (admin && /^diary_tasks_test_[0-9a-f_]+$/.test(databaseName)) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin?.end();
});

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function register() {
  const response = await request('/auth/native/register', { method: 'POST', body: {
    username: `task_${randomUUID().slice(0, 18)}`, password: 'task-test-password-2026!',
    device: { installationId: randomUUID(), platform: 'android', name: '待办测试设备' },
  } });
  expect(response.status).toBe(201);
  return response.json.data;
}

const taskPayload = (overrides = {}) => ({
  title: '联系项目成员', note: '确认本周安排', dueAt: '2026-09-10T09:00:00+08:00', timezone: 'Asia/Shanghai',
  priority: 'high', recurrence: null, reminderMinutesBefore: 30,
  checklist: [{ id: randomUUID(), text: '整理问题', completed: false }], linkedEntryId: null, ...overrides,
});

describe('task API', () => {
  it('isolates accounts and keeps create/update/action requests idempotent', async () => {
    const owner = await register(), other = await register();
    const taskId = randomUUID(), requestId = randomUUID();
    const created = await request('/tasks', { method: 'POST', token: owner.accessToken, body: { taskId, requestId, payload: taskPayload() } });
    expect(created.status).toBe(201);
    expect(created.json.data.task).toMatchObject({ id: taskId, title: '联系项目成员', revision: '1', status: 'open' });

    const replayed = await request('/tasks', { method: 'POST', token: owner.accessToken, body: { taskId, requestId, payload: taskPayload({ checklist: created.json.data.task.checklist }) } });
    expect(replayed.status).toBe(201);
    expect(replayed.json.data).toMatchObject({ replayed: true, task: { id: taskId, revision: '1' } });
    expect((await request(`/tasks/${taskId}`, { token: other.accessToken })).status).toBe(404);

    const updateId = randomUUID();
    const updated = await request(`/tasks/${taskId}`, { method: 'PATCH', token: owner.accessToken,
      body: { requestId: updateId, baseRevision: '1', patch: { priority: 'urgent', note: '先确认负责人' } } });
    expect(updated.status).toBe(200);
    expect(updated.json.data.task).toMatchObject({ priority: 'urgent', note: '先确认负责人', revision: '2' });
    const stale = await request(`/tasks/${taskId}`, { method: 'PATCH', token: owner.accessToken,
      body: { requestId: randomUUID(), baseRevision: '1', patch: { title: '旧设备修改' } } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('REVISION_CONFLICT');

    const actionBody = { requestId: randomUUID(), baseRevision: '2', actions: [
        { id: randomUUID(), type: 'internal', label: '打开今天', target: '/today' },
        { id: randomUUID(), type: 'https', label: '打开网站', target: 'https://example.com/work' },
      ] };
    const actions = await request(`/tasks/${taskId}/actions`, { method: 'PUT', token: owner.accessToken, body: actionBody });
    expect(actions.status).toBe(200);
    expect(actions.json.data.task.actions).toHaveLength(2);
    expect(actions.json.data.task.revision).toBe('3');
    const actionReplay = await request(`/tasks/${taskId}/actions`, { method: 'PUT', token: owner.accessToken, body: actionBody });
    expect(actionReplay.json.data).toMatchObject({ replayed: true, task: { revision: '3', actions: [{ target: '/today' }, { target: 'https://example.com/work' }] } });
    const unsafe = await request(`/tasks/${taskId}/actions`, { method: 'PUT', token: owner.accessToken, body: {
      requestId: randomUUID(), baseRevision: '3', actions: [{ id: randomUUID(), type: 'https', label: '危险链接', target: 'javascript:alert(1)' }],
    } });
    expect(unsafe.status).toBe(422);
    expect(unsafe.json.error.code).toBe('ACTION_TARGET_INVALID');
    const arbitraryApp = await request(`/tasks/${taskId}/actions`, { method: 'PUT', token: owner.accessToken, body: {
      requestId: randomUUID(), baseRevision: '3', actions: [{ id: randomUUID(), type: 'external_app', label: '任意应用', target: 'user-entered.scheme' }],
    } });
    expect(arbitraryApp.status).toBe(422);
    expect(arbitraryApp.json.error.code).toBe('ACTION_TARGET_INVALID');
  });

  it('completes a recurring task once and creates exactly one next occurrence', async () => {
    const account = await register(), taskId = randomUUID();
    const created = await request('/tasks', { method: 'POST', token: account.accessToken, body: {
      taskId, requestId: randomUUID(), payload: taskPayload({ recurrence: { frequency: 'weekly', interval: 1 } }),
    } });
    const actionId = randomUUID();
    const withAction = await request(`/tasks/${taskId}/actions`, { method: 'PUT', token: account.accessToken, body: {
      requestId: randomUUID(), baseRevision: created.json.data.task.revision, actions: [{ id: actionId, type: 'internal', label: '查看时间线', target: '/timeline' }],
    } });
    const requestId = randomUUID();
    const completed = await request(`/tasks/${taskId}/complete`, { method: 'POST', token: account.accessToken,
      body: { requestId, baseRevision: withAction.json.data.task.revision } });
    expect(completed.status).toBe(200);
    expect(completed.json.data.task.status).toBe('completed');
    expect(completed.json.data.nextTask).toMatchObject({ status: 'open', dueAt: '2026-09-17T01:00:00.000Z' });
    expect(completed.json.data.nextTask.checklist[0].completed).toBe(false);
    expect(completed.json.data.nextTask.actions).toMatchObject([{ type: 'internal', label: '查看时间线', target: '/timeline' }]);

    const replay = await request(`/tasks/${taskId}/complete`, { method: 'POST', token: account.accessToken,
      body: { requestId, baseRevision: withAction.json.data.task.revision } });
    expect(replay.status).toBe(200);
    expect(replay.json.data).toMatchObject({ replayed: true, nextTask: { id: completed.json.data.nextTask.id } });
    const list = await request('/tasks?state=open', { token: account.accessToken });
    expect(list.json.data.items.map((item) => item.id)).toEqual([completed.json.data.nextTask.id]);
    expect((await pool.query('SELECT count(*)::int AS count FROM tasks WHERE user_id=$1', [account.user.id])).rows[0].count).toBe(2);
  });

  it('generates selected-weekday and month-end occurrences in the task timezone', async () => {
    const account = await register();
    const weeklyId = randomUUID(), weekly = await request('/tasks', { method: 'POST', token: account.accessToken, body: {
      taskId: weeklyId, requestId: randomUUID(), payload: taskPayload({ dueAt: '2026-09-09T01:00:00.000Z', recurrence: { frequency: 'weekly', interval: 2, weekdays: [1, 3, 5] } }),
    } });
    const weeklyDone = await request(`/tasks/${weeklyId}/complete`, { method: 'POST', token: account.accessToken,
      body: { requestId: randomUUID(), baseRevision: weekly.json.data.task.revision } });
    expect(weeklyDone.json.data.nextTask).toMatchObject({ dueAt: '2026-09-11T01:00:00.000Z', recurrence: { frequency: 'weekly', interval: 2, weekdays: [1, 3, 5] } });

    const monthlyId = randomUUID(), monthly = await request('/tasks', { method: 'POST', token: account.accessToken, body: {
      taskId: monthlyId, requestId: randomUUID(), payload: taskPayload({ dueAt: '2026-01-31T01:00:00.000Z', recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 31 } }),
    } });
    const monthlyDone = await request(`/tasks/${monthlyId}/complete`, { method: 'POST', token: account.accessToken,
      body: { requestId: randomUUID(), baseRevision: monthly.json.data.task.revision } });
    expect(monthlyDone.json.data.nextTask).toMatchObject({ dueAt: '2026-02-28T01:00:00.000Z', recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 31 } });
  });

  it('validates recurrence and supports soft delete plus restore', async () => {
    const account = await register();
    const invalid = await request('/tasks', { method: 'POST', token: account.accessToken, body: {
      taskId: randomUUID(), requestId: randomUUID(), payload: taskPayload({ dueAt: null, recurrence: { frequency: 'daily', interval: 1 } }),
    } });
    expect(invalid.status).toBe(422);
    expect(invalid.json.error.code).toBe('VALIDATION_FAILED');

    const taskId = randomUUID();
    const created = await request('/tasks', { method: 'POST', token: account.accessToken,
      body: { taskId, requestId: randomUUID(), payload: taskPayload() } });
    const removed = await request(`/tasks/${taskId}?baseRevision=1`, { method: 'DELETE', token: account.accessToken,
      headers: { 'Idempotency-Key': randomUUID() } });
    expect(removed.status).toBe(200);
    expect(removed.json.data.task.status).toBe('trash');
    const restored = await request(`/tasks/${taskId}/restore`, { method: 'POST', token: account.accessToken,
      body: { requestId: randomUUID(), baseRevision: removed.json.data.task.revision } });
    expect(restored.status).toBe(200);
    expect(restored.json.data.task).toMatchObject({ status: 'open', deletedAt: null });
    expect(created.json.data.task.id).toBe(restored.json.data.task.id);
  });

  it('paginates tasks with an account-bound signed cursor and advertises only executable action types', async () => {
    const account = await register(), other = await register();
    const fixtures = [
      ['较晚任务', '2026-09-12T01:00:00.000Z'],
      ['较早任务', '2026-09-11T01:00:00.000Z'],
      ['无日期任务', null],
    ];
    for (const [title, dueAt] of fixtures) {
      const created = await request('/tasks', { method: 'POST', token: account.accessToken,
        body: { taskId: randomUUID(), requestId: randomUUID(), payload: taskPayload({ title, dueAt, reminderMinutesBefore: null }) } });
      expect(created.status).toBe(201);
    }
    const first = await request('/tasks?state=open&limit=2', { token: account.accessToken });
    expect(first.status).toBe(200);
    expect(first.json.data.items.map((item) => item.title)).toEqual(['较早任务', '较晚任务']);
    expect(first.json.data).toMatchObject({ hasMore: true });
    expect(typeof first.json.data.nextCursor).toBe('string');
    const second = await request(`/tasks?state=open&limit=2&cursor=${encodeURIComponent(first.json.data.nextCursor)}`, { token: account.accessToken });
    expect(second.status).toBe(200);
    expect(second.json.data.items.map((item) => item.title)).toEqual(['无日期任务']);
    expect(second.json.data).toMatchObject({ hasMore: false, nextCursor: null });
    const tampered = `${first.json.data.nextCursor.slice(0, -1)}x`;
    expect((await request(`/tasks?state=open&limit=2&cursor=${encodeURIComponent(tampered)}`, { token: account.accessToken })).json.error.code).toBe('CURSOR_INVALID');
    expect((await request(`/tasks?state=open&limit=2&cursor=${encodeURIComponent(first.json.data.nextCursor)}`, { token: other.accessToken })).json.error.code).toBe('CURSOR_INVALID');
    const types = await request('/task-action-types', { token: account.accessToken });
    expect(types.json.data).toEqual({ items: [
      { type: 'internal', targets: ['/today', '/tasks', '/timeline', '/calendar'] },
      { type: 'https', scheme: 'https' },
    ], externalApps: [] });
  });
});
