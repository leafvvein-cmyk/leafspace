import { validateEntry } from '@diary/contracts';
import { validPosition } from './sync-position.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const cursor = (value) => typeof value === 'string' && value.length > 0 && value.length <= 3000;
const revision = (value) => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const rebuild = () => Object.assign(new Error('云端历史需要重新下载快照，本机稿保持不变'), { code: 'SYNC_RESNAPSHOT_REQUIRED' });
export function createSyncMirror(namespace, adapter) {
  const owner = namespace.startsWith('user:') ? namespace.slice(5) : '';
  function account() { if (!uuid.test(owner)) throw new Error('学习空间不能接收账号云端数据'); }
  function validate(record) {
    if (!record || !['entry', 'tag', 'profile', 'settings'].includes(record.entity) || !uuid.test(record.id)
      || !record.value || !revision(record.value.revision)) throw new Error('云端记录格式无效');
    if (['profile', 'settings'].includes(record.entity) && record.id !== owner) throw new Error('云端记录账号不一致');
    if (record.entity !== 'settings' && record.value.id !== record.id) throw new Error('云端记录编号不一致');
    if (record.entity === 'entry') validateEntry(record.value);
    if (record.entity === 'tag' && (typeof record.value.name !== 'string' || !record.value.name.trim())) throw new Error('云端标签无效');
    return `${record.entity}:${record.id}`;
  }
  const atomic = (task) => { account(); return adapter.atomic(task); };
  return {
    state: () => atomic(async () => ({ active: await adapter.get('state', 'active') ?? null, staging: await adapter.get('state', 'staging') ?? null, request: await adapter.get('state', 'request') ?? null })),
    requestSnapshot: () => atomic(async () => {
      const existing = await adapter.get('state', 'request');
      if (existing) return existing;
      const request = { requestId: crypto.randomUUID(), snapshotId: null };
      await adapter.put('state', 'request', request); return request;
    }),
    bindSnapshot: (requestId, snapshotId) => atomic(async () => {
      const request = await adapter.get('state', 'request');
      if (!uuid.test(snapshotId) || request?.requestId !== requestId || request.snapshotId && request.snapshotId !== snapshotId) throw new Error('快照请求已改变');
      request.snapshotId = snapshotId; await adapter.put('state', 'request', request); return request;
    }),
    resetRequest: (requestId, { restart = false } = {}) => atomic(async () => {
      const request = await adapter.get('state', 'request');
      if (request?.requestId !== requestId) throw new Error('快照请求已改变');
      if (restart) await adapter.put('state', 'request', { requestId: crypto.randomUUID(), snapshotId: null });
      else await adapter.remove('state', 'request');
      // Only disposable download staging is removed, never the active mirror.
      await adapter.clear('stage'); await adapter.remove('state', 'staging');
    }),
    records: () => atomic(() => adapter.list('cloud')),
    applyChanges: (expectedCursor, page) => atomic(async () => {
      const active = await adapter.get('state', 'active');
      if (!active || active.cursor !== expectedCursor || await adapter.get('state', 'staging') || await adapter.get('state', 'request')) {
        throw Object.assign(new Error('同步位置已改变，请重新读取本机状态'), { code: 'SYNC_POSITION_CHANGED' });
      }
      if (!page || !Array.isArray(page.events) || page.events.length > 100 || typeof page.hasMore !== 'boolean'
        || !cursor(page.nextCursor) || page.hasMore && (!page.events.length || page.nextCursor === expectedCursor)) throw new Error('增量分页格式无效');
      let last = active.lastSeq ?? null, previous = null;
      for (const event of page.events) {
        if (!event || !revision(event.seq) || previous !== null && BigInt(event.seq) <= BigInt(previous)) throw new Error('增量事件顺序无效');
        previous = event.seq;
        if (event.type === 'resnapshot_required') throw rebuild();
        if (event.type !== 'transaction' || !Array.isArray(event.changes) || !event.changes.length) throw new Error('增量事件格式无效');
        if (last !== null && BigInt(event.seq) <= BigInt(last)) continue;
        if (last !== null && BigInt(event.seq) !== BigInt(last) + 1n) throw rebuild();
        for (const change of event.changes) {
          let record, key;
          if (change?.action === 'upsert') {
            record = { entity: change.entity, id: change.id, value: structuredClone(change.value) }; key = validate(record);
          } else if (change?.action === 'purge' && ['entry', 'tag'].includes(change.entity) && uuid.test(change.id) && revision(change.revision)) {
            // Keep only a tombstone, never a purged body. Local drafts are separate.
            record = { entity: change.entity, id: change.id, purged: true, value: { revision: change.revision } };
            key = `${change.entity}:${change.id}`;
          } else throw new Error('增量操作类型无效');
          const current = await adapter.get('cloud', key);
          if (current && BigInt(current.value.revision) >= BigInt(record.value.revision)) continue;
          if (current?.purged && !record.purged) throw rebuild();
          await adapter.put('cloud', key, record);
        }
        last = event.seq;
      }
      const next = { ...active, cursor: page.nextCursor, lastSeq: last, updatedAt: new Date().toISOString() };
      await adapter.put('state', 'active', next);
      return next;
    }),
    begin: ({ snapshotId, recordCount }) => atomic(async () => {
      if (!uuid.test(snapshotId) || !Number.isSafeInteger(recordCount) || recordCount < 0) throw new Error('快照描述无效');
      const existing = await adapter.get('state', 'staging');
      if (existing?.snapshotId === snapshotId) {
        if (existing.expectedCount !== recordCount) throw new Error('快照总数发生变化');
        return existing;
      }
      await adapter.clear('stage');
      const state = { snapshotId, expectedCount: recordCount, received: 0, nextPageCursor: null, complete: false, baselineCursor: null };
      await adapter.put('state', 'staging', state); return state;
    }),
    append: (snapshotId, expectedCursor, page) => atomic(async () => {
      const state = await adapter.get('state', 'staging');
      if (!state || state.snapshotId !== snapshotId || state.complete || state.nextPageCursor !== expectedCursor) throw new Error('快照下载位置已改变');
      if (!page || !Array.isArray(page.records) || page.records.length > 100 || typeof page.hasMore !== 'boolean'
        || page.hasMore && (!cursor(page.nextPageCursor) || page.nextPageCursor === expectedCursor || page.baselineCursor !== null || !page.records.length)
        || !page.hasMore && (page.nextPageCursor !== null || !cursor(page.baselineCursor))) throw new Error('快照分页格式无效');
      if (page.snapshotPosition != null && (page.hasMore || !validPosition(page.snapshotPosition))) throw new Error('快照同步序号无效');
      for (const raw of page.records) {
        const record = structuredClone(raw), key = validate(record);
        if (await adapter.get('stage', key)) throw new Error('快照中出现重复记录');
        await adapter.put('stage', key, record);
      }
      state.received += page.records.length;
      if (state.received > state.expectedCount || !page.hasMore && state.received !== state.expectedCount) throw new Error('快照记录数量不一致');
      state.nextPageCursor = page.nextPageCursor; state.complete = !page.hasMore; state.baselineCursor = page.baselineCursor;
      state.snapshotPosition = page.snapshotPosition ?? null;
      await adapter.put('state', 'staging', state); return state;
    }),
    commit: (snapshotId) => atomic(async () => {
      const state = await adapter.get('state', 'staging');
      if (!state || state.snapshotId !== snapshotId || !state.complete || state.received !== state.expectedCount || !cursor(state.baselineCursor)) throw new Error('快照尚未完整下载');
      await adapter.clear('cloud');
      await adapter.copy('stage', 'cloud');
      const active = { snapshotId, cursor: state.baselineCursor, updatedAt: new Date().toISOString() };
      if (state.snapshotPosition) { active.snapshotPosition = state.snapshotPosition; active.lastSeq = state.snapshotPosition.seq; }
      await adapter.put('state', 'active', active);
      await adapter.clear('stage'); await adapter.remove('state', 'staging');
      const request = await adapter.get('state', 'request');
      if (request?.snapshotId === snapshotId) await adapter.remove('state', 'request');
      return active;
    }),
  };
}
