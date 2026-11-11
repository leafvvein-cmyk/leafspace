import { normalizeTags } from '@diary/contracts';

const key = (name) => name.trim().normalize('NFKC').toLocaleLowerCase();

export function changedTags(tags, from, to = null) {
  const source = key(from ?? '');
  if (!source) throw new Error('原标签不能为空');
  const replacement = to === null ? null : normalizeTags([to])[0]?.name;
  if (to !== null && !replacement) throw new Error('新标签不能为空');
  if (!tags.some((tag) => key(tag.name) === source)) return null;
  return normalizeTags(tags.flatMap((tag) => key(tag.name) === source ? (replacement ? [replacement] : []) : [tag.name]));
}

export async function applyTagChange({ store, from, to = null, onProgress = () => {} }) {
  const entries = [...await store.list({ state: 'active' }), ...await store.list({ state: 'trash' })];
  const affected = entries.filter((entry) => changedTags(entry.tags, from, to));
  let completed = 0;
  for (const snapshot of affected) {
    const current = await store.get(snapshot.id);
    if (!current) continue;
    const tags = changedTags(current.tags, from, to);
    if (!tags) continue;
    try { await store.save({ ...current, tags }, current.localRevision); }
    catch (error) { error.completed = completed; error.total = affected.length; throw error; }
    completed++; onProgress({ completed, total: affected.length });
  }
  return { changed: completed, total: affected.length };
}
