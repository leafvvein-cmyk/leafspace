import { describe, it, expect, vi } from 'vitest';
import { cleanExportCache, EXPORT_RETENTION_MS } from '../../apps/client/src/services/export-cache.js';
const id = '11111111-1111-4111-8111-111111111111';
const now = 1800000000000;
const old = now - EXPORT_RETENTION_MS - 1;
function filesystem(entries = [{ name: id, type: 'directory', mtime: old }], files = [{ name: 'diary.json', type: 'file', mtime: old }]) {
  return { readdir: vi.fn(async ({ path }) => ({ files: path === 'diary-exports' ? entries : files })), rmdir: vi.fn(async () => {}) };
}
describe('native export temporary-copy retention', () => {
  it('removes only expired generated directories within private export cache', async () => {
    const fs = filesystem();
    expect(await cleanExportCache(fs, 'CACHE', { now })).toEqual({ removed: 1, failed: 0 });
    expect(fs.rmdir).toHaveBeenCalledWith({ path: `diary-exports/${id}`, directory: 'CACHE', recursive: true });
  });
  it.each(['../databases', '/data', '..', 'user-backups'])('never removes unrecognized or escaping paths: %s', async (name) => {
    const fs = filesystem([{ name, type: 'directory', mtime: old }]);
    await cleanExportCache(fs, 'CACHE', { now }); expect(fs.rmdir).not.toHaveBeenCalled();
  });
  it('retains active shares even after the retention period', async () => {
    const fs = filesystem(); await cleanExportCache(fs, 'CACHE', { now, active: new Set([id]) });
    expect(fs.rmdir).not.toHaveBeenCalled();
  });
  it.each([now, now + 1000, 0, undefined, NaN])('retains recent, future, or unknown directory times: %s', async (mtime) => {
    const fs = filesystem([{ name: id, type: 'directory', mtime }]);
    await cleanExportCache(fs, 'CACHE', { now }); expect(fs.rmdir).not.toHaveBeenCalled();
  });
  it.each([{ type: 'file', mtime: now }, { type: 'directory', mtime: old }, { type: 'file', mtime: undefined }])('retains a directory with recent or unknown contents: %j', async (file) => {
    const fs = filesystem(undefined, [file]);
    await cleanExportCache(fs, 'CACHE', { now }); expect(fs.rmdir).not.toHaveBeenCalled();
  });
  it('tolerates absent cache and deletion errors without claiming removal', async () => {
    const fs = filesystem(); fs.readdir.mockRejectedValueOnce(new Error('absent'));
    expect(await cleanExportCache(fs, 'CACHE', { now })).toEqual({ removed: 0, failed: 0 });
    fs.rmdir.mockRejectedValue(new Error('denied'));
    expect(await cleanExportCache(fs, 'CACHE', { now })).toEqual({ removed: 0, failed: 1 });
  });
});
