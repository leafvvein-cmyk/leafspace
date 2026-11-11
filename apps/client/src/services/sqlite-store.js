import { validateEntry, hasContent, contentText } from '@diary/contracts';
import { createSyncMirror } from './sync-mirror.js';
import { createUploadQueue } from './upload-queue.js';
import { keepCloud, saveMergeDraft } from './conflict-resolution.js';
import { conflictPage, validateConflictPage, makeConflictCopy } from './repository-shared.js';
import { LocalConflictError, DailyExistsError, filterEntries, findDailyDraft, cloudEntry, mergeEntries, cloudBaseChanged, visibleRecord, isConfirmed } from './repository-shared.js';
import { validateLocalAsset, bytesToBase64, base64ToBytes, contentAssetIds, remapContentAssetIds, withoutContentAssets, assetUploadFailure, assetProblem } from './local-assets.js';
import { validateTask, taskSort } from './task-model.js';

// Schema 1 is immutable once released. Future versions use explicit migrations;
// an unknown version is an error, never a reason to delete a user's database.
export const SQLITE_SCHEMA_VERSION = 4;
export const SQLITE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY NOT NULL, daily_key TEXT UNIQUE, entry_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('daily','moment')), local_revision INTEGER NOT NULL,
    deleted_at TEXT, payload TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(entry_date)',
  'CREATE TABLE IF NOT EXISTS drafts (entry_id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_outbox_status_entry ON outbox(status, entry_id)',
  'CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_conflicts_entry ON conflicts(entry_id)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)',
];
export const SQLITE_SYNC_MIGRATION = [
  'CREATE TABLE cloud_records (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
  'CREATE TABLE snapshot_stage (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
  'CREATE TABLE sync_state (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
];
export const SQLITE_TASK_MIGRATION = [
  'CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, due_at TEXT, updated_at TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX idx_tasks_status_due ON tasks(status, due_at, updated_at, id)',
  'CREATE TABLE task_outbox (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX idx_task_outbox_status ON task_outbox(status, created_at, id)',
];
export const SQLITE_VAULT_MIGRATION = [
  'CREATE TABLE vault_config (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)',
  'CREATE TABLE vault_items (id TEXT PRIMARY KEY NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, payload TEXT NOT NULL)',
  'CREATE INDEX idx_vault_items_updated ON vault_items(deleted_at, updated_at, id)',
  'CREATE TABLE vault_outbox (id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE INDEX idx_vault_outbox_status ON vault_outbox(status, created_at, id)',
];

/** The connection is a Capacitor SQLiteDBConnection, not a Web SQLite shim.
 * Tests inject Node SQLite to verify real SQL and transactions separately from
 * device/plugin verification. All connection access goes through this queue.
 */
export async function createSqliteStore(connection, namespace, { closeConnection = () => connection.close() } = {}) {
  let queue = Promise.resolve();
  let closed = false;
  let unusable = false;
  function serial(task) {
    const result = queue.catch(() => {}).then(() => {
      if (closed || unusable) throw new Error('本机数据库已关闭或需要重新打开；请保留当前草稿。');
      return task();
    });
    queue = result;
    return result;
  }
  const run = (sql, values = []) => connection.run(sql, values, false);
  const rows = async (sql, values = []) => (await connection.query(sql, values)).values ?? [];
  const one = async (sql, values = []) => (await rows(sql, values))[0];
  const parse = (row) => row ? JSON.parse(row.payload) : undefined;
  const getEntry = async (id) => parse(await one('SELECT payload FROM entries WHERE id = ?', [id]));
  const cloudRecord = async (id) => parse(await one('SELECT payload FROM cloud_records WHERE key = ?', [`entry:${id}`]));
  const receiptFor = async (id) => parse(await one('SELECT payload FROM outbox WHERE id=?', [`receipt:${id}`]));
  const snapshotPosition = async () => parse(await one("SELECT payload FROM sync_state WHERE key='active'"))?.snapshotPosition;
  const visibleEntry = async (id) => {
    const found = await rows(`SELECT payload, 'local' AS source FROM entries WHERE id=?
      UNION ALL SELECT payload, 'cloud' AS source FROM cloud_records WHERE key=?
      UNION ALL SELECT payload, 'receipt' AS source FROM outbox WHERE id=?
      UNION ALL SELECT payload, 'position' AS source FROM sync_state WHERE key='active'`, [id, `entry:${id}`, `receipt:${id}`]);
    const bySource = Object.fromEntries(found.map((row) => [row.source, parse(row)]));
    return visibleRecord(bySource.local, bySource.cloud, bySource.receipt, bySource.position?.snapshotPosition);
  };
  const visibleEntries = async () => mergeEntries((await rows('SELECT payload FROM entries')).map(parse), (await rows('SELECT payload FROM cloud_records')).map(parse), (await rows("SELECT payload FROM outbox WHERE status='acknowledged'")).map(parse), await snapshotPosition());

  async function transaction(task) {
    await connection.beginTransaction();
    try {
      const result = await task();
      await connection.commitTransaction();
      return result;
    } catch (error) {
      try {
        if ((await connection.isTransactionActive()).result) await connection.rollbackTransaction();
      } catch {
        // Do not run further operations on a connection whose transaction state
        // is unknown. No automatic close/delete/recreate recovery.
        unusable = true;
      }
      throw error;
    }
  }

  await serial(async () => {
    await connection.execute('PRAGMA foreign_keys = ON;', false);
    // Android SQLCipher execSQL rejects statements returning rows. These two
    // PRAGMAs must use rawQuery, unlike the non-returning foreign_keys setter.
    await connection.query('PRAGMA busy_timeout = 5000;');
    const version = Number((await one('PRAGMA user_version')).user_version);
    if (version > SQLITE_SCHEMA_VERSION) throw new Error('本机数据库来自较新版本，请更新 App 后打开。');
    await transaction(async () => {
      for (const statement of SQLITE_SCHEMA) await connection.execute(statement, false);
      if (version < 2) for (const statement of SQLITE_SYNC_MIGRATION) await connection.execute(statement, false);
      if (version < 3) for (const statement of SQLITE_TASK_MIGRATION) await connection.execute(statement, false);
      if (version < 4) for (const statement of SQLITE_VAULT_MIGRATION) await connection.execute(statement, false);
      await connection.execute(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION};`, false);
    });
    await connection.query('PRAGMA optimize;');
  });

  const tables = { cloud: 'cloud_records', stage: 'snapshot_stage', state: 'sync_state' };
  const syncMirror = createSyncMirror(namespace, {
    atomic: (task) => serial(() => transaction(task)),
    get: async (table, key) => parse(await one(`SELECT payload FROM ${tables[table]} WHERE key=?`, [key])),
    put: (table, key, value) => run(`INSERT INTO ${tables[table]}(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload`, [key, JSON.stringify(value)]),
    remove: (table, key) => run(`DELETE FROM ${tables[table]} WHERE key=?`, [key]),
    clear: (table) => run(`DELETE FROM ${tables[table]}`),
    list: async (table) => (await rows(`SELECT payload FROM ${tables[table]} ORDER BY key`)).map(parse),
    copy: (from, to) => run(`INSERT INTO ${tables[to]}(key,payload) SELECT key,payload FROM ${tables[from]}`),
  });

  const uploadQueue = createUploadQueue(namespace, {
    atomic: (task) => serial(() => transaction(task)),
    jobs: async () => (await rows('SELECT payload FROM outbox ORDER BY id')).map(parse),
    job: async (id) => parse(await one('SELECT payload FROM outbox WHERE id=?', [id])),
    put: (job) => run('INSERT INTO outbox(id,entry_id,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload', [job.id, job.entryId, job.status, JSON.stringify(job)]),
    remove: (id) => run('DELETE FROM outbox WHERE id=?', [id]),
    entry: getEntry, cloud: cloudRecord,
    conflict: (record) => run('INSERT INTO conflicts(id,entry_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [record.id, record.entryId, JSON.stringify(record)]),
    prepareAssetUpload: async (entry) => {
      const ids = contentAssetIds(entry.content); if (!ids.length) return { entry: structuredClone(entry), pendingAssets: 0 };
      const placeholders = ids.map(() => '?').join(',');
      const found = await rows(`SELECT id,entry_id,status FROM assets WHERE id IN (${placeholders})`, ids);
      const byId = new Map(found.map((asset) => [asset.id, asset]));
      const pending = ids.filter((id) => byId.get(id)?.entry_id !== entry.id || byId.get(id)?.status !== 'ready');
      return { entry: pending.length ? { ...entry, content: withoutContentAssets(entry.content, pending) } : structuredClone(entry), pendingAssets: pending.length };
    },
  });

  async function saveDirect(entry, expectedRevision) {
    const snapshot = structuredClone(entry);
    validateEntry(snapshot, { allowEmpty: true });
    const result = await transaction(async () => {
      const currentEntry = await getEntry(snapshot.id);
      const currentDraft = parse(await one('SELECT payload FROM drafts WHERE entry_id = ?', [snapshot.id]));
      const current = currentEntry ?? currentDraft?.snapshot;
      const localRevision = current?.localRevision ?? 0;
      const stamp = new Date().toISOString();
      const remoteRecord = await cloudRecord(snapshot.id);
      const receipt = await receiptFor(snapshot.id);
      const view = visibleRecord(currentEntry, remoteRecord, receipt, await snapshotPosition());
      const remoteChanged = current?.localRetired ? !view || snapshot.revision !== view.revision : isConfirmed(currentEntry, receipt)
        ? !view || (snapshot.revision !== view.revision && snapshot.revision !== currentEntry.revision)
          || (snapshot.revision === currentEntry.revision && view.revision !== receipt.entry.revision)
        : !current && cloudBaseChanged(snapshot, remoteRecord);
      const conflict = current && localRevision !== expectedRevision || remoteChanged;
      const daily = snapshot.kind === 'daily' && !snapshot.deletedAt && hasContent(snapshot)
        ? (await visibleEntries()).find((item) => item.id !== snapshot.id && item.kind === 'daily' && !item.deletedAt && item.entryDate === snapshot.entryDate) : null;
      if (conflict || daily && daily.id !== snapshot.id) {
        const remote = conflict ? (remoteChanged ? view : current) ?? cloudEntry(remoteRecord) ?? { id: snapshot.id, title: '云端记录已删除或当前不可用' } : daily;
        const record = { id: crypto.randomUUID(), entryId: snapshot.id, local: snapshot, remote, createdAt: stamp };
        await run('INSERT INTO conflicts(id, entry_id, payload) VALUES (?, ?, ?)', [record.id, record.entryId, JSON.stringify(record)]);
        return { conflict: conflict ? 'revision' : 'daily', current: remote };
      }
      const base = (current?.localRetired || isConfirmed(currentEntry, receipt)) && view ? view : current;
      const saved = { ...snapshot, ...(base ? { revision: base.revision, syncBaseDeletedAt: base.syncBaseDeletedAt } : {}),
        localRevision: localRevision + 1, updatedAt: stamp, plainText: contentText(snapshot.content).trim() };
      delete saved.localRetired;
      delete saved.dailyKey;
      if (saved.kind === 'daily' && !saved.deletedAt && hasContent(saved)) saved.dailyKey = saved.entryDate;
      if (saved.dailyKey) await run('UPDATE entries SET daily_key=NULL WHERE daily_key=? AND id<>?', [saved.dailyKey, saved.id]);
      const draft = { entryId: saved.id, snapshot: saved, updatedAt: stamp };
      await run('INSERT INTO drafts(entry_id, payload) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET payload = excluded.payload', [saved.id, JSON.stringify(draft)]);
      if (hasContent(saved)) {
        await run(`INSERT INTO entries(id, daily_key, entry_date, kind, local_revision, deleted_at, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          daily_key = excluded.daily_key, entry_date = excluded.entry_date, kind = excluded.kind,
          local_revision = excluded.local_revision, deleted_at = excluded.deleted_at, payload = excluded.payload`,
        [saved.id, saved.dailyKey ?? null, saved.entryDate, saved.kind, saved.localRevision, saved.deletedAt ?? null, JSON.stringify(saved)]);
        const marker = { id: `draft:${saved.id}`, entryId: saved.id, status: 'local-only', createdAt: stamp };
        await run('INSERT INTO outbox(id, entry_id, status, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload',
          [marker.id, saved.id, marker.status, JSON.stringify(marker)]);
      } else if (currentEntry || cloudEntry(remoteRecord)) throw new Error('已保存的记录至少保留标题或正文；删除请移到回收站。');
      return { entry: saved };
    });
    // Throw only AFTER commit, otherwise the losing recovery copy is lost too.
    if (result.conflict === 'revision') throw new LocalConflictError(result.current);
    if (result.conflict === 'daily') throw new DailyExistsError(result.current);
    return result.entry;
  }

  return {
    namespace, backend: 'sqlite-native',
    save(entry, expectedRevision = entry.localRevision) {
      const snapshot = structuredClone(entry);
      return serial(() => saveDirect(snapshot, expectedRevision));
    },
    syncMirror, uploadQueue,
    keepCloud: (id, options) => keepCloud({
      entries: visibleEntries,
      putJob: (job) => run('INSERT INTO outbox(id,entry_id,status,payload) VALUES(?,?,?,?)', [job.id, job.entryId, job.status, JSON.stringify(job)]),
      snapshotPending: async () => Boolean(await one("SELECT key FROM sync_state WHERE key IN ('request','staging') LIMIT 1", [])),
      atomic: (task) => serial(() => transaction(task)), conflict: async (key) => parse(await one('SELECT payload FROM conflicts WHERE id=?', [key])),
      local: async (key) => await getEntry(key) ?? parse(await one('SELECT payload FROM drafts WHERE entry_id=?', [key]))?.snapshot,
      jobs: async (key) => (await rows('SELECT payload FROM outbox WHERE entry_id=?', [key])).map(parse), cloud: cloudRecord,
      retire: async (entry) => {
        await run('INSERT INTO entries(id,daily_key,entry_date,kind,local_revision,deleted_at,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET daily_key=excluded.daily_key,entry_date=excluded.entry_date,kind=excluded.kind,deleted_at=excluded.deleted_at,local_revision=excluded.local_revision,payload=excluded.payload',
          [entry.id, entry.dailyKey ?? null, entry.entryDate, entry.kind, entry.localRevision, entry.deletedAt, JSON.stringify(entry)]);
        await run('INSERT INTO drafts(entry_id,payload) VALUES(?,?) ON CONFLICT(entry_id) DO UPDATE SET payload=excluded.payload', [entry.id, JSON.stringify({ entryId: entry.id, snapshot: entry, updatedAt: entry.updatedAt })]);
      },
      putCloud: (record) => run('INSERT INTO cloud_records(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload', [`entry:${record.id}`, JSON.stringify(record)]),
      removeJob: (key) => run('DELETE FROM outbox WHERE id=?', [key]),
      putConflict: (record) => run('UPDATE conflicts SET payload=? WHERE id=?', [JSON.stringify(record), record.id]),
    }, id, options),
    saveMergeDraft: (id, entry, expectedRevision) => saveMergeDraft({
      atomic: (task) => serial(() => transaction(task)),
      conflict: async (key) => parse(await one('SELECT payload FROM conflicts WHERE id=?', [key])),
      putConflict: (record) => run('UPDATE conflicts SET payload=? WHERE id=?', [JSON.stringify(record), record.id]),
    }, id, entry, expectedRevision),
    copyConflict: (id) => serial(() => transaction(async () => {
      const record = parse(await one('SELECT payload FROM conflicts WHERE id=?', [id]));
      if (!record) throw new Error('找不到这次冲突');
      if (record.copyEntryId) return { entryId: record.copyEntryId, reused: true };
      let copy = makeConflictCopy(record);
      const mapping = new Map(), clonedAssets = [];
      for (const assetId of contentAssetIds(copy.content)) {
        const asset = parse(await one('SELECT payload FROM assets WHERE id=?', [assetId]));
        if (!asset || asset.entryId !== record.entryId) continue;
        const nextId = crypto.randomUUID(); mapping.set(assetId, nextId);
        clonedAssets.push({ ...asset, id: nextId, entryId: copy.id, uploadRequestId: crypto.randomUUID(), completeRequestId: crypto.randomUUID(),
          status: 'local-only', uploadAttempts: 0, error: null, updatedAt: new Date().toISOString() });
      }
      if (mapping.size) copy = { ...copy, content: remapContentAssetIds(copy.content, mapping) };
      await run('INSERT INTO entries(id,daily_key,entry_date,kind,local_revision,deleted_at,payload) VALUES(?,NULL,?,?,?,NULL,?)',
        [copy.id, copy.entryDate, copy.kind, copy.localRevision, JSON.stringify(copy)]);
      await run('INSERT INTO drafts(entry_id,payload) VALUES(?,?)', [copy.id, JSON.stringify({ entryId: copy.id, snapshot: copy, updatedAt: copy.updatedAt })]);
      for (const asset of clonedAssets) await run('INSERT INTO assets(id,entry_id,status,payload) VALUES(?,?,?,?)', [asset.id, asset.entryId, asset.status, JSON.stringify(asset)]);
      const marker = { id: `draft:${copy.id}`, entryId: copy.id, status: 'local-only', createdAt: copy.createdAt };
      await run('INSERT INTO outbox(id,entry_id,status,payload) VALUES(?,?,?,?)', [marker.id, marker.entryId, marker.status, JSON.stringify(marker)]);
      await run('UPDATE conflicts SET payload=? WHERE id=?', [JSON.stringify({ ...record, copyEntryId: copy.id, copyCreatedAt: copy.createdAt }), id]);
      return { entryId: copy.id, reused: false };
    })),
    listConflicts: ({ before = null, limit = 20 } = {}) => serial(async () => {
      validateConflictPage(before, limit);
      return conflictPage((await rows(`SELECT payload FROM conflicts ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, before ? [before, limit + 1] : [limit + 1])).map(parse), limit);
    }),
    getConflict: (id) => serial(() => transaction(async () => {
      const record = parse(await one('SELECT payload FROM conflicts WHERE id=?', [id]));
      return record ? { record, latestLocal: await getEntry(record.entryId) ?? parse(await one('SELECT payload FROM drafts WHERE entry_id=?', [record.entryId]))?.snapshot ?? null } : null;
    })),
    get: (id) => serial(() => visibleEntry(id)),
    draft: (id) => serial(() => transaction(async () => {
      const local = await getEntry(id), receipt = await receiptFor(id);
      if (local?.localRetired) return visibleRecord(local, await cloudRecord(id), receipt, await snapshotPosition());
      if (isConfirmed(local, receipt) && !visibleRecord(local, await cloudRecord(id), receipt, await snapshotPosition())) return undefined;
      return parse(await one('SELECT payload FROM drafts WHERE entry_id = ?', [id]))?.snapshot;
    })),
    dailyDraft: (date) => serial(async () => findDailyDraft((await rows('SELECT d.payload FROM drafts d LEFT JOIN entries e ON e.id=d.entry_id WHERE e.id IS NULL')).map(parse), date)),
    day: (date) => serial(() => transaction(async () => (await visibleEntries()).filter((entry) => entry.entryDate === date && !entry.deletedAt).sort((a, b) => Number(b.localRevision > 0) - Number(a.localRevision > 0)))),
    list: (filters = {}) => serial(() => transaction(async () => filterEntries(await visibleEntries(), filters))),
    trash: (id) => serial(async () => {
      const entry = await visibleEntry(id);
      if (!entry) throw new Error('找不到这篇日记');
      return saveDirect({ ...entry, deletedAt: new Date().toISOString(), purgeAfter: null }, entry.localRevision);
    }),
    restore: (id, overrides = {}) => serial(async () => {
      const entry = await visibleEntry(id);
      if (!entry) throw new Error('找不到这篇日记');
      return saveDirect({ ...entry, ...overrides, deletedAt: null, purgeAfter: null }, entry.localRevision);
    }),
    exportLocal: () => serial(() => transaction(async () => ({
      exportSchemaVersion: 3, source: namespace.startsWith('user:') ? 'account-local' : 'local-learning', namespace, exportedAt: new Date().toISOString(),
      entries: (await rows('SELECT payload FROM entries ORDER BY id')).map(parse),
      drafts: (await rows('SELECT payload FROM drafts ORDER BY entry_id')).map(parse),
      conflicts: (await rows('SELECT payload FROM conflicts ORDER BY id')).map(parse),
      assets: (await rows('SELECT payload FROM assets ORDER BY id')).map(parse),
      tasks: (await rows('SELECT payload FROM tasks ORDER BY id')).map(parse),
      taskOutbox: (await rows('SELECT payload FROM task_outbox ORDER BY id')).map(parse),
    }))),
    getSetting: (key, fallback) => serial(async () => parse(await one('SELECT payload FROM settings WHERE key = ?', [key]))?.value ?? fallback),
    setSetting: (key, value) => serial(() => run('INSERT INTO settings(key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload', [key, JSON.stringify({ value })])),
    saveTask: (input, expectedRevision = input.localRevision ?? 0) => serial(() => transaction(async () => {
      const snapshot = validateTask(input), current = parse(await one('SELECT payload FROM tasks WHERE id=?', [snapshot.id]));
      if ((current?.localRevision ?? 0) !== expectedRevision) throw new Error('这个待办已在另一个窗口修改，请重新打开后再编辑');
      const stamp = new Date().toISOString();
      const saved = { ...snapshot, seriesId: snapshot.seriesId ?? snapshot.id, revision: current?.revision ?? snapshot.revision ?? '0',
        localRevision: expectedRevision + 1, createdAt: current?.createdAt ?? snapshot.createdAt ?? stamp, updatedAt: stamp };
      await run(`INSERT INTO tasks(id,status,due_at,updated_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,due_at=excluded.due_at,updated_at=excluded.updated_at,payload=excluded.payload`, [saved.id, saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved)]);
      const job = { id: `task:${saved.id}`, taskId: saved.id, status: 'local-only', createdAt: stamp, payload: saved };
      await run('INSERT INTO task_outbox(id,task_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload', [job.id, job.taskId, job.status, job.createdAt, JSON.stringify(job)]);
      return structuredClone(saved);
    })),
    getTask: (id) => serial(async () => { const task = parse(await one('SELECT payload FROM tasks WHERE id=?', [id])); return task ? structuredClone(task) : undefined; }),
    listTasks: ({ state = 'open' } = {}) => serial(async () => {
      const found = state === 'all' ? await rows('SELECT payload FROM tasks') : await rows('SELECT payload FROM tasks WHERE status=?', [state]);
      return found.map(parse).sort(taskSort).map((task) => structuredClone(task));
    }),
    setTaskStatus: (id, status, expectedRevision) => serial(async () => {
      const current = parse(await one('SELECT payload FROM tasks WHERE id=?', [id])); if (!current) throw new Error('找不到这个待办');
      const stamp = new Date().toISOString();
      const snapshot = validateTask({ ...current, status, completedAt: status === 'completed' ? stamp : null, deletedAt: status === 'trash' ? stamp : null });
      if ((current.localRevision ?? 0) !== (expectedRevision ?? current.localRevision)) throw new Error('这个待办已在另一个窗口修改，请重新打开后再编辑');
      const saved = { ...snapshot, localRevision: current.localRevision + 1, updatedAt: stamp };
      await transaction(async () => {
        await run('UPDATE tasks SET status=?,due_at=?,updated_at=?,payload=? WHERE id=?', [saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved), id]);
        const job = { id: `task:${id}`, taskId: id, status: 'local-only', createdAt: stamp, payload: saved };
        await run('INSERT INTO task_outbox(id,task_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload', [job.id, id, job.status, job.createdAt, JSON.stringify(job)]);
      });
      return structuredClone(saved);
    }),
    taskUploadCount: () => serial(async () => Number((await one("SELECT count(*) AS count FROM task_outbox WHERE status='local-only'"))?.count ?? 0)),
    nextTaskSyncJob: () => serial(() => transaction(async () => {
      let job = parse(await one("SELECT payload FROM task_outbox WHERE status='pending' ORDER BY created_at,id LIMIT 1")); if (job) return structuredClone(job);
      const marker = parse(await one("SELECT payload FROM task_outbox WHERE status='local-only' ORDER BY created_at,id LIMIT 1")); if (!marker) return null;
      const task = parse(await one('SELECT payload FROM tasks WHERE id=?', [marker.taskId])); if (!task) { await run('DELETE FROM task_outbox WHERE id=?', [marker.id]); return null; }
      job = { id: `pending-task:${task.id}`, taskId: task.id, status: 'pending', createdAt: marker.createdAt, frozenAt: new Date().toISOString(),
        localRevision: task.localRevision, payload: structuredClone(task), requestIds: { create: crypto.randomUUID(), update: crypto.randomUUID(), actions: crypto.randomUUID(), restore: crypto.randomUUID(), state: crypto.randomUUID() } };
      await run('INSERT INTO task_outbox(id,task_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
        [job.id, job.taskId, job.status, job.createdAt, JSON.stringify(job)]); await run('DELETE FROM task_outbox WHERE id=?', [marker.id]); return structuredClone(job);
    })),
    completeTaskSyncJob: (jobId, remote) => serial(() => transaction(async () => {
      const job = parse(await one('SELECT payload FROM task_outbox WHERE id=?', [jobId])); if (!job || job.status !== 'pending') throw new Error('待办同步请求已变化');
      const current = parse(await one('SELECT payload FROM tasks WHERE id=?', [job.taskId]));
      if (current) {
        const saved = current.localRevision > job.localRevision ? { ...current, revision: remote.revision, seriesId: remote.seriesId ?? current.seriesId }
          : { ...structuredClone(remote), localRevision: current.localRevision };
        await run('UPDATE tasks SET status=?,due_at=?,updated_at=?,payload=? WHERE id=?', [saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved), saved.id]);
      }
      await run('DELETE FROM task_outbox WHERE id=?', [jobId]);
    })),
    failTaskSyncJob: (jobId, remote) => serial(() => transaction(async () => {
      const job = parse(await one('SELECT payload FROM task_outbox WHERE id=?', [jobId])); if (job?.status !== 'pending') return;
      const saved = { ...job, status: 'conflict', remote: structuredClone(remote), failedAt: new Date().toISOString() };
      await run('UPDATE task_outbox SET status=?,payload=? WHERE id=?', [saved.status, JSON.stringify(saved), jobId]);
    })),
    applyTaskCloudItems: (remotes) => serial(() => transaction(async () => {
      for (const remote of remotes) {
        const local = parse(await one('SELECT payload FROM tasks WHERE id=?', [remote.id]));
        const marker = parse(await one('SELECT payload FROM task_outbox WHERE id=?', [`task:${remote.id}`]));
        const pending = parse(await one('SELECT payload FROM task_outbox WHERE id=?', [`pending-task:${remote.id}`]));
        if (!local) {
          const saved = { ...structuredClone(remote), localRevision: 0 };
          await run('INSERT INTO tasks(id,status,due_at,updated_at,payload) VALUES(?,?,?,?,?)', [saved.id, saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved)]); continue;
        }
        if (marker || pending) {
          if (local.revision !== remote.revision && pending?.status !== 'conflict') {
            const conflict = { ...(pending ?? { id: `pending-task:${remote.id}`, taskId: remote.id, requestIds: null, createdAt: new Date().toISOString(),
              localRevision: local.localRevision, payload: local }), status: 'conflict', remote: structuredClone(remote) };
            await run('INSERT INTO task_outbox(id,task_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
              [conflict.id, conflict.taskId, conflict.status, conflict.createdAt, JSON.stringify(conflict)]);
          }
          continue;
        }
        if (BigInt(remote.revision) >= BigInt(local.revision)) {
          const saved = { ...structuredClone(remote), localRevision: local.localRevision };
          await run('UPDATE tasks SET status=?,due_at=?,updated_at=?,payload=? WHERE id=?', [saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved), saved.id]);
        }
      }
    })),
    taskSyncSummary: () => serial(async () => {
      const found = await rows('SELECT status,count(*) AS count FROM task_outbox GROUP BY status'); const counts = Object.fromEntries(found.map((row) => [row.status, Number(row.count)]));
      return { waiting: (counts['local-only'] ?? 0) + (counts.pending ?? 0), conflicts: counts.conflict ?? 0 };
    }),
    listTaskConflicts: () => serial(async () => {
      const jobs = (await rows("SELECT payload FROM task_outbox WHERE status='conflict' ORDER BY created_at,id")).map(parse);
      return Promise.all(jobs.map(async (job) => ({ ...structuredClone(job), local: parse(await one('SELECT payload FROM tasks WHERE id=?', [job.taskId])) })));
    }),
    resolveTaskConflict: (jobId, choice) => serial(() => transaction(async () => {
      if (!['local','cloud'].includes(choice)) throw new Error('请选择保留本机或云端版本');
      const job = parse(await one('SELECT payload FROM task_outbox WHERE id=?', [jobId])); if (!job || job.status !== 'conflict' || !job.remote) throw new Error('找不到这次待办冲突');
      const current = parse(await one('SELECT payload FROM tasks WHERE id=?', [job.taskId])); if (!current) throw new Error('本机待办已不存在');
      if (choice === 'cloud') {
        const saved = { ...structuredClone(job.remote), localRevision: current.localRevision + 1 };
        await run('UPDATE tasks SET status=?,due_at=?,updated_at=?,payload=? WHERE id=?', [saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved), saved.id]);
        await run('DELETE FROM task_outbox WHERE id=?', [`task:${job.taskId}`]);
      } else {
        const saved = { ...current, revision: job.remote.revision, localRevision: current.localRevision + 1, updatedAt: new Date().toISOString() };
        await run('UPDATE tasks SET status=?,due_at=?,updated_at=?,payload=? WHERE id=?', [saved.status, saved.dueAt, saved.updatedAt, JSON.stringify(saved), saved.id]);
        const marker = { id: `task:${saved.id}`, taskId: saved.id, status: 'local-only', createdAt: saved.updatedAt, payload: saved };
        await run('INSERT INTO task_outbox(id,task_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload',
          [marker.id, marker.taskId, marker.status, marker.createdAt, JSON.stringify(marker)]);
      }
      await run('DELETE FROM task_outbox WHERE id=?', [jobId]);
    })),
    getVaultConfig: () => serial(async () => parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value),
    saveVaultConfig: (config, expectedRevision = '0') => serial(() => transaction(async () => {
      if (await one("SELECT id FROM vault_outbox WHERE id='vault-key-rotation'")) throw new Error('密码本正在轮换数据密钥，不能修改设置');
      const current = parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value;
      if ((current?.localRevision ?? 0) !== Number(expectedRevision)) throw new Error('密码本设置已在另一窗口修改');
      const saved = { ...structuredClone(config), revision: current?.revision ?? config.revision ?? '0',
        localRevision: Number(expectedRevision) + 1, updatedAt: new Date().toISOString() };
      await run("INSERT INTO vault_config(key,payload) VALUES('active',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", [JSON.stringify({ value: saved })]);
      const job = { id: 'vault-config', itemId: 'config', status: 'local-only', createdAt: saved.updatedAt, payload: saved };
      await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload',
        [job.id, job.itemId, job.status, job.createdAt, JSON.stringify(job)]);
      return structuredClone(saved);
    })),
    saveVaultItem: (input, expectedRevision = 0) => serial(() => transaction(async () => {
      if (await one("SELECT id FROM vault_outbox WHERE id='vault-key-rotation'")) throw new Error('密码本正在轮换数据密钥，不能修改账号记录');
      const current = parse(await one('SELECT payload FROM vault_items WHERE id=?', [input.id]));
      if ((current?.localRevision ?? 0) !== expectedRevision) throw new Error('这条账号记录已在另一窗口修改');
      const stamp = new Date().toISOString(), saved = { ...structuredClone(input), revision: current?.revision ?? '0', localRevision: expectedRevision + 1,
        createdAt: current?.createdAt ?? stamp, updatedAt: stamp, deletedAt: null };
      await run(`INSERT INTO vault_items(id,updated_at,deleted_at,payload) VALUES(?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET
        updated_at=excluded.updated_at,deleted_at=NULL,payload=excluded.payload`, [saved.id, saved.updatedAt, JSON.stringify(saved)]);
      const job = { id: `vault:${saved.id}`, itemId: saved.id, status: 'local-only', createdAt: stamp, payload: saved };
      await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload',
        [job.id, job.itemId, job.status, job.createdAt, JSON.stringify(job)]);
      return structuredClone(saved);
    })),
    getVaultItem: (id) => serial(async () => { const record = parse(await one('SELECT payload FROM vault_items WHERE id=? AND deleted_at IS NULL', [id])); return record ? structuredClone(record) : undefined; }),
    listVaultItems: () => serial(async () => (await rows('SELECT payload FROM vault_items WHERE deleted_at IS NULL ORDER BY updated_at DESC,id')).map(parse).map((item) => structuredClone(item))),
    listAllVaultItems: () => serial(async () => (await rows('SELECT payload FROM vault_items ORDER BY id')).map(parse).map((item) => structuredClone(item))),
    getVaultKeyRotationJob: () => serial(async () => structuredClone(parse(await one("SELECT payload FROM vault_outbox WHERE id='vault-key-rotation'")) ?? null)),
    prepareVaultKeyRotation: (config, items) => serial(() => transaction(async () => {
      if (await one('SELECT id FROM vault_outbox LIMIT 1')) throw new Error('请先完成密码本同步或处理冲突，再轮换数据密钥');
      const currentConfig = parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value;
      const currentItems = (await rows('SELECT payload FROM vault_items ORDER BY id')).map(parse), candidates = [...items].sort((a, b) => a.id.localeCompare(b.id));
      const exact = currentConfig && currentConfig.localRevision === config.localRevision && currentConfig.revision === config.revision
        && currentItems.length === candidates.length && currentItems.every((item, index) => item.id === candidates[index].id
          && item.localRevision === candidates[index].localRevision && item.revision === candidates[index].revision);
      if (!exact) throw new Error('密码本已发生变化，请重新解锁并准备密钥轮换');
      const stamp = new Date().toISOString(), batchCount = Math.ceil(candidates.length / 50);
      const job = { id: 'vault-key-rotation', itemId: 'key-rotation', status: 'rotation-prepared', createdAt: stamp,
        startRequestId: crypto.randomUUID(), commitRequestId: crypto.randomUUID(), batchRequestIds: Array.from({ length: batchCount }, () => crypto.randomUUID()),
        baseConfigRevision: currentConfig.revision, config: structuredClone(config), items: structuredClone(candidates), rotationId: null };
      await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?)', [job.id, job.itemId, job.status, job.createdAt, JSON.stringify(job)]);
      return structuredClone(job);
    })),
    activateVaultKeyRotation: () => serial(() => transaction(async () => {
      const job = parse(await one("SELECT payload FROM vault_outbox WHERE id='vault-key-rotation'"));
      if (!job || job.status !== 'rotation-prepared') throw new Error('找不到等待确认的数据密钥轮换');
      const saved = { ...job, status: 'rotation-ready', acknowledgedAt: new Date().toISOString() };
      await run('UPDATE vault_outbox SET status=?,payload=? WHERE id=?', [saved.status, JSON.stringify(saved), job.id]); return structuredClone(saved);
    })),
    cancelPreparedVaultKeyRotation: () => serial(() => transaction(async () => {
      const job = parse(await one("SELECT payload FROM vault_outbox WHERE id='vault-key-rotation'"));
      if (job?.status === 'rotation-prepared') await run('DELETE FROM vault_outbox WHERE id=?', [job.id]);
    })),
    bindVaultKeyRotation: (rotationId) => serial(() => transaction(async () => {
      const job = parse(await one("SELECT payload FROM vault_outbox WHERE id='vault-key-rotation'"));
      if (!job || job.status !== 'rotation-ready' || job.rotationId && job.rotationId !== rotationId) throw new Error('数据密钥轮换任务已变化');
      if (!job.rotationId) await run('UPDATE vault_outbox SET payload=? WHERE id=?', [JSON.stringify({ ...job, rotationId }), job.id]);
    })),
    completeVaultKeyRotation: (remote) => serial(() => transaction(async () => {
      const job = parse(await one("SELECT payload FROM vault_outbox WHERE id='vault-key-rotation'"));
      const currentConfig = parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value;
      if (!job || job.status !== 'rotation-ready' || job.rotationId !== remote?.rotation?.id) throw new Error('数据密钥轮换确认已变化');
      const currentItems = (await rows('SELECT payload FROM vault_items ORDER BY id')).map(parse), currentById = new Map(currentItems.map((item) => [item.id, item]));
      const metadata = new Map((remote.items ?? []).map((item) => [item.id, item]));
      const exact = currentConfig?.revision === job.baseConfigRevision && currentConfig.localRevision === job.config.localRevision
        && currentItems.length === job.items.length && currentItems.every((item, index) => item.id === job.items[index].id
          && item.revision === job.items[index].revision && item.localRevision === job.items[index].localRevision && metadata.has(item.id));
      if (!exact || remote.config?.revision == null) throw new Error('本机密码本在轮换提交期间发生变化，请保持锁定并重新同步');
      const savedConfig = { ...job.config, revision: remote.config.revision, localRevision: currentConfig.localRevision + 1, updatedAt: remote.config.updatedAt };
      await run("UPDATE vault_config SET payload=? WHERE key='active'", [JSON.stringify({ value: savedConfig })]);
      for (const item of job.items) {
        const meta = metadata.get(item.id), current = currentById.get(item.id);
        const saved = { ...item, revision: meta.revision, localRevision: current.localRevision + 1, updatedAt: meta.updatedAt, deletedAt: meta.deletedAt };
        await run('UPDATE vault_items SET updated_at=?,deleted_at=?,payload=? WHERE id=?', [saved.updatedAt, saved.deletedAt, JSON.stringify(saved), saved.id]);
      }
      await run('DELETE FROM vault_outbox WHERE id=?', [job.id]); return structuredClone(savedConfig);
    })),
    importVaultBackup: (config, items) => serial(() => transaction(async () => {
      if (await one("SELECT key FROM vault_config WHERE key='active'") || await one('SELECT id FROM vault_items LIMIT 1')) throw new Error('当前空间已经有密码本，不能用备份覆盖');
      const stamp = new Date().toISOString(), savedConfig = { ...structuredClone(config), revision: '0', localRevision: 1, createdAt: stamp, updatedAt: stamp };
      await run("INSERT INTO vault_config(key,payload) VALUES('active',?)", [JSON.stringify({ value: savedConfig })]);
      const configJob = { id: 'vault-config', itemId: 'config', status: 'local-only', createdAt: stamp, payload: savedConfig };
      await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?)', [configJob.id, configJob.itemId, configJob.status, stamp, JSON.stringify(configJob)]);
      for (const item of items) {
        const saved = { ...structuredClone(item), revision: '0', localRevision: 1, createdAt: stamp, updatedAt: stamp, deletedAt: null };
        await run('INSERT INTO vault_items(id,updated_at,deleted_at,payload) VALUES(?,?,NULL,?)', [saved.id, stamp, JSON.stringify(saved)]);
        const job = { id: `vault:${saved.id}`, itemId: saved.id, status: 'local-only', createdAt: stamp, payload: saved };
        await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?)', [job.id, job.itemId, job.status, stamp, JSON.stringify(job)]);
      }
    })),
    deleteVaultItem: (id, expectedRevision) => serial(() => transaction(async () => {
      if (await one("SELECT id FROM vault_outbox WHERE id='vault-key-rotation'")) throw new Error('密码本正在轮换数据密钥，不能删除账号记录');
      const current = parse(await one('SELECT payload FROM vault_items WHERE id=?', [id])); if (!current || current.deletedAt) throw new Error('找不到这条账号记录');
      if (current.localRevision !== expectedRevision) throw new Error('这条账号记录已在另一窗口修改');
      const stamp = new Date().toISOString(), saved = { ...current, localRevision: current.localRevision + 1, updatedAt: stamp, deletedAt: stamp };
      await run('UPDATE vault_items SET updated_at=?,deleted_at=?,payload=? WHERE id=?', [stamp, stamp, JSON.stringify(saved), id]);
      const job = { id: `vault:${id}`, itemId: id, status: 'local-only', createdAt: stamp,
        payload: { id, revision: saved.revision, localRevision: saved.localRevision, deletedAt: stamp } };
      await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload',
        [job.id, job.itemId, job.status, job.createdAt, JSON.stringify(job)]);
    })),
    nextVaultSyncJob: () => serial(() => transaction(async () => {
      let job = parse(await one("SELECT payload FROM vault_outbox WHERE status='pending' ORDER BY created_at,id LIMIT 1"));
      if (job) return structuredClone(job);
      const marker = parse(await one("SELECT payload FROM vault_outbox WHERE status='local-only' ORDER BY CASE WHEN item_id='config' THEN 0 ELSE 1 END,created_at,id LIMIT 1"));
      if (!marker) return null;
      const payload = marker.itemId === 'config' ? parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value
        : parse(await one('SELECT payload FROM vault_items WHERE id=?', [marker.itemId]));
      if (!payload) { await run('DELETE FROM vault_outbox WHERE id=?', [marker.id]); return null; }
      job = { id: `pending:${marker.itemId}`, itemId: marker.itemId, status: 'pending', requestId: crypto.randomUUID(), createdAt: marker.createdAt,
        frozenAt: new Date().toISOString(), localRevision: payload.localRevision ?? 1, payload: structuredClone(payload) };
      await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
        [job.id, job.itemId, job.status, job.createdAt, JSON.stringify(job)]);
      await run('DELETE FROM vault_outbox WHERE id=?', [marker.id]); return structuredClone(job);
    })),
    completeVaultSyncJob: (jobId, remote) => serial(() => transaction(async () => {
      const job = parse(await one('SELECT payload FROM vault_outbox WHERE id=?', [jobId])); if (!job || job.status !== 'pending') throw new Error('密码本同步请求已变化');
      if (job.itemId === 'config') {
        const row = parse(await one("SELECT payload FROM vault_config WHERE key='active'"));
        if (row) await run("UPDATE vault_config SET payload=? WHERE key='active'", [JSON.stringify({ value: { ...row.value, revision: remote.revision, updatedAt: remote.updatedAt } })]);
      } else {
        const current = parse(await one('SELECT payload FROM vault_items WHERE id=?', [job.itemId]));
        if (current) {
          const saved = { ...current, revision: remote.revision, updatedAt: current.localRevision > job.localRevision ? current.updatedAt : remote.updatedAt,
            deletedAt: current.localRevision > job.localRevision ? current.deletedAt : remote.deletedAt };
          await run('UPDATE vault_items SET updated_at=?,deleted_at=?,payload=? WHERE id=?', [saved.updatedAt, saved.deletedAt, JSON.stringify(saved), saved.id]);
        }
      }
      await run('DELETE FROM vault_outbox WHERE id=?', [jobId]);
    })),
    failVaultSyncJob: (jobId, remote) => serial(() => transaction(async () => {
      const job = parse(await one('SELECT payload FROM vault_outbox WHERE id=?', [jobId])); if (!job || job.status !== 'pending') return;
      const saved = { ...job, status: 'conflict', remote: structuredClone(remote), failedAt: new Date().toISOString() };
      await run('UPDATE vault_outbox SET status=?,payload=? WHERE id=?', [saved.status, JSON.stringify(saved), jobId]);
    })),
    applyVaultCloudConfig: (remote) => serial(() => transaction(async () => {
      const local = parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value;
      const dirty = await one("SELECT id FROM vault_outbox WHERE id IN ('vault-config','pending:config') LIMIT 1");
      if (!local) { await run("INSERT INTO vault_config(key,payload) VALUES('active',?)", [JSON.stringify({ value: { ...structuredClone(remote), localRevision: 0 } })]); return 'applied'; }
      const same = ['salt','wrappedKey','wrapNonce','cryptoVersion','recoveryWrappedKey','recoveryNonce','recoveryVersion'].every((key) => local[key] === remote[key])
        && ['algorithm','memoryKiB','iterations','parallelism','hashLength'].every((key) => local.kdf?.[key] === remote.kdf?.[key]);
      if (same) { await run("UPDATE vault_config SET payload=? WHERE key='active'", [JSON.stringify({ value: { ...local, revision: remote.revision, updatedAt: remote.updatedAt } })]); return 'confirmed'; }
      if (!dirty) {
        const job = { id: 'pending:config', itemId: 'config', status: 'conflict', requestId: null, createdAt: new Date().toISOString(),
          localRevision: local.localRevision ?? 1, payload: local, remote: structuredClone(remote) };
        await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?)', [job.id, job.itemId, job.status, job.createdAt, JSON.stringify(job)]);
      }
      return 'conflict';
    })),
    applyVaultCloudItems: (remotes) => serial(() => transaction(async () => {
      for (const remote of remotes) {
        const local = parse(await one('SELECT payload FROM vault_items WHERE id=?', [remote.id]));
        const marker = parse(await one('SELECT payload FROM vault_outbox WHERE id=?', [`vault:${remote.id}`]));
        const pending = parse(await one('SELECT payload FROM vault_outbox WHERE id=?', [`pending:${remote.id}`]));
        if (!local) {
          await run('INSERT INTO vault_items(id,updated_at,deleted_at,payload) VALUES(?,?,?,?)', [remote.id, remote.updatedAt, remote.deletedAt, JSON.stringify({ ...structuredClone(remote), localRevision: 0 })]); continue;
        }
        if (marker || pending) {
          if (local.revision !== remote.revision && pending?.status !== 'conflict') {
            const conflict = { ...(pending ?? { id: `pending:${remote.id}`, itemId: remote.id, requestId: null, createdAt: new Date().toISOString(),
              localRevision: local.localRevision, payload: local }), status: 'conflict', remote: structuredClone(remote) };
            await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
              [conflict.id, conflict.itemId, conflict.status, conflict.createdAt, JSON.stringify(conflict)]);
          }
          continue;
        }
        if (BigInt(remote.revision) >= BigInt(local.revision)) await run('UPDATE vault_items SET updated_at=?,deleted_at=?,payload=? WHERE id=?',
          [remote.updatedAt, remote.deletedAt, JSON.stringify({ ...structuredClone(remote), localRevision: local.localRevision }), remote.id]);
      }
    })),
    vaultSyncSummary: () => serial(async () => {
      const found = await rows("SELECT status,count(*) AS count FROM vault_outbox GROUP BY status"); const counts = Object.fromEntries(found.map((row) => [row.status, Number(row.count)]));
      const summary = { waiting: (counts['local-only'] ?? 0) + (counts.pending ?? 0) + (counts['rotation-ready'] ?? 0), conflicts: counts.conflict ?? 0 };
      if (counts['rotation-prepared']) summary.rotationPrepared = true;
      return summary;
    }),
    listVaultConflicts: () => serial(async () => {
      const jobs = (await rows("SELECT payload FROM vault_outbox WHERE status='conflict' ORDER BY created_at,id")).map(parse);
      return Promise.all(jobs.map(async (job) => ({ ...structuredClone(job), local: job.itemId === 'config'
        ? parse(await one("SELECT payload FROM vault_config WHERE key='active'"))?.value : parse(await one('SELECT payload FROM vault_items WHERE id=?', [job.itemId])) })));
    }),
    resolveVaultConflict: (jobId, choice) => serial(() => transaction(async () => {
      if (!['local','cloud'].includes(choice)) throw new Error('请选择保留本机或云端版本');
      const job = parse(await one('SELECT payload FROM vault_outbox WHERE id=?', [jobId])); if (!job || job.status !== 'conflict') throw new Error('找不到这次密码本冲突');
      if (job.itemId === 'config') throw new Error('保险库密钥设置冲突不能自动处理，请保留两台设备并联系支持');
      const current = parse(await one('SELECT payload FROM vault_items WHERE id=?', [job.itemId])); if (!current || !job.remote) throw new Error('冲突内容不完整，不能自动覆盖');
      if (choice === 'cloud') {
        const saved = { ...structuredClone(job.remote), localRevision: current.localRevision + 1 };
        await run('UPDATE vault_items SET updated_at=?,deleted_at=?,payload=? WHERE id=?', [saved.updatedAt, saved.deletedAt, JSON.stringify(saved), saved.id]);
        await run('DELETE FROM vault_outbox WHERE id=?', [`vault:${job.itemId}`]);
      } else {
        const saved = { ...current, revision: job.remote.revision, localRevision: current.localRevision + 1, updatedAt: new Date().toISOString() };
        await run('UPDATE vault_items SET updated_at=?,deleted_at=?,payload=? WHERE id=?', [saved.updatedAt, saved.deletedAt, JSON.stringify(saved), saved.id]);
        const marker = { id: `vault:${job.itemId}`, itemId: job.itemId, status: 'local-only', createdAt: saved.updatedAt, payload: saved };
        await run('INSERT INTO vault_outbox(id,item_id,status,created_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,created_at=excluded.created_at,payload=excluded.payload',
          [marker.id, marker.itemId, marker.status, marker.createdAt, JSON.stringify(marker)]);
      }
      await run('DELETE FROM vault_outbox WHERE id=?', [jobId]);
    })),
    saveAsset: (input) => serial(() => transaction(async () => {
      const asset = validateLocalAsset(input), existing = parse(await one('SELECT payload FROM assets WHERE id=?', [asset.id]));
      if (existing && (existing.entryId !== asset.entryId || existing.sha256 !== asset.sha256 || existing.size !== asset.size)) throw new Error('图片标识已被另一份内容使用');
      const payload = { ...asset, bytes: undefined, sourceBase64: bytesToBase64(asset.bytes), status: existing?.status ?? asset.status,
        uploadAttempts: existing?.uploadAttempts ?? asset.uploadAttempts ?? 0, error: existing?.error ?? asset.error ?? null,
        uploadRequestId: existing?.uploadRequestId ?? asset.uploadRequestId ?? crypto.randomUUID(), completeRequestId: existing?.completeRequestId ?? asset.completeRequestId ?? crypto.randomUUID(), updatedAt: new Date().toISOString() };
      await run('INSERT INTO assets(id,entry_id,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload', [asset.id, asset.entryId, payload.status, JSON.stringify(payload)]);
      return { ...payload, sourceBase64: undefined, bytes: new Uint8Array(asset.bytes) };
    })),
    getAsset: (id) => serial(async () => { const asset = parse(await one('SELECT payload FROM assets WHERE id=?', [id])); return asset ? { ...asset, sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) } : undefined; }),
    listAssets: (entryId) => serial(async () => (await rows('SELECT payload FROM assets WHERE entry_id=? ORDER BY id', [entryId])).map(parse).map((asset) => ({ ...asset, sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) }))),
    nextAssetUpload: () => serial(async () => {
      for (const row of await rows("SELECT payload FROM assets WHERE status='local-only' ORDER BY id")) {
        const asset = parse(row), entry = await getEntry(asset.entryId) ?? parse(await one('SELECT payload FROM drafts WHERE entry_id=?', [asset.entryId]))?.snapshot;
        if (contentAssetIds(entry?.content).includes(asset.id)) return { ...asset, sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) };
      }
    }),
    recordAssetUploadFailure: (id, error) => serial(() => transaction(async () => {
      const asset = parse(await one('SELECT payload FROM assets WHERE id=?', [id])); if (!asset) throw new Error('本机图片已不存在');
      if (asset.status === 'ready') return { ...asset, sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) };
      const saved = assetUploadFailure(asset, error);
      await run('UPDATE assets SET status=?,payload=? WHERE id=?', [saved.status, JSON.stringify(saved), id]);
      return { ...saved, sourceBase64: undefined, bytes: base64ToBytes(saved.sourceBase64) };
    })),
    retryAssetUpload: (id) => serial(() => transaction(async () => {
      const asset = parse(await one('SELECT payload FROM assets WHERE id=?', [id])); if (!asset) throw new Error('本机图片已不存在');
      if (asset.status === 'ready') return { ...asset, sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) };
      const saved = { ...asset, status: 'local-only', uploadAttempts: 0, error: null, updatedAt: new Date().toISOString() };
      await run('UPDATE assets SET status=?,payload=? WHERE id=?', [saved.status, JSON.stringify(saved), id]);
      return { ...saved, sourceBase64: undefined, bytes: base64ToBytes(saved.sourceBase64) };
    })),
    listAssetProblems: () => serial(async () => (await rows("SELECT payload FROM assets WHERE status='error'"))
      .map(parse).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(assetProblem)),
    assetUploadSummary: () => serial(async () => {
      let waiting = 0, failed = 0;
      for (const row of await rows("SELECT payload FROM assets WHERE status IN ('local-only','error')")) {
        const asset = parse(row), entry = await getEntry(asset.entryId) ?? parse(await one('SELECT payload FROM drafts WHERE entry_id=?', [asset.entryId]))?.snapshot;
        if (!contentAssetIds(entry?.content).includes(asset.id)) continue;
        if (asset.status === 'error') failed++; else waiting++;
      }
      return { waiting, failed };
    }),
    storageSummary: () => serial(async () => (await rows('SELECT payload FROM assets')).map(parse).reduce((summary, asset) => {
      const bytes = Number.isInteger(asset.size) ? asset.size : 0;
      if (asset.cacheSource === 'remote' && asset.status === 'ready') { summary.cacheCount++; summary.cacheBytes += bytes; }
      else { summary.protectedCount++; summary.protectedBytes += bytes; }
      return summary;
    }, { cacheCount: 0, cacheBytes: 0, protectedCount: 0, protectedBytes: 0 })),
    clearDownloadedAssetCache: () => serial(() => transaction(async () => {
      const cached = (await rows('SELECT id,payload FROM assets')).map((row) => ({ id: row.id, asset: parse(row) }))
        .filter(({ asset }) => asset.cacheSource === 'remote' && asset.status === 'ready');
      for (const { id } of cached) await run('DELETE FROM assets WHERE id=?', [id]);
      return { clearedCount: cached.length, clearedBytes: cached.reduce((total, { asset }) => total + (Number.isInteger(asset.size) ? asset.size : 0), 0) };
    })),
    completeAssetUpload: (id, result) => serial(() => transaction(async () => {
      const asset = parse(await one('SELECT payload FROM assets WHERE id=?', [id])); if (!asset) throw new Error('本机图片已不存在');
      if (asset.status === 'ready') return { ...asset, sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) };
      const saved = { ...asset, status: 'ready', width: result.width, height: result.height, uploadAttempts: 0, error: null, updatedAt: new Date().toISOString() };
      await run('UPDATE assets SET status=?,payload=? WHERE id=?', [saved.status, JSON.stringify(saved), id]);
      return { ...saved, sourceBase64: undefined, bytes: base64ToBytes(saved.sourceBase64) };
    })),
    close: () => serial(async () => { await closeConnection(); closed = true; }),
  };
}
