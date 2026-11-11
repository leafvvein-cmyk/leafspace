import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { validateEntry } from '@diary/contracts';
import { entryMarkdown } from '@diary/contracts/markdown';

export function exportArchive({ entries, format, snapshotAt, includeImages = false, attachments = {} }) {
  if (!['json_zip', 'markdown_zip'].includes(format) || !Number.isFinite(Date.parse(snapshotAt))) throw new Error('导出配置无效');
  const archive = new JSZip(), ids = new Set(), missing = new Set();
  const index = [];
  let size = 0;
  for (const entry of entries) {
    validateEntry(entry);
    if (!/^[0-9a-f-]{36}$/i.test(entry.id) || ids.has(entry.id)) throw new Error('导出记录编号无效或重复');
    ids.add(entry.id);
    const paths = Object.fromEntries(Object.entries(attachments).map(([id, item]) => [id, item.path]));
    const rendered = entryMarkdown(entry, { attachments: paths });
    rendered.missingAssets.forEach((id) => missing.add(id));
    // Never silently omit requested images while calling the archive complete.
    if (includeImages && missing.size) throw new Error('图片归档尚未就绪，不能生成含图片的完整导出');
    const path = `entries/${entry.entryDate}-${entry.id}.${format === 'json_zip' ? 'json' : 'md'}`;
    const body = format === 'json_zip' ? JSON.stringify({ contentSchemaVersion: entry.contentSchemaVersion, entry }, null, 2) : rendered.markdown;
    size += Buffer.byteLength(body);
    if (size > 64 * 1024 * 1024) throw new Error('单个导出任务内容过大，请缩小日期范围');
    archive.file(path, body, { date: new Date(snapshotAt) });
    index.push({ id: entry.id, revision: entry.revision, path });
  }
  if (includeImages) for (const [id, attachment] of Object.entries(attachments)) {
    if (!missing.has(id) && /^assets\/[0-9a-f-]{36}\.webp$/i.test(attachment.path) && attachment.bytes) {
      size += attachment.bytes.byteLength;
      if (size > 64 * 1024 * 1024) throw new Error('单个导出任务内容过大，请缩小日期范围');
      archive.file(attachment.path, attachment.bytes, { binary: true, date: new Date(snapshotAt) });
    }
  }
  archive.file('manifest.json', JSON.stringify({ exportSchemaVersion: 1, source: 'cloud-snapshot', snapshotAt,
    format, entryCount: index.length, entries: index, includeImages, missingAssets: [...missing],
    notice: '仅包含云端快照内容，不包含尚未同步的本机稿。' }, null, 2));
  return new Readable({ read() {} }).wrap(archive.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}
