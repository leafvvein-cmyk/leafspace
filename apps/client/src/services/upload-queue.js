import { validateEntry, hasContent } from '@diary/contracts';
import { validPosition } from './sync-position.js';

export function uploadPayload(entry) {
  return { kind: entry.kind, entryDate: entry.entryDate, timezone: entry.timezone, occurredAt: entry.occurredAt,
    title: entry.title, contentSchemaVersion: entry.contentSchemaVersion, content: structuredClone(entry.content), mood: entry.mood,
    tags: entry.tags.map((tag) => ({ name: tag.name })) };
}
const comparable = (entry) => ({ ...uploadPayload(entry),
  occurredAt: entry.occurredAt ? new Date(entry.occurredAt).toISOString() : null,
  tags: [...new Set(entry.tags.map((tag) => tag.name.trim().normalize('NFKC').toLowerCase()))].sort() });
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const sameContent = (a, b) => JSON.stringify(canonical(comparable(a))) === JSON.stringify(canonical(comparable(b)));
const revision = (value) => typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;

// Adapter transactions cover outbox, entries, cloud records and conflicts.
// Never mutate a persisted request. A later edit remains a separate draft marker.
export function createUploadQueue(namespace, adapter) {
  const atomic = (task) => {
    if (!/^user:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(namespace)) throw new Error('学习空间不能上传账号数据');
    return adapter.atomic(task);
  };
  return {
    summary: ({ generation } = {}) => atomic(async () => {
      const rows = await adapter.jobs(), receipts = new Map(rows.filter((row) => row.status === 'acknowledged').map((row) => [row.entryId, row]));
      const pending = new Set(rows.filter((row) => row.status === 'pending').map((row) => row.entryId));
      const blocked = new Set(rows.filter((row) => ['conflict', 'rejected'].includes(row.status)).map((row) => row.entryId));
      let waiting = 0, localTrash = 0, unverified = 0;
      for (const receipt of receipts.values()) {
        if (!validPosition(receipt.syncPosition) || !generation || receipt.syncPosition.generation !== generation) unverified++;
      }
      for (const row of rows.filter((job) => job.status === 'local-only')) {
        if (pending.has(row.entryId) || blocked.has(row.entryId)) continue;
        const entry = await adapter.entry(row.entryId);
        if (entry?.deletedAt && entry.revision === '0' && !receipts.has(entry.id)) localTrash++;
        else waiting++;
      }
      return { pending: pending.size, waiting, blocked: blocked.size, localTrash, unverified };
    }),
    next: () => atomic(async () => {
      const rows = await adapter.jobs();
      const pending = rows.find((row) => row.status === 'pending' && row.mutation);
      if (pending) return structuredClone(pending);
      const blocked = new Set(rows.filter((row) => ['conflict', 'rejected'].includes(row.status)).map((row) => row.entryId));
      for (const marker of rows.filter((row) => row.status === 'local-only' && row.id.startsWith('draft:'))) {
        if (blocked.has(marker.entryId)) continue;
        const local = await adapter.entry(marker.entryId);
        if (!local || !hasContent(local)) continue;
        const prepared = adapter.prepareAssetUpload ? await adapter.prepareAssetUpload(local) : { entry: local, pendingAssets: 0 };
        const uploadEntry = prepared.entry;
        const pendingAssets = prepared.pendingAssets;
        if (!hasContent(uploadEntry) && !local.deletedAt) continue;
        validateEntry(uploadEntry, { allowEmpty: Boolean(local.deletedAt) });
        const receipt = await adapter.job(`receipt:${local.id}`);
        const cloud = await adapter.cloud(local.id);
        const confirmedBase = receipt && BigInt(receipt.entry.revision) >= BigInt(local.revision) ? receipt.entry : null;
        const base = confirmedBase ?? (cloud && !cloud.purged && cloud.value.revision === local.revision ? cloud.value : null);
        const baseRevision = base?.revision ?? local.revision;
        if (!revision(baseRevision)) throw new Error('上传基线版本无效');
        // Unsent local trash stays local; do not publish it merely to delete it.
        if (local.deletedAt && baseRevision === '0') continue;
        const wasTrashed = base ? Boolean(base.deletedAt) : Boolean(local.syncBaseDeletedAt);
        let operation = 'upsert', payload = uploadPayload(uploadEntry);
        if (wasTrashed && !local.deletedAt) {
          operation = 'restore';
          payload = { kind: local.kind, entryDate: local.entryDate, timezone: local.timezone, occurredAt: local.occurredAt };
        } else if (local.deletedAt && base && sameContent(uploadEntry, base)) {
          operation = 'trash'; payload = {};
        }
        if (operation === 'upsert' && base && sameContent(uploadEntry, base) && Boolean(local.deletedAt) === Boolean(base.deletedAt)) {
          if (pendingAssets) continue;
          if (sameContent(local, base)) {
            if (receipt) await adapter.put({ ...receipt, localRevision: local.localRevision, fullyConfirmed: true });
            await adapter.remove(marker.id);
          }
          continue;
        }
        const mutationId = crypto.randomUUID();
        const job = { id: `mutation:${mutationId}`, entryId: local.id, status: 'pending', createdAt: new Date().toISOString(),
          localRevision: local.localRevision, snapshot: structuredClone(local),
          pendingAssets, mutation: { mutationId, entryId: local.id, baseRevision, operation, payload } };
        await adapter.put(job); return structuredClone(job);
      }
      return null;
    }),
    complete: (mutationId, result) => atomic(async () => {
      const job = await adapter.job(`mutation:${mutationId}`);
      if (!job || job.status !== 'pending') return { status: 'ignored' };
      if (result?.mutationId !== mutationId || !['applied', 'replayed', 'conflict', 'rejected'].includes(result.status)) throw new Error('上传确认格式无效');
      if (['conflict', 'rejected'].includes(result.status)) {
        if (typeof result.error?.code !== 'string') throw new Error('上传失败结果无效');
        await adapter.put({ ...job, status: result.status, result: structuredClone(result) });
        await adapter.conflict({ id: mutationId, entryId: job.entryId, local: job.snapshot,
          remote: result.error.details?.currentEntry ?? null, error: structuredClone(result.error), createdAt: new Date().toISOString(), source: 'upload' });
        return { status: result.status };
      }
      const entry = result.entry;
      if (entry?.id !== job.entryId || !revision(entry.revision) || BigInt(entry.revision) < BigInt(job.mutation.baseRevision) || entry.revision === '0') throw new Error('上传确认版本或记录编号无效');
      validateEntry(entry);
      if (result.syncPosition != null && !validPosition(result.syncPosition)) throw new Error('上传确认同步序号无效');
      const previous = await adapter.job(`receipt:${job.entryId}`);
      if (previous && BigInt(previous.entry.revision) > BigInt(entry.revision)) throw new Error('上传确认版本倒退');
      const local = await adapter.entry(job.entryId);
      const fullyConfirmed = local && local.localRevision === job.localRevision && sameContent(local, entry)
        && Boolean(local.deletedAt) === Boolean(entry.deletedAt);
      await adapter.put({ id: `receipt:${job.entryId}`, entryId: job.entryId, status: 'acknowledged', createdAt: new Date().toISOString(),
        mutationId, localRevision: job.localRevision, entry: structuredClone(entry), fullyConfirmed: Boolean(fullyConfirmed),
        syncPosition: result.syncPosition ? structuredClone(result.syncPosition) : null });
      await adapter.remove(job.id);
      if (fullyConfirmed) await adapter.remove(`draft:${job.entryId}`);
      // No writes to entries/drafts: a late response can never replace newer text.
      return { status: fullyConfirmed ? 'acknowledged' : 'more-local-work' };
    }),
  };
}
