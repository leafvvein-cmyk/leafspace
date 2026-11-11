import { validateEntry, contentText } from '@diary/contracts';

// Merge work is isolated from the live diary and upload queue until confirmed.
export async function saveMergeDraft(adapter, id, entry, expectedRevision = 0) {
  validateEntry(entry);
  return adapter.atomic(async () => {
    const record = await adapter.conflict(id);
    if (!record) throw new Error('找不到这次冲突');
    if (record.resolution) throw new Error('这次冲突已处理，请重新打开页面');
    if (entry.id !== record.entryId) throw new Error('合并草稿编号不一致');
    const revision = record.mergeDraft?.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) throw new Error('合并草稿已在其他窗口变化，请保留当前内容并重新读取');
    const saved = { ...structuredClone(entry), localRevision: revision + 1 };
    await adapter.putConflict({ ...record, mergeDraft: { revision: revision + 1, entry: saved, updatedAt: new Date().toISOString() } });
    return saved;
  });
}

export async function keepCloud(adapter, id, { expectedLocalRevision, remote, mergeRevision }) {
  return adapter.atomic(async () => {
    const record = await adapter.conflict(id);
    if (!record) throw new Error('找不到这次冲突');
    const kind = mergeRevision === undefined ? 'keep-cloud' : 'merged-local';
    if (record.resolution?.kind === kind) return { entryId: record.entryId, reused: true };
    if (record.resolution) throw new Error('这次冲突已使用其他方式处理');
    if (await adapter.snapshotPending()) throw new Error('云端快照正在重建，请同步完成后重新读取并确认');
    if (!remote || remote.id !== record.entryId || !/^[1-9]\d{0,18}$/.test(remote.revision ?? '')) throw new Error('云端版本无效，请重新读取');
    if (BigInt(remote.revision) > 9223372036854775807n) throw new Error('云端版本无效，请重新读取');
    validateEntry(remote);
    const current = await adapter.local(record.entryId);
    if (!current || current.localRevision !== expectedLocalRevision) throw new Error('本机稿已变化，请重新打开冲突页面后确认');
    const jobs = await adapter.jobs(record.entryId);
    if (jobs.some((job) => job.status === 'pending')) throw new Error('这篇日记的上传结果尚未确认，请等待同步后再处理');
    const cached = await adapter.cloud(record.entryId);
    if (cached && (cached.purged || BigInt(cached.value.revision) > BigInt(remote.revision))) throw new Error('云端版本又有变化，请重新读取后确认');
    const retired = { ...current, localRetired: true, localRevision: current.localRevision + 1 };
    delete retired.dailyKey;
    if (kind === 'merged-local') {
      if (!record.mergeDraft || record.mergeDraft.revision !== mergeRevision) throw new Error('合并草稿已变化，请重新确认');
      if (remote.deletedAt) throw new Error('云端日记已删除，请先处理回收站状态');
      const draft = record.mergeDraft.entry;
      Object.assign(retired, structuredClone(remote), { title: draft.title, content: structuredClone(draft.content),
        tags: structuredClone(draft.tags), mood: draft.mood, localRevision: current.localRevision + 1,
        syncBaseDeletedAt: false, updatedAt: new Date().toISOString(), plainText: contentText(draft.content).trim() });
      delete retired.localRetired;
      if (retired.kind === 'daily') {
        if ((await adapter.entries()).some((entry) => entry.id !== retired.id && entry.kind === 'daily' && !entry.deletedAt && entry.entryDate === retired.entryDate)) throw new Error('这个日期已有其他本机日记，请先处理日期冲突');
        retired.dailyKey = retired.entryDate;
      }
      validateEntry(retired);
    }
    await adapter.retire(retired);
    await adapter.putCloud({ entity: 'entry', id: remote.id, value: structuredClone(remote) });
    for (const job of jobs) await adapter.removeJob(job.id);
    if (kind === 'merged-local') await adapter.putJob({ id: `draft:${retired.id}`, entryId: retired.id, status: 'local-only', createdAt: retired.updatedAt });
    await adapter.putConflict({ ...record, resolution: { kind, at: new Date().toISOString(),
      discardedLocal: structuredClone(current), acceptedRemote: structuredClone(remote) } });
    return { entryId: record.entryId, reused: false };
  });
}
