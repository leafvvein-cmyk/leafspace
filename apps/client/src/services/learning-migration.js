import { hasContent, validateEntry } from '@diary/contracts';
import { base64ToBytes, contentAssetIds, remapContentAssetIds } from './local-assets.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT = 'learning-space-migration-v1';

function meaningful(entry) {
  return hasContent(entry) || entry.mood !== null || entry.tags?.length || entry.deletedAt;
}

function version(entry) {
  return `${entry.localRevision ?? 0}:${entry.updatedAt ?? ''}:${entry.deletedAt ?? ''}`;
}

export function migrationEntries(backup) {
  if (!backup || backup.source !== 'local-learning' || backup.namespace !== 'learning' || !Array.isArray(backup.entries) || !Array.isArray(backup.drafts)) {
    throw new Error('学习空间备份格式无效');
  }
  const entries = new Map();
  for (const entry of backup.entries) {
    if (!UUID.test(entry?.id ?? '')) throw new Error('学习空间记录编号无效');
    validateEntry(entry, { allowEmpty: true }); entries.set(entry.id, structuredClone(entry));
  }
  for (const draft of backup.drafts) {
    const entry = draft?.snapshot;
    if (!entry || entries.has(entry.id) || !meaningful(entry)) continue;
    if (!UUID.test(entry.id)) throw new Error('学习空间草稿编号无效');
    validateEntry(entry, { allowEmpty: true }); entries.set(entry.id, structuredClone(entry));
  }
  return [...entries.values()].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.id.localeCompare(b.id));
}

export function previewLearningBackup(backup) {
  const entries = migrationEntries(backup), assets = Array.isArray(backup.assets) ? backup.assets : [];
  return { total: entries.length, active: entries.filter((entry) => !entry.deletedAt && hasContent(entry)).length,
    trash: entries.filter((entry) => entry.deletedAt).length, drafts: entries.filter((entry) => !hasContent(entry)).length,
    images: assets.length, entries };
}

function cleanCopy(source, id, content) {
  const copy = { ...structuredClone(source), id, content, revision: '0', localRevision: 0, purgeAfter: null,
    updatedAt: new Date().toISOString(), tags: source.tags.map((tag) => ({ name: tag.name })) };
  delete copy.dailyKey; delete copy.localRetired; delete copy.plainText; delete copy.syncBaseDeletedAt;
  validateEntry(copy, { allowEmpty: true }); return copy;
}

export async function copyLearningSpace({ source, target, idFactory = () => crypto.randomUUID(), onProgress = () => {} }) {
  if (!source || !target || source.namespace !== 'learning' || !target.namespace?.startsWith('user:')) throw new Error('只能把独立学习空间复制到已登录账号空间');
  const backup = await source.exportLocal(), preview = previewLearningBackup(backup);
  const previous = await target.getSetting(RECEIPT, { versions: {}, completed: {}, pending: null });
  const changed = preview.entries.filter((entry) => previous.versions?.[entry.id] !== version(entry));
  if (!changed.length) return { copied: 0, conflicts: 0, missingImages: 0, skipped: preview.total, reused: true };
  let receipt = previous.pending?.sourceVersions && changed.every((entry) => previous.pending.sourceVersions[entry.id] === version(entry))
    ? previous
    : { ...previous, pending: { sourceVersions: Object.fromEntries(changed.map((entry) => [entry.id, version(entry)])),
        entryIds: Object.fromEntries(changed.map((entry) => [entry.id, idFactory()])), assetIds: {} } };
  const assets = new Map((backup.assets ?? []).map((asset) => [asset.id, asset]));
  for (const entry of changed) for (const assetId of contentAssetIds(entry.content)) {
    if (!receipt.pending.assetIds[assetId]) receipt.pending.assetIds[assetId] = idFactory();
  }
  await target.setSetting(RECEIPT, receipt);
  let copied = 0, conflicts = 0, missingImages = 0, done = 0;
  for (const sourceEntry of changed) {
    const sourceVersion = version(sourceEntry);
    if (receipt.completed?.[sourceEntry.id]?.version === sourceVersion) { done++; continue; }
    const targetId = receipt.pending.entryIds[sourceEntry.id], assetMapping = new Map();
    for (const assetId of contentAssetIds(sourceEntry.content)) {
      const asset = assets.get(assetId);
      if (!asset?.sourceBase64) { missingImages++; continue; }
      const targetAssetId = receipt.pending.assetIds[assetId]; assetMapping.set(assetId, targetAssetId);
      await target.saveAsset({ ...asset, id: targetAssetId, entryId: targetId, status: 'local-only', uploadRequestId: idFactory(),
        completeRequestId: idFactory(), uploadAttempts: 0, error: null, updatedAt: new Date().toISOString(), sourceBase64: undefined, bytes: base64ToBytes(asset.sourceBase64) });
    }
    const copy = cleanCopy(sourceEntry, targetId, remapContentAssetIds(sourceEntry.content, assetMapping));
    let status = 'copied';
    try { await target.save(copy, 0); copied++; }
    catch (error) {
      if (error?.name !== 'DailyExistsError') throw error;
      status = 'conflict'; conflicts++;
    }
    receipt.completed = { ...(receipt.completed ?? {}), [sourceEntry.id]: { version: sourceVersion, targetId, status } };
    receipt.versions = { ...(receipt.versions ?? {}), [sourceEntry.id]: sourceVersion };
    done++; onProgress({ done, total: changed.length, status });
    await target.setSetting(RECEIPT, receipt);
  }
  receipt = { ...receipt, pending: null, completedAt: new Date().toISOString() };
  await target.setSetting(RECEIPT, receipt);
  return { copied, conflicts, missingImages, skipped: preview.total - changed.length, reused: false };
}
