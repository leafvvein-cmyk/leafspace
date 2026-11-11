import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { exportArchive } from '../../apps/api/src/export-archive.js';
import { makeDraft } from '../../packages/contracts/src/entry.js';
const snapshotAt = '2026-09-08T01:00:00.000Z';
async function read(options) {
  const chunks = [];
  for await (const chunk of exportArchive({ snapshotAt, ...options })) chunks.push(chunk);
  return JSZip.loadAsync(Buffer.concat(chunks), { checkCRC32: true });
}
describe('export ZIP contents', () => {
  it.each(['json_zip', 'markdown_zip'])('writes indexed Unicode records in %s without title-based paths', async (format) => {
    const entry = { ...makeDraft(), title: '../中文标题', revision: '8' };
    const zip = await read({ entries: [entry], format });
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    expect(manifest).toMatchObject({ entryCount: 1, source: 'cloud-snapshot', snapshotAt });
    expect(manifest.entries[0]).toMatchObject({ id: entry.id, revision: '8' });
    expect(manifest.entries[0].path).not.toContain('中文标题');
    const body = await zip.file(manifest.entries[0].path).async('string');
    expect(body).toContain('中文标题');
    if (format === 'json_zip') expect(JSON.parse(body).entry).toEqual(entry);
  });
  it('rejects duplicate records and unfulfilled image inclusion', () => {
    const entry = { ...makeDraft(), title: '日记' };
    expect(() => exportArchive({ entries: [entry, entry], format: 'json_zip', snapshotAt })).toThrow('重复');
    entry.content = { type: 'doc', content: [{ type: 'image', attrs: { assetId: crypto.randomUUID() } }] };
    expect(() => exportArchive({ entries: [entry], format: 'json_zip', snapshotAt, includeImages: true })).toThrow('图片归档尚未就绪');
  });
  it('includes each requested private image once and links Markdown to the fixed asset path', async () => {
    const id = crypto.randomUUID(), entry = { ...makeDraft(), title: '有图片的日记',
      content: { type: 'doc', content: [{ type: 'image', attrs: { assetId: id, alt: '照片', caption: '' } }] } };
    const zip = await read({ entries: [entry], format: 'markdown_zip', includeImages: true,
      attachments: { [id]: { path: `assets/${id}.webp`, bytes: new Uint8Array([1, 2, 3]) } } });
    expect(Array.from(await zip.file(`assets/${id}.webp`).async('uint8array'))).toEqual([1, 2, 3]);
    expect(await zip.file(`entries/${entry.entryDate}-${entry.id}.md`).async('string')).toContain(`![照片](assets/${id}.webp)`);
    expect(JSON.parse(await zip.file('manifest.json').async('string')).missingAssets).toEqual([]);
  });
});
