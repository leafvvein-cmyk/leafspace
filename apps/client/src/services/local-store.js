import Dexie from 'dexie';
import { createUploadQueue } from './upload-queue.js';
import { keepCloud, saveMergeDraft } from './conflict-resolution.js';
import { conflictPage, validateConflictPage, makeConflictCopy } from './repository-shared.js';
import { createSyncMirror } from './sync-mirror.js';
import { validateEntry, hasContent, contentText } from '@diary/contracts';
import { validateLocalAsset, contentAssetIds, bytesToBase64, remapContentAssetIds, withoutContentAssets, assetUploadFailure, assetProblem } from './local-assets.js';
import { LocalConflictError, DailyExistsError, filterEntries, findDailyDraft, cloudEntry, mergeEntries, cloudBaseChanged, visibleRecord, isConfirmed } from './repository-shared.js';
import { validateTask, taskSort } from './task-model.js';
export { LocalConflictError, DailyExistsError } from './repository-shared.js';

/** Each namespace is a separate account or the explicitly isolated learning space. */
export function createLocalStore(namespace = 'learning') {
  const db = new Dexie(`diary-v2:${namespace}`);
  db.version(1).stores({
    entries: 'id,&dailyKey,entryDate,kind,updatedAt,deletedAt',
    drafts: 'entryId,updatedAt',
    outbox: 'id,entryId,status,createdAt',
    conflicts: 'id,entryId,createdAt',
    settings: 'key',
    assets: 'id,entryId,status',
  });
  db.version(2).stores({ cloudRecords: 'key', snapshotStage: 'key', syncState: 'key' });
  db.version(3).stores({ tasks: 'id,status,dueAt,updatedAt', taskOutbox: 'id,taskId,status,createdAt' });
  db.version(4).stores({ vaultConfig: 'key', vaultItems: 'id,updatedAt,deletedAt', vaultOutbox: 'id,itemId,status,createdAt' });
  const tables = { cloud: db.cloudRecords, stage: db.snapshotStage, state: db.syncState };
  const syncMirror = createSyncMirror(namespace, {
    atomic: (task) => db.transaction('rw', db.cloudRecords, db.snapshotStage, db.syncState, task),
    get: async (table, key) => (await tables[table].get(key))?.value,
    put: (table, key, value) => tables[table].put({ key, value }),
    remove: (table, key) => tables[table].delete(key),
    clear: (table) => tables[table].clear(),
    list: async (table) => (await tables[table].toArray()).map((row) => row.value),
    copy: async (from, to) => {
      let after = '';
      while (true) {
        const batch = await tables[from].where('key').above(after).limit(100).toArray();
        if (!batch.length) break;
        await tables[to].bulkPut(batch); after = batch.at(-1).key;
      }
    },
  });

  const cloudRecord = async (id) => (await db.cloudRecords.get(`entry:${id}`))?.value;
  const receiptFor = (id) => db.outbox.get(`receipt:${id}`);
  const snapshotPosition = async () => (await db.syncState.get('active'))?.value.snapshotPosition;
  const visibleEntry = async (id) => visibleRecord(await db.entries.get(id), await cloudRecord(id), await receiptFor(id), await snapshotPosition());
  const visibleEntries = async () => mergeEntries(await db.entries.toArray(), (await db.cloudRecords.toArray()).map((row) => row.value), await db.outbox.where('status').equals('acknowledged').toArray(), await snapshotPosition());
  const readVisible = (task) => db.transaction('r', db.entries, db.cloudRecords, db.outbox, db.drafts, db.syncState, task);
  const uploadQueue = createUploadQueue(namespace, {
    atomic: (task) => db.transaction('rw', db.entries, db.outbox, db.conflicts, db.cloudRecords, db.assets, task),
    jobs: () => db.outbox.toArray(), job: (id) => db.outbox.get(id),
    put: (job) => db.outbox.put(job), remove: (id) => db.outbox.delete(id),
    entry: (id) => db.entries.get(id), cloud: cloudRecord, conflict: (record) => db.conflicts.put(record),
    prepareAssetUpload: async (entry) => {
      const ids = contentAssetIds(entry.content); if (!ids.length) return { entry: structuredClone(entry), pendingAssets: 0 };
      const assets = await db.assets.bulkGet(ids);
      const pending = ids.filter((id, index) => assets[index]?.entryId !== entry.id || assets[index]?.status !== 'ready');
      return { entry: pending.length ? { ...entry, content: withoutContentAssets(entry.content, pending) } : structuredClone(entry), pendingAssets: pending.length };
    },
  });

  async function save(entry, expectedRevision = entry.localRevision) {
    validateEntry(entry, { allowEmpty: true });
    const snapshot = structuredClone(entry);
    return db.transaction('rw', db.entries, db.drafts, db.outbox, db.conflicts, db.cloudRecords, db.syncState, async () => {
      const currentEntry = await db.entries.get(entry.id);
      const current = currentEntry ?? (await db.drafts.get(entry.id))?.snapshot;
      const stamp = new Date().toISOString();
      const localRevision = current?.localRevision ?? 0;
      const remoteRecord = await cloudRecord(entry.id);
      const receipt = await receiptFor(entry.id);
      const view = visibleRecord(currentEntry, remoteRecord, receipt, await snapshotPosition());
      const remoteChanged = current?.localRetired ? !view || snapshot.revision !== view.revision : isConfirmed(currentEntry, receipt)
        ? !view || (snapshot.revision !== view.revision && snapshot.revision !== currentEntry.revision)
          || (snapshot.revision === currentEntry.revision && view.revision !== receipt.entry.revision)
        : !current && cloudBaseChanged(snapshot, remoteRecord);
      const conflict = current && localRevision !== expectedRevision || remoteChanged;
      const daily = snapshot.kind === 'daily' && !snapshot.deletedAt && hasContent(snapshot)
        ? (await visibleEntries()).find((item) => item.id !== snapshot.id && item.kind === 'daily' && !item.deletedAt && item.entryDate === snapshot.entryDate) : null;
      if (conflict || (daily && daily.id !== entry.id)) {
        // Persist the losing draft before returning a conflict; throwing inside this
        // transaction would also roll back the recovery copy.
        const remote = conflict ? (remoteChanged ? view : current) ?? cloudEntry(remoteRecord) ?? { id: entry.id, title: '云端记录已删除或当前不可用' } : daily;
        const conflictRecord = { id: crypto.randomUUID(), entryId: entry.id, local: snapshot, remote, createdAt: stamp };
        await db.conflicts.put(conflictRecord);
        return { conflict: conflict ? 'revision' : 'daily', current: remote, conflictRecord };
      }
      const base = (current?.localRetired || isConfirmed(currentEntry, receipt)) && view ? view : current;
      const saved = { ...snapshot, ...(base ? { revision: base.revision, syncBaseDeletedAt: base.syncBaseDeletedAt } : {}),
        localRevision: localRevision + 1, updatedAt: stamp, plainText: contentText(snapshot.content).trim() };
      delete saved.localRetired;
      delete saved.dailyKey;
      if (saved.kind === 'daily' && !saved.deletedAt && hasContent(saved)) saved.dailyKey = saved.entryDate;
      if (saved.dailyKey) {
        const indexed = await db.entries.where('dailyKey').equals(saved.dailyKey).first();
        // Logical uniqueness above has already passed. Release only an obsolete
        // index key belonging to a confirmed record moved/deleted in the cloud.
        if (indexed && indexed.id !== saved.id) { const retained = { ...indexed }; delete retained.dailyKey; await db.entries.put(retained); }
      }
      await db.drafts.put({ entryId: saved.id, snapshot: saved, updatedAt: stamp });
      if (hasContent(saved)) {
        await db.entries.put(saved);
        // This durable marker is not a server acknowledgement. M2/M3 materialize
        // immutable mutations from it when an authenticated account is connected.
        await db.outbox.put({ id: `draft:${saved.id}`, entryId: saved.id, status: 'local-only', createdAt: stamp });
      } else if (currentEntry || cloudEntry(remoteRecord)) {
        throw new Error('已保存的记录至少保留标题或正文；删除请移到回收站。');
      }
      return { entry: saved };
    }).then((result) => {
      if (result.conflict === 'revision') throw new LocalConflictError(result.current);
      if (result.conflict === 'daily') throw new DailyExistsError(result.current);
      return result.entry;
    });
  }

  return {
    db, namespace, save, syncMirror, uploadQueue, backend: 'indexeddb', close: () => db.close(),
    keepCloud: (id, options) => keepCloud({
      entries: visibleEntries, putJob: (job) => db.outbox.put(job),
      atomic: (task) => db.transaction('rw', db.entries, db.drafts, db.conflicts, db.outbox, db.cloudRecords, db.syncState, task),
      snapshotPending: async () => Boolean(await db.syncState.get('request') || await db.syncState.get('staging')),
      conflict: (key) => db.conflicts.get(key), local: async (key) => await db.entries.get(key) ?? (await db.drafts.get(key))?.snapshot,
      jobs: (key) => db.outbox.where('entryId').equals(key).toArray(), cloud: cloudRecord,
      retire: async (entry) => { await db.entries.put(entry); await db.drafts.put({ entryId: entry.id, snapshot: entry, updatedAt: entry.updatedAt }); },
      putCloud: (record) => db.cloudRecords.put({ key: `entry:${record.id}`, value: record }), removeJob: (key) => db.outbox.delete(key), putConflict: (record) => db.conflicts.put(record),
    }, id, options),
    saveMergeDraft: (id, entry, expectedRevision) => saveMergeDraft({
      atomic: (task) => db.transaction('rw', db.conflicts, task),
      conflict: (key) => db.conflicts.get(key), putConflict: (record) => db.conflicts.put(record),
    }, id, entry, expectedRevision),
    copyConflict: (id) => db.transaction('rw', db.conflicts, db.entries, db.drafts, db.outbox, db.assets, async () => {
      const record = await db.conflicts.get(id);
      if (!record) throw new Error('找不到这次冲突');
      if (record.copyEntryId) return { entryId: record.copyEntryId, reused: true };
      let copy = makeConflictCopy(record);
      const mapping = new Map(), clonedAssets = [];
      for (const assetId of contentAssetIds(copy.content)) {
        const asset = await db.assets.get(assetId);
        if (!asset || asset.entryId !== record.entryId) continue;
        const nextId = crypto.randomUUID(); mapping.set(assetId, nextId);
        clonedAssets.push({ ...asset, id: nextId, entryId: copy.id, uploadRequestId: crypto.randomUUID(), completeRequestId: crypto.randomUUID(),
          status: 'local-only', uploadAttempts: 0, error: null, updatedAt: new Date().toISOString() });
      }
      if (mapping.size) copy = { ...copy, content: remapContentAssetIds(copy.content, mapping) };
      await db.entries.add(copy);
      await db.drafts.add({ entryId: copy.id, snapshot: copy, updatedAt: copy.updatedAt });
      if (clonedAssets.length) await db.assets.bulkAdd(clonedAssets);
      await db.outbox.add({ id: `draft:${copy.id}`, entryId: copy.id, status: 'local-only', createdAt: copy.createdAt });
      await db.conflicts.put({ ...record, copyEntryId: copy.id, copyCreatedAt: copy.createdAt });
      return { entryId: copy.id, reused: false };
    }),
    async listConflicts({ before = null, limit = 20 } = {}) {
      validateConflictPage(before, limit);
      const query = before ? db.conflicts.where('id').below(before) : db.conflicts.orderBy('id');
      return conflictPage(await query.reverse().limit(limit + 1).toArray(), limit);
    },
    getConflict: (id) => db.transaction('r', db.conflicts, db.entries, db.drafts, async () => {
      const record = await db.conflicts.get(id);
      return record ? { record, latestLocal: await db.entries.get(record.entryId) ?? (await db.drafts.get(record.entryId))?.snapshot ?? null } : null;
    }),
    get: (id) => readVisible(() => visibleEntry(id)),
    draft: (id) => readVisible(async () => {
      const local = await db.entries.get(id), receipt = await receiptFor(id);
      if (local?.localRetired) return visibleRecord(local, await cloudRecord(id), receipt, await snapshotPosition());
      if (isConfirmed(local, receipt) && !visibleRecord(local, await cloudRecord(id), receipt, await snapshotPosition())) return undefined;
      return (await db.drafts.get(id))?.snapshot;
    }),
    dailyDraft: (date) => readVisible(async () => {
      const ids = new Set((await db.entries.toArray()).map((entry) => entry.id));
      return findDailyDraft((await db.drafts.toArray()).filter((draft) => !ids.has(draft.entryId)), date);
    }),
    day: (date) => readVisible(async () => (await visibleEntries()).filter((entry) => entry.entryDate === date && !entry.deletedAt).sort((a, b) => Number(b.localRevision > 0) - Number(a.localRevision > 0))),
    list: (filters = {}) => readVisible(async () => filterEntries(await visibleEntries(), filters)),
    async trash(id) {
      const entry = await readVisible(() => visibleEntry(id));
      if (!entry) throw new Error('找不到这篇日记');
      return save({ ...entry, deletedAt: new Date().toISOString(), purgeAfter: null });
    },
    async restore(id, overrides = {}) {
      const entry = await readVisible(() => visibleEntry(id));
      if (!entry) throw new Error('找不到这篇日记');
      return save({ ...entry, ...overrides, deletedAt: null, purgeAfter: null });
    },
    async exportLocal() {
      return db.transaction('r', db.entries, db.drafts, db.conflicts, db.assets, db.tasks, db.taskOutbox, async () => ({
        exportSchemaVersion: 3, source: namespace.startsWith('user:') ? 'account-local' : 'local-learning', namespace, exportedAt: new Date().toISOString(),
        entries: await db.entries.toArray(), drafts: await db.drafts.toArray(), conflicts: await db.conflicts.toArray(),
        assets: (await db.assets.toArray()).map((asset) => ({ ...asset, bytes: undefined, sourceBase64: bytesToBase64(asset.bytes) })),
        tasks: await db.tasks.toArray(), taskOutbox: await db.taskOutbox.toArray(),
      }));
    },
    getSetting: async (key, fallback) => (await db.settings.get(key))?.value ?? fallback,
    setSetting: (key, value) => db.settings.put({ key, value }),
    async saveTask(input, expectedRevision = input.localRevision ?? 0) {
      const snapshot = validateTask(input);
      return db.transaction('rw', db.tasks, db.taskOutbox, async () => {
        const current = await db.tasks.get(snapshot.id);
        if ((current?.localRevision ?? 0) !== expectedRevision) throw new Error('这个待办已在另一个窗口修改，请重新打开后再编辑');
        const stamp = new Date().toISOString();
        const saved = { ...snapshot, seriesId: snapshot.seriesId ?? snapshot.id, revision: current?.revision ?? snapshot.revision ?? '0',
          localRevision: expectedRevision + 1, createdAt: current?.createdAt ?? snapshot.createdAt ?? stamp, updatedAt: stamp };
        await db.tasks.put(saved);
        await db.taskOutbox.put({ id: `task:${saved.id}`, taskId: saved.id, status: 'local-only', createdAt: stamp, payload: structuredClone(saved) });
        return structuredClone(saved);
      });
    },
    async getTask(id) { const task = await db.tasks.get(id); return task ? structuredClone(task) : undefined; },
    async listTasks({ state = 'open' } = {}) {
      const tasks = state === 'all' ? await db.tasks.toArray() : await db.tasks.where('status').equals(state).toArray();
      return tasks.sort(taskSort).map((task) => structuredClone(task));
    },
    async setTaskStatus(id, status, expectedRevision) {
      const current = await db.tasks.get(id); if (!current) throw new Error('找不到这个待办');
      const stamp = new Date().toISOString();
      return this.saveTask({ ...current, status, completedAt: status === 'completed' ? stamp : null, deletedAt: status === 'trash' ? stamp : null }, expectedRevision ?? current.localRevision);
    },
    taskUploadCount: () => db.taskOutbox.where('status').equals('local-only').count(),
    async nextTaskSyncJob() {
      return db.transaction('rw', db.tasks, db.taskOutbox, async () => {
        const pending = (await db.taskOutbox.where('status').equals('pending').sortBy('createdAt'))[0]; if (pending) return structuredClone(pending);
        const marker = (await db.taskOutbox.where('status').equals('local-only').sortBy('createdAt'))[0]; if (!marker) return null;
        const task = await db.tasks.get(marker.taskId); if (!task) { await db.taskOutbox.delete(marker.id); return null; }
        const job = { id: `pending-task:${task.id}`, taskId: task.id, status: 'pending', createdAt: marker.createdAt, frozenAt: new Date().toISOString(),
          localRevision: task.localRevision, payload: structuredClone(task), requestIds: { create: crypto.randomUUID(), update: crypto.randomUUID(), actions: crypto.randomUUID(), restore: crypto.randomUUID(), state: crypto.randomUUID() } };
        await db.taskOutbox.put(job); await db.taskOutbox.delete(marker.id); return structuredClone(job);
      });
    },
    async completeTaskSyncJob(jobId, remote) {
      return db.transaction('rw', db.tasks, db.taskOutbox, async () => {
        const job = await db.taskOutbox.get(jobId); if (!job || job.status !== 'pending') throw new Error('待办同步请求已变化');
        const current = await db.tasks.get(job.taskId);
        if (current) await db.tasks.put(current.localRevision > job.localRevision
          ? { ...current, revision: remote.revision, seriesId: remote.seriesId ?? current.seriesId }
          : { ...structuredClone(remote), localRevision: current.localRevision });
        await db.taskOutbox.delete(jobId);
      });
    },
    async failTaskSyncJob(jobId, remote) {
      return db.transaction('rw', db.taskOutbox, async () => {
        const job = await db.taskOutbox.get(jobId); if (job?.status === 'pending') await db.taskOutbox.put({ ...job, status: 'conflict', remote: structuredClone(remote), failedAt: new Date().toISOString() });
      });
    },
    async applyTaskCloudItems(remotes) {
      return db.transaction('rw', db.tasks, db.taskOutbox, async () => {
        for (const remote of remotes) {
          const local = await db.tasks.get(remote.id), marker = await db.taskOutbox.get(`task:${remote.id}`), pending = await db.taskOutbox.get(`pending-task:${remote.id}`);
          if (!local) { await db.tasks.put({ ...structuredClone(remote), localRevision: 0 }); continue; }
          if (marker || pending) {
            if (local.revision !== remote.revision && pending?.status !== 'conflict') await db.taskOutbox.put({ ...(pending ?? { id: `pending-task:${remote.id}`, taskId: remote.id,
              requestIds: null, createdAt: new Date().toISOString(), localRevision: local.localRevision, payload: local }), status: 'conflict', remote: structuredClone(remote) });
            continue;
          }
          if (BigInt(remote.revision) >= BigInt(local.revision)) await db.tasks.put({ ...structuredClone(remote), localRevision: local.localRevision });
        }
      });
    },
    async taskSyncSummary() {
      const rows = await db.taskOutbox.toArray(); return { waiting: rows.filter((row) => ['local-only','pending'].includes(row.status)).length,
        conflicts: rows.filter((row) => row.status === 'conflict').length };
    },
    async listTaskConflicts() {
      const jobs = await db.taskOutbox.where('status').equals('conflict').toArray();
      return Promise.all(jobs.map(async (job) => ({ ...structuredClone(job), local: await db.tasks.get(job.taskId) })));
    },
    async resolveTaskConflict(jobId, choice) {
      if (!['local','cloud'].includes(choice)) throw new Error('请选择保留本机或云端版本');
      return db.transaction('rw', db.tasks, db.taskOutbox, async () => {
        const job = await db.taskOutbox.get(jobId); if (!job || job.status !== 'conflict' || !job.remote) throw new Error('找不到这次待办冲突');
        const current = await db.tasks.get(job.taskId); if (!current) throw new Error('本机待办已不存在');
        if (choice === 'cloud') { await db.tasks.put({ ...structuredClone(job.remote), localRevision: current.localRevision + 1 }); await db.taskOutbox.delete(`task:${job.taskId}`); }
        else {
          const saved = { ...current, revision: job.remote.revision, localRevision: current.localRevision + 1, updatedAt: new Date().toISOString() };
          await db.tasks.put(saved); await db.taskOutbox.put({ id: `task:${saved.id}`, taskId: saved.id, status: 'local-only', createdAt: saved.updatedAt, payload: saved });
        }
        await db.taskOutbox.delete(jobId);
      });
    },
    getVaultConfig: async () => (await db.vaultConfig.get('active'))?.value,
    async saveVaultConfig(config, expectedRevision = '0') {
      return db.transaction('rw', db.vaultConfig, db.vaultOutbox, async () => {
        if (await db.vaultOutbox.get('vault-key-rotation')) throw new Error('密码本正在轮换数据密钥，不能修改设置');
        const current = (await db.vaultConfig.get('active'))?.value;
        if ((current?.localRevision ?? 0) !== Number(expectedRevision)) throw new Error('密码本设置已在另一窗口修改');
        const saved = { ...structuredClone(config), revision: current?.revision ?? config.revision ?? '0',
          localRevision: Number(expectedRevision) + 1, updatedAt: new Date().toISOString() };
        await db.vaultConfig.put({ key: 'active', value: saved });
        await db.vaultOutbox.put({ id: 'vault-config', itemId: 'config', status: 'local-only', createdAt: saved.updatedAt, payload: saved });
        return structuredClone(saved);
      });
    },
    async saveVaultItem(input, expectedRevision = 0) {
      return db.transaction('rw', db.vaultItems, db.vaultOutbox, async () => {
        if (await db.vaultOutbox.get('vault-key-rotation')) throw new Error('密码本正在轮换数据密钥，不能修改账号记录');
        const current = await db.vaultItems.get(input.id);
        if ((current?.localRevision ?? 0) !== expectedRevision) throw new Error('这条账号记录已在另一窗口修改');
        const stamp = new Date().toISOString();
        const saved = { ...structuredClone(input), revision: current?.revision ?? '0', localRevision: expectedRevision + 1,
          createdAt: current?.createdAt ?? stamp, updatedAt: stamp, deletedAt: null };
        await db.vaultItems.put(saved);
        await db.vaultOutbox.put({ id: `vault:${saved.id}`, itemId: saved.id, status: 'local-only', createdAt: stamp, payload: saved });
        return structuredClone(saved);
      });
    },
    getVaultItem: async (id) => { const record = await db.vaultItems.get(id); return record && !record.deletedAt ? structuredClone(record) : undefined; },
    listVaultItems: async () => (await db.vaultItems.toArray()).filter((item) => !item.deletedAt).map((item) => structuredClone(item)),
    listAllVaultItems: async () => (await db.vaultItems.toArray()).map((item) => structuredClone(item)),
    getVaultKeyRotationJob: async () => structuredClone(await db.vaultOutbox.get('vault-key-rotation') ?? null),
    async prepareVaultKeyRotation(config, items) {
      return db.transaction('rw', db.vaultConfig, db.vaultItems, db.vaultOutbox, async () => {
        if (await db.vaultOutbox.count()) throw new Error('请先完成密码本同步或处理冲突，再轮换数据密钥');
        const currentConfig = (await db.vaultConfig.get('active'))?.value, currentItems = await db.vaultItems.orderBy('id').toArray();
        const candidates = [...items].sort((a, b) => a.id.localeCompare(b.id));
        const exact = currentConfig && currentConfig.localRevision === config.localRevision && currentConfig.revision === config.revision
          && currentItems.length === candidates.length && currentItems.every((item, index) => item.id === candidates[index].id
            && item.localRevision === candidates[index].localRevision && item.revision === candidates[index].revision);
        if (!exact) throw new Error('密码本已发生变化，请重新解锁并准备密钥轮换');
        const stamp = new Date().toISOString(), batchCount = Math.ceil(candidates.length / 50);
        const job = { id: 'vault-key-rotation', itemId: 'key-rotation', status: 'rotation-prepared', createdAt: stamp,
          startRequestId: crypto.randomUUID(), commitRequestId: crypto.randomUUID(), batchRequestIds: Array.from({ length: batchCount }, () => crypto.randomUUID()),
          baseConfigRevision: currentConfig.revision, config: structuredClone(config), items: structuredClone(candidates), rotationId: null };
        await db.vaultOutbox.put(job); return structuredClone(job);
      });
    },
    async activateVaultKeyRotation() {
      return db.transaction('rw', db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get('vault-key-rotation');
        if (!job || job.status !== 'rotation-prepared') throw new Error('找不到等待确认的数据密钥轮换');
        const saved = { ...job, status: 'rotation-ready', acknowledgedAt: new Date().toISOString() };
        await db.vaultOutbox.put(saved); return structuredClone(saved);
      });
    },
    async cancelPreparedVaultKeyRotation() {
      return db.transaction('rw', db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get('vault-key-rotation');
        if (job?.status === 'rotation-prepared') await db.vaultOutbox.delete(job.id);
      });
    },
    async bindVaultKeyRotation(rotationId) {
      return db.transaction('rw', db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get('vault-key-rotation');
        if (!job || job.status !== 'rotation-ready' || job.rotationId && job.rotationId !== rotationId) throw new Error('数据密钥轮换任务已变化');
        if (!job.rotationId) await db.vaultOutbox.put({ ...job, rotationId });
      });
    },
    async completeVaultKeyRotation(remote) {
      return db.transaction('rw', db.vaultConfig, db.vaultItems, db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get('vault-key-rotation'), currentConfig = (await db.vaultConfig.get('active'))?.value;
        if (!job || job.status !== 'rotation-ready' || job.rotationId !== remote?.rotation?.id) throw new Error('数据密钥轮换确认已变化');
        const currentItems = await db.vaultItems.orderBy('id').toArray(), currentById = new Map(currentItems.map((item) => [item.id, item]));
        const metadata = new Map((remote.items ?? []).map((item) => [item.id, item]));
        const exact = currentConfig?.revision === job.baseConfigRevision && currentConfig.localRevision === job.config.localRevision
          && currentItems.length === job.items.length && currentItems.every((item, index) => item.id === job.items[index].id
            && item.revision === job.items[index].revision && item.localRevision === job.items[index].localRevision && metadata.has(item.id));
        if (!exact || remote.config?.revision == null) throw new Error('本机密码本在轮换提交期间发生变化，请保持锁定并重新同步');
        const savedConfig = { ...job.config, revision: remote.config.revision, localRevision: currentConfig.localRevision + 1,
          updatedAt: remote.config.updatedAt };
        await db.vaultConfig.put({ key: 'active', value: savedConfig });
        for (const item of job.items) {
          const meta = metadata.get(item.id), current = currentById.get(item.id);
          await db.vaultItems.put({ ...item, revision: meta.revision, localRevision: current.localRevision + 1,
            updatedAt: meta.updatedAt, deletedAt: meta.deletedAt });
        }
        await db.vaultOutbox.delete(job.id); return structuredClone(savedConfig);
      });
    },
    async importVaultBackup(config, items) {
      return db.transaction('rw', db.vaultConfig, db.vaultItems, db.vaultOutbox, async () => {
        if (await db.vaultConfig.get('active') || await db.vaultItems.count()) throw new Error('当前空间已经有密码本，不能用备份覆盖');
        const stamp = new Date().toISOString(), savedConfig = { ...structuredClone(config), revision: '0', localRevision: 1, createdAt: stamp, updatedAt: stamp };
        await db.vaultConfig.put({ key: 'active', value: savedConfig });
        await db.vaultOutbox.put({ id: 'vault-config', itemId: 'config', status: 'local-only', createdAt: stamp, payload: savedConfig });
        for (const item of items) {
          const saved = { ...structuredClone(item), revision: '0', localRevision: 1, createdAt: stamp, updatedAt: stamp, deletedAt: null };
          await db.vaultItems.put(saved);
          await db.vaultOutbox.put({ id: `vault:${saved.id}`, itemId: saved.id, status: 'local-only', createdAt: stamp, payload: saved });
        }
      });
    },
    async deleteVaultItem(id, expectedRevision) {
      return db.transaction('rw', db.vaultItems, db.vaultOutbox, async () => {
        if (await db.vaultOutbox.get('vault-key-rotation')) throw new Error('密码本正在轮换数据密钥，不能删除账号记录');
        const current = await db.vaultItems.get(id); if (!current || current.deletedAt) throw new Error('找不到这条账号记录');
        if (current.localRevision !== expectedRevision) throw new Error('这条账号记录已在另一窗口修改');
        const stamp = new Date().toISOString(), saved = { ...current, localRevision: current.localRevision + 1, updatedAt: stamp, deletedAt: stamp };
        await db.vaultItems.put(saved);
        await db.vaultOutbox.put({ id: `vault:${id}`, itemId: id, status: 'local-only', createdAt: stamp,
          payload: { id, revision: saved.revision, localRevision: saved.localRevision, deletedAt: stamp } });
      });
    },
    async nextVaultSyncJob() {
      return db.transaction('rw', db.vaultConfig, db.vaultItems, db.vaultOutbox, async () => {
        const pending = (await db.vaultOutbox.where('status').equals('pending').sortBy('createdAt'))[0];
        if (pending) return structuredClone(pending);
        const markers = await db.vaultOutbox.where('status').equals('local-only').sortBy('createdAt');
        const marker = markers.sort((a, b) => Number(a.itemId !== 'config') - Number(b.itemId !== 'config'))[0];
        if (!marker) return null;
        const payload = marker.itemId === 'config' ? (await db.vaultConfig.get('active'))?.value : await db.vaultItems.get(marker.itemId);
        if (!payload) { await db.vaultOutbox.delete(marker.id); return null; }
        const job = { id: `pending:${marker.itemId}`, itemId: marker.itemId, status: 'pending', requestId: crypto.randomUUID(),
          createdAt: marker.createdAt, frozenAt: new Date().toISOString(), localRevision: payload.localRevision ?? 1, payload: structuredClone(payload) };
        await db.vaultOutbox.put(job); await db.vaultOutbox.delete(marker.id); return structuredClone(job);
      });
    },
    async completeVaultSyncJob(jobId, remote) {
      return db.transaction('rw', db.vaultConfig, db.vaultItems, db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get(jobId); if (!job || job.status !== 'pending') throw new Error('密码本同步请求已变化');
        if (job.itemId === 'config') {
          const row = await db.vaultConfig.get('active'); if (row) await db.vaultConfig.put({ key: 'active', value: { ...row.value, revision: remote.revision, updatedAt: remote.updatedAt } });
        } else {
          const current = await db.vaultItems.get(job.itemId);
          if (current) await db.vaultItems.put({ ...current, revision: remote.revision, updatedAt: current.localRevision > job.localRevision ? current.updatedAt : remote.updatedAt,
            deletedAt: current.localRevision > job.localRevision ? current.deletedAt : remote.deletedAt });
        }
        await db.vaultOutbox.delete(jobId);
      });
    },
    async failVaultSyncJob(jobId, remote) {
      return db.transaction('rw', db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get(jobId); if (!job || job.status !== 'pending') return;
        await db.vaultOutbox.put({ ...job, status: 'conflict', remote: structuredClone(remote), failedAt: new Date().toISOString() });
      });
    },
    async applyVaultCloudConfig(remote) {
      return db.transaction('rw', db.vaultConfig, db.vaultOutbox, async () => {
        const local = (await db.vaultConfig.get('active'))?.value;
        const dirty = await db.vaultOutbox.get('vault-config') || await db.vaultOutbox.get('pending:config');
        if (!local) { await db.vaultConfig.put({ key: 'active', value: { ...structuredClone(remote), localRevision: 0 } }); return 'applied'; }
        const same = ['salt','wrappedKey','wrapNonce','cryptoVersion','recoveryWrappedKey','recoveryNonce','recoveryVersion'].every((key) => local[key] === remote[key])
          && ['algorithm','memoryKiB','iterations','parallelism','hashLength'].every((key) => local.kdf?.[key] === remote.kdf?.[key]);
        if (same) { await db.vaultConfig.put({ key: 'active', value: { ...local, revision: remote.revision, updatedAt: remote.updatedAt } }); return 'confirmed'; }
        if (!dirty) await db.vaultOutbox.put({ id: 'pending:config', itemId: 'config', status: 'conflict', requestId: null,
          createdAt: new Date().toISOString(), localRevision: local.localRevision ?? 1, payload: local, remote: structuredClone(remote) });
        return 'conflict';
      });
    },
    async applyVaultCloudItems(remotes) {
      return db.transaction('rw', db.vaultItems, db.vaultOutbox, async () => {
        for (const remote of remotes) {
          const local = await db.vaultItems.get(remote.id), marker = await db.vaultOutbox.get(`vault:${remote.id}`), pending = await db.vaultOutbox.get(`pending:${remote.id}`);
          if (!local) { await db.vaultItems.put({ ...structuredClone(remote), localRevision: 0 }); continue; }
          if (marker || pending) {
            if (local.revision !== remote.revision && pending?.status !== 'conflict') await db.vaultOutbox.put({ ...(pending ?? { id: `pending:${remote.id}`, itemId: remote.id,
              requestId: null, createdAt: new Date().toISOString(), localRevision: local.localRevision, payload: local }), status: 'conflict', remote: structuredClone(remote) });
            continue;
          }
          if (BigInt(remote.revision) >= BigInt(local.revision)) await db.vaultItems.put({ ...structuredClone(remote), localRevision: local.localRevision });
        }
      });
    },
    async vaultSyncSummary() {
      const rows = await db.vaultOutbox.toArray();
      const summary = { waiting: rows.filter((row) => ['local-only','pending','rotation-ready'].includes(row.status)).length,
        conflicts: rows.filter((row) => row.status === 'conflict').length };
      if (rows.some((row) => row.status === 'rotation-prepared')) summary.rotationPrepared = true;
      return summary;
    },
    async listVaultConflicts() {
      const jobs = await db.vaultOutbox.where('status').equals('conflict').toArray();
      return Promise.all(jobs.map(async (job) => ({ ...structuredClone(job), local: job.itemId === 'config'
        ? (await db.vaultConfig.get('active'))?.value : await db.vaultItems.get(job.itemId) })));
    },
    async resolveVaultConflict(jobId, choice) {
      if (!['local','cloud'].includes(choice)) throw new Error('请选择保留本机或云端版本');
      return db.transaction('rw', db.vaultItems, db.vaultOutbox, async () => {
        const job = await db.vaultOutbox.get(jobId); if (!job || job.status !== 'conflict') throw new Error('找不到这次密码本冲突');
        if (job.itemId === 'config') throw new Error('保险库密钥设置冲突不能自动处理，请保留两台设备并联系支持');
        const current = await db.vaultItems.get(job.itemId); if (!current || !job.remote) throw new Error('冲突内容不完整，不能自动覆盖');
        if (choice === 'cloud') {
          await db.vaultItems.put({ ...structuredClone(job.remote), localRevision: current.localRevision + 1 });
          await db.vaultOutbox.delete(`vault:${job.itemId}`);
        } else {
          const saved = { ...current, revision: job.remote.revision, localRevision: current.localRevision + 1, updatedAt: new Date().toISOString() };
          await db.vaultItems.put(saved);
          await db.vaultOutbox.put({ id: `vault:${job.itemId}`, itemId: job.itemId, status: 'local-only', createdAt: saved.updatedAt, payload: saved });
        }
        await db.vaultOutbox.delete(jobId);
      });
    },
    async saveAsset(input) {
      const asset = validateLocalAsset(input), existing = await db.assets.get(asset.id);
      if (existing && (existing.entryId !== asset.entryId || existing.sha256 !== asset.sha256 || existing.size !== asset.size)) throw new Error('图片标识已被另一份内容使用');
      const saved = { ...asset, status: existing?.status ?? asset.status, uploadAttempts: existing?.uploadAttempts ?? asset.uploadAttempts ?? 0,
        error: existing?.error ?? asset.error ?? null, uploadRequestId: existing?.uploadRequestId ?? asset.uploadRequestId ?? crypto.randomUUID(),
        completeRequestId: existing?.completeRequestId ?? asset.completeRequestId ?? crypto.randomUUID(), updatedAt: new Date().toISOString() };
      await db.assets.put(saved); return structuredClone(saved);
    },
    async getAsset(id) { const asset = await db.assets.get(id); return asset ? structuredClone(asset) : undefined; },
    async listAssets(entryId) { return (await db.assets.where('entryId').equals(entryId).toArray()).map((asset) => structuredClone(asset)); },
    async nextAssetUpload() {
      return db.transaction('r', db.assets, db.entries, db.drafts, async () => {
        for (const asset of await db.assets.where('status').equals('local-only').toArray()) {
          const entry = await db.entries.get(asset.entryId) ?? (await db.drafts.get(asset.entryId))?.snapshot;
          if (contentAssetIds(entry?.content).includes(asset.id)) return structuredClone(asset);
        }
      });
    },
    async recordAssetUploadFailure(id, error) {
      return db.transaction('rw', db.assets, async () => {
        const asset = await db.assets.get(id); if (!asset) throw new Error('本机图片已不存在');
        if (asset.status === 'ready') return structuredClone(asset);
        const saved = assetUploadFailure(asset, error);
        await db.assets.put(saved); return structuredClone(saved);
      });
    },
    async retryAssetUpload(id) {
      return db.transaction('rw', db.assets, async () => {
        const asset = await db.assets.get(id); if (!asset) throw new Error('本机图片已不存在');
        if (asset.status === 'ready') return structuredClone(asset);
        const saved = { ...asset, status: 'local-only', uploadAttempts: 0, error: null, updatedAt: new Date().toISOString() };
        await db.assets.put(saved); return structuredClone(saved);
      });
    },
    async listAssetProblems() {
      return (await db.assets.where('status').equals('error').toArray())
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map(assetProblem);
    },
    async assetUploadSummary() {
      return db.transaction('r', db.assets, db.entries, db.drafts, async () => {
        let waiting = 0, failed = 0;
        for (const asset of await db.assets.where('status').anyOf('local-only', 'error').toArray()) {
          const entry = await db.entries.get(asset.entryId) ?? (await db.drafts.get(asset.entryId))?.snapshot;
          if (!contentAssetIds(entry?.content).includes(asset.id)) continue;
          if (asset.status === 'error') failed++; else waiting++;
        }
        return { waiting, failed };
      });
    },
    async storageSummary() {
      const assets = await db.assets.toArray();
      return assets.reduce((summary, asset) => {
        const bytes = Number.isInteger(asset.size) ? asset.size : asset.bytes?.byteLength ?? 0;
        if (asset.cacheSource === 'remote' && asset.status === 'ready') { summary.cacheCount++; summary.cacheBytes += bytes; }
        else { summary.protectedCount++; summary.protectedBytes += bytes; }
        return summary;
      }, { cacheCount: 0, cacheBytes: 0, protectedCount: 0, protectedBytes: 0 });
    },
    async clearDownloadedAssetCache() {
      return db.transaction('rw', db.assets, async () => {
        const cached = (await db.assets.toArray()).filter((asset) => asset.cacheSource === 'remote' && asset.status === 'ready');
        if (cached.length) await db.assets.bulkDelete(cached.map((asset) => asset.id));
        return { clearedCount: cached.length, clearedBytes: cached.reduce((total, asset) => total + (Number.isInteger(asset.size) ? asset.size : asset.bytes?.byteLength ?? 0), 0) };
      });
    },
    async completeAssetUpload(id, result) {
      return db.transaction('rw', db.assets, async () => {
        const asset = await db.assets.get(id); if (!asset) throw new Error('本机图片已不存在');
        if (asset.status === 'ready') return structuredClone(asset);
        const saved = { ...asset, status: 'ready', width: result.width, height: result.height, uploadAttempts: 0, error: null, updatedAt: new Date().toISOString() };
        await db.assets.put(saved); return structuredClone(saved);
      });
    },
  };
}
