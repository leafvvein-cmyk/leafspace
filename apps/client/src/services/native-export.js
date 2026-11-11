import { requireNativePlugin } from './platform.js';
import { cleanExportCache, EXPORT_CACHE_ROOT } from './export-cache.js';

const active = new Set();
let cleanup;
export async function cleanNativeExports() {
  requireNativePlugin('Filesystem');
  if (cleanup) return cleanup;
  cleanup = (async () => {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    return cleanExportCache(Filesystem, Directory.Cache, { active });
  })().finally(() => { cleanup = undefined; });
  return cleanup;
}

export async function shareTextFile(name, text) {
  requireNativePlugin('Filesystem'); requireNativePlugin('Share');
  if (!name || /[\\/\x00-\x1f]/.test(name) || name.length > 120) throw new Error('导出文件名不正确');
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  // Dedicated app-private temporary directory; no external-storage permission.
  await cleanNativeExports();
  const id = crypto.randomUUID();
  const path = `${EXPORT_CACHE_ROOT}/${id}/${name}`;
  active.add(id);
  try {
    const result = await Filesystem.writeFile({ path, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
    await Share.share({ title: '导出日记', dialogTitle: '保存日记备份', files: [result.uri] });
  } finally { active.delete(id); }
  // Retain for 24h: recipients may still read after the chooser closes.
}
