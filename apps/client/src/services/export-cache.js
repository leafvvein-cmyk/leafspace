// Only disposable copies created by native-export.js live in this directory.
export const EXPORT_CACHE_ROOT = 'diary-exports';
export const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
const exportDirectory = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function cleanExportCache(filesystem, directory, { now = Date.now(), active = new Set() } = {}) {
  const report = { removed: 0, failed: 0 };
  let entries;
  try { entries = (await filesystem.readdir({ path: EXPORT_CACHE_ROOT, directory })).files; }
  catch { return report; } // First launch may have no export directory.
  const expired = (mtime) => Number.isFinite(mtime) && mtime > 0 && now - mtime >= EXPORT_RETENTION_MS;
  // Bound work on each foreground event. Files with unknown times are retained.
  const candidates = entries.filter((entry) => entry.type === 'directory' && exportDirectory.test(entry.name)
    && !active.has(entry.name) && expired(entry.mtime)).sort((a, b) => a.mtime - b.mtime).slice(0, 100);
  for (const entry of candidates) {
    const path = `${EXPORT_CACHE_ROOT}/${entry.name}`;
    try {
      const children = (await filesystem.readdir({ path, directory })).files;
      // No nested trees are created by the exporter. Keep unknown content.
      if (children.some((file) => file.type !== 'file' || !expired(file.mtime)) || active.has(entry.name)) continue;
      await filesystem.rmdir({ path, directory, recursive: true });
      report.removed += 1;
    } catch { report.failed += 1; } // A cleanup failure must not discard a new export.
  }
  return report;
}
