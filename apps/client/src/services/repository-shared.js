import { includesPosition } from './sync-position.js';
import { makeDraft, validateEntry, contentText } from '@diary/contracts';

export function makeConflictCopy(record) {
  if (!record?.local) throw new Error('没有可另存的本机稿，请先导出备份。');
  const source = record.local;
  const copy = { ...makeDraft({ kind: 'moment', entryDate: source.entryDate }),
    timezone: source.timezone, title: source.title, contentSchemaVersion: source.contentSchemaVersion,
    content: structuredClone(source.content), tags: structuredClone(source.tags), mood: source.mood, localRevision: 1 };
  validateEntry(copy);
  copy.plainText = contentText(copy.content).trim();
  return copy;
}

export class LocalConflictError extends Error {
  constructor(current) {
    super('另一个窗口或云端已有不同版本。你的草稿已保留，请先处理版本。');
    this.name = 'LocalConflictError';
    this.current = current;
  }
}

// Cloud revisions remain the future upload base; localRevision counts device edits only.
export function cloudEntry(record) {
  if (record?.entity !== 'entry' || record.purged) return undefined;
  return { ...structuredClone(record.value), localRevision: 0, syncBaseDeletedAt: Boolean(record.value.deletedAt) };
}

export function isConfirmed(local, receipt) {
  return Boolean(local && receipt?.fullyConfirmed && receipt.localRevision === local.localRevision);
}

export function conflictPage(rows, limit) {
  const items = rows.slice(0, limit).map((record) => ({ id: record.id, entryId: record.entryId,
    title: record.local?.title || '无标题记录', createdAt: record.createdAt, source: record.source ?? 'local',
    resolutionKind: record.resolution?.kind ?? null, resolvedAt: record.resolution?.at ?? null,
    copyEntryId: record.copyEntryId ?? null,
    code: record.error?.code ?? 'LOCAL_CONFLICT' }));
  return { items, hasMore: rows.length > limit, nextCursor: rows.length > limit ? items.at(-1).id : null };
}
export function validateConflictPage(before, limit) {
  if (before !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(before)) throw new Error('冲突分页位置无效');
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('冲突分页数量无效');
}

export function visibleRecord(local, record, receipt, snapshotPosition) {
  if (local?.localRetired) {
    const remote = cloudEntry(record);
    return remote ? { ...remote, localRevision: local.localRevision } : undefined;
  }
  if (!local) return cloudEntry(record);
  if (!isConfirmed(local, receipt)) return local;
  if (!record && includesPosition(snapshotPosition, receipt.syncPosition)) return undefined;
  const newerCloud = record && BigInt(record.value.revision) >= BigInt(receipt.entry.revision);
  if (newerCloud && record.purged) return undefined;
  const entry = newerCloud ? record.value : receipt.entry;
  return { ...structuredClone(entry), localRevision: local.localRevision, syncBaseDeletedAt: Boolean(entry.deletedAt) };
}

export function mergeEntries(local, records, receipts = [], snapshotPosition) {
  const merged = new Map();
  const cloud = new Map(records.filter((record) => record.entity === 'entry').map((record) => [record.id, record]));
  const acknowledgements = new Map(receipts.filter((row) => row.status === 'acknowledged').map((row) => [row.entryId, row]));
  for (const record of records) {
    const entry = cloudEntry(record);
    if (entry) merged.set(entry.id, entry);
  }
  // A remote deletion does not delete unsent work on this device.
  for (const entry of local) {
    const visible = visibleRecord(entry, cloud.get(entry.id), acknowledgements.get(entry.id), snapshotPosition);
    if (visible) merged.set(entry.id, visible);
    else merged.delete(entry.id);
  }
  return [...merged.values()];
}

export function cloudBaseChanged(snapshot, record) {
  if (record?.purged) return true;
  if (record) return snapshot.revision !== record.value.revision;
  return snapshot.revision != null && snapshot.revision !== '0';
}

export class DailyExistsError extends Error {
  constructor(current) {
    super('这一天已有日记，你的草稿已保留。');
    this.name = 'DailyExistsError';
    this.current = current;
  }
}

export function filterEntries(entries, { state = 'active', q = '', kind, mood, tag, from, to } = {}) {
  const needle = q.normalize('NFKC').toLocaleLowerCase();
  return entries.filter((entry) => {
    if ((state === 'trash') !== Boolean(entry.deletedAt)) return false;
    if (kind && entry.kind !== kind) return false;
    if (mood && entry.mood !== Number(mood)) return false;
    if (tag && !entry.tags.some((item) => item.name === tag)) return false;
    if (from && entry.entryDate < from || to && entry.entryDate > to) return false;
    const text = `${entry.title}\n${entry.plainText}\n${entry.tags.map((item) => item.name).join(' ')}`;
    return !needle || text.normalize('NFKC').toLocaleLowerCase().includes(needle);
  }).sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function findDailyDraft(drafts, date) {
  return drafts.map((draft) => draft.snapshot).filter((draft) => draft.kind === 'daily' && draft.entryDate === date && !draft.deletedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0];
}
