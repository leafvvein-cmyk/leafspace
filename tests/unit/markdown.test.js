import { describe, it, expect } from 'vitest';
import { makeDraft } from '../../packages/contracts/src/entry.js';
import { entryMarkdown } from '../../packages/contracts/src/markdown.js';
const text = (value) => ({ type: 'text', text: value });
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] });
const entry = (content) => ({ ...makeDraft(), title: '我的日记', content: { type: 'doc', content } });
describe('portable Markdown export', () => {
  it('preserves headings, tasks, nested lists and quotes', () => {
    const result = entryMarkdown(entry([
      { type: 'heading', attrs: { level: 2 }, content: [text('标题')] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('完成')] }] },
      { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('项目'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('子项')] }] }] }] },
      { type: 'blockquote', content: [paragraph('引用')] }
    ]));
    expect(result.markdown).toContain('## 标题'); expect(result.markdown).toContain('- [x] 完成');
    expect(result.markdown).toContain('3. 项目\n   \n   - 子项'); expect(result.markdown).toContain('> 引用');
  });
  it('escapes raw HTML and link syntax rather than emitting active user markup', () => {
    const result = entryMarkdown(entry([paragraph('<script> [x](javascript:alert(1))')]));
    expect(result.markdown).not.toContain('<script>'); expect(result.markdown).toContain('\\[x\\]');
  });
  it('reports omitted images and rejects unsafe attachment paths', () => {
    const id = crypto.randomUUID(), source = entry([{ type: 'image', attrs: { assetId: id, alt: '照片' } }]);
    expect(entryMarkdown(source).missingAssets).toEqual([id]);
    expect(entryMarkdown(source, { attachments: { [id]: `assets/${id}.jpg` } }).markdown).toContain(`![照片](assets/${id}.jpg)`);
    expect(() => entryMarkdown(source, { attachments: { [id]: '../secret.jpg' } })).toThrow('附件导出路径无效');
  });
});
