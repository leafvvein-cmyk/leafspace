import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { createSqliteStore, SQLITE_SCHEMA_VERSION } from '../../apps/client/src/services/sqlite-store.js';

const cleanup = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

function input(overrides = {}) {
  const stamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(), seriesId: null, title: '准备会议资料', note: '', dueAt: '2026-09-10T01:00:00.000Z',
    timezone: 'Asia/Shanghai', priority: 'high', recurrence: null, reminderMinutesBefore: 30,
    checklist: [{ id: crypto.randomUUID(), text: '整理问题', completed: false }], linkedEntryId: null,
    status: 'open', revision: '0', localRevision: 0, createdAt: stamp, updatedAt: stamp, completedAt: null, deletedAt: null,
    ...overrides,
  };
}

function sqliteBridge() {
  const db = new DatabaseSync(':memory:');
  let active = false;
  const connection = {
    raw: db,
    query: async (sql, values = []) => ({ values: db.prepare(sql).all(...values) }),
    execute: async (sql) => { db.exec(sql); return { changes: { changes: 0 } }; },
    run: async (sql, values = []) => { const result = db.prepare(sql).run(...values); return { changes: { changes: Number(result.changes) } }; },
    beginTransaction: async () => { db.exec('BEGIN IMMEDIATE'); active = true; },
    commitTransaction: async () => { db.exec('COMMIT'); active = false; },
    rollbackTransaction: async () => { db.exec('ROLLBACK'); active = false; },
    isTransactionActive: async () => ({ result: active }),
    close: async () => db.close(),
  };
  cleanup.push(() => connection.close());
  return connection;
}

async function verifyStore(store) {
  const first = await store.saveTask(input());
  expect(first).toMatchObject({ localRevision: 1, status: 'open', seriesId: first.id });
  expect(await store.taskUploadCount()).toBe(1);
  const second = await store.saveTask({ ...first, note: '加入最新议程' }, first.localRevision);
  expect(second).toMatchObject({ note: '加入最新议程', localRevision: 2 });
  await expect(store.saveTask({ ...first, title: '旧窗口内容' }, first.localRevision)).rejects.toThrow('另一个窗口');
  const completed = await store.setTaskStatus(first.id, 'completed', second.localRevision);
  expect(completed).toMatchObject({ status: 'completed', localRevision: 3 });
  expect(completed.completedAt).toMatch(/^\d{4}-/);
  expect(await store.listTasks({ state: 'open' })).toEqual([]);
  expect((await store.listTasks({ state: 'completed' }))[0].id).toBe(first.id);
  const reopened = await store.setTaskStatus(first.id, 'open', completed.localRevision);
  expect(reopened).toMatchObject({ status: 'open', completedAt: null, localRevision: 4 });
  expect((await store.getTask(first.id)).title).toBe('准备会议资料');
  const backup = await store.exportLocal();
  expect(backup).toMatchObject({ exportSchemaVersion: 3, tasks: [{ id: first.id, localRevision: 4 }], taskOutbox: [{ taskId: first.id, status: 'local-only' }] });
}

async function verifyTaskSyncQueue(store) {
  const first = await store.saveTask(input());
  const pending = await store.nextTaskSyncJob();
  expect(pending).toMatchObject({ id: `pending-task:${first.id}`, taskId: first.id, status: 'pending', localRevision: 1, payload: { revision: '0' } });
  expect(Object.keys(pending.requestIds).sort()).toEqual(['actions','create','restore','state','update']);
  const newer = await store.saveTask({ ...first, note: '上传过程中继续编辑' }, first.localRevision);
  expect((await store.nextTaskSyncJob()).payload.note).toBe('');
  const remote = { ...first, revision: '1', localRevision: undefined, updatedAt: new Date().toISOString(), actions: [] };
  await store.completeTaskSyncJob(pending.id, remote);
  const next = await store.nextTaskSyncJob();
  expect(next).toMatchObject({ localRevision: newer.localRevision, payload: { note: '上传过程中继续编辑', revision: '1' } });
  await store.completeTaskSyncJob(next.id, { ...remote, note: newer.note, revision: '2', updatedAt: new Date().toISOString() });

  const current = await store.getTask(first.id), local = await store.saveTask({ ...current, note: '本机冲突版本' }, current.localRevision);
  const cloud = { ...remote, note: '云端冲突版本', revision: '3', updatedAt: new Date().toISOString() };
  await store.applyTaskCloudItems([cloud]);
  expect(await store.taskSyncSummary()).toMatchObject({ conflicts: 1 });
  const conflict = (await store.listTaskConflicts())[0]; expect(conflict.remote.note).toBe('云端冲突版本');
  await store.resolveTaskConflict(conflict.id, 'local');
  const retry = await store.nextTaskSyncJob(); expect(retry).toMatchObject({ payload: { note: local.note, revision: '3' } });
}

describe('offline task repositories', () => {
  it('persists and CAS-protects tasks in IndexedDB', async () => {
    const store = createLocalStore(`task-test-${crypto.randomUUID()}`);
    cleanup.push(() => store.db.delete());
    await verifyStore(store);
    store.db.close(); await store.db.open();
    expect(await store.listTasks()).toHaveLength(1);
  });

  it('persists and CAS-protects tasks in the real SQLite schema', async () => {
    const connection = sqliteBridge(), store = await createSqliteStore(connection, `task-test-${crypto.randomUUID()}`);
    expect(SQLITE_SCHEMA_VERSION).toBe(4);
    await verifyStore(store);
    expect(connection.raw.prepare('PRAGMA user_version').get().user_version).toBe(4);
    expect(connection.raw.prepare('SELECT count(*) AS count FROM task_outbox').get().count).toBe(1);
  });

  it('rejects malformed reminders, recurrence and duplicate checklist ids', async () => {
    const store = createLocalStore(`task-test-${crypto.randomUUID()}`);
    cleanup.push(() => store.db.delete());
    await expect(store.saveTask(input({ reminderMinutesBefore: -1 }))).rejects.toThrow('提醒时间');
    await expect(store.saveTask(input({ dueAt: null, recurrence: { frequency: 'daily', interval: 1 } }))).rejects.toThrow('重复待办');
    await expect(store.saveTask(input({ recurrence: { frequency: 'weekly', interval: 1, weekdays: [] } }))).rejects.toThrow('每周');
    await expect(store.saveTask(input({ recurrence: { frequency: 'monthly', interval: 1, dayOfMonth: 32 } }))).rejects.toThrow('每月');
    await expect(store.saveTask(input({ actions: [{ id: crypto.randomUUID(), type: 'https', label: '危险动作', target: 'javascript:alert(1)' }] }))).rejects.toThrow('HTTPS');
    const safe = await store.saveTask(input({ actions: [{ id: crypto.randomUUID(), type: 'https', label: '打开帮助', target: 'https://example.com/help' }] }));
    expect(safe.actions).toMatchObject([{ type: 'https', label: '打开帮助', target: 'https://example.com/help' }]);
    const id = crypto.randomUUID();
    await expect(store.saveTask(input({ checklist: [{ id, text: 'A', completed: false }, { id, text: 'B', completed: false }] }))).rejects.toThrow('重复');
  });

  it('freezes and conflict-protects IndexedDB task uploads', async () => {
    const store = createLocalStore(`task-sync-${crypto.randomUUID()}`); cleanup.push(() => store.db.delete()); await verifyTaskSyncQueue(store);
  });

  it('freezes and conflict-protects SQLite task uploads', async () => {
    const store = await createSqliteStore(sqliteBridge(), `task-sync-${crypto.randomUUID()}`); await verifyTaskSyncQueue(store);
  });
});
