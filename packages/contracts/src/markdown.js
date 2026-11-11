import { validateEntry, MOODS } from './entry.js';

// Only application-generated attachment paths are emitted, never user URLs.
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');

export function entryMarkdown(entry, { attachments = {} } = {}) {
  validateEntry(entry);
  const missingAssets = new Set();
  const inline = (node) => {
    if (node.type === 'hardBreak') return '  \n';
    let value = escape(node.text ?? '');
    const marks = new Set((node.marks ?? []).map((mark) => mark.type));
    if (marks.has('bold')) value = `**${value}**`;
    if (marks.has('italic')) value = `_${value}_`;
    if (marks.has('underline')) value = `<u>${value}</u>`;
    return value;
  };
  const blocks = (nodes) => nodes.map(block).join('\n\n');
  function block(node) {
    const children = node.content ?? [];
    switch (node.type) {
      case 'doc': return blocks(children);
      case 'paragraph': return children.map(inline).join('');
      case 'heading': return `${'#'.repeat(node.attrs.level)} ${children.map(inline).join('')}`;
      case 'horizontalRule': return '---';
      case 'blockquote': return blocks(children).split('\n').map((line) => `> ${line}`).join('\n');
      case 'bulletList': case 'orderedList': case 'taskList':
        return children.map((item, index) => {
          const marker = node.type === 'orderedList' ? `${(node.attrs?.start ?? 1) + index}. `
            : node.type === 'taskList' ? `- [${item.attrs.checked ? 'x' : ' '}] ` : '- ';
          const lines = blocks(item.content).split('\n');
          return marker + lines[0] + lines.slice(1).map((line) => `\n${' '.repeat(marker.length)}${line}`).join('');
        }).join('\n');
      case 'image': {
        const id = node.attrs.assetId, path = attachments[id];
        if (!path) { missingAssets.add(id); return `图片未包含：${escape(node.attrs.alt || id)}`; }
        if (!new RegExp(`^assets/${id}\\.(png|jpg|jpeg|webp|gif)$`, 'i').test(path)) throw new Error('附件导出路径无效');
        return `![${escape(node.attrs.alt || '')}](${path})` + (node.attrs.caption ? `\n\n${escape(node.attrs.caption)}` : '');
      }
      default: throw new Error('无法导出此正文格式');
    }
  }
  const metadata = [`日期：${entry.entryDate}`, `类型：${entry.kind === 'daily' ? '每日一页' : '随记'}`,
    `心情：${MOODS.find((mood) => mood.value === entry.mood)?.label ?? '未选择'}`,
    `标签：${entry.tags.map((tag) => escape(tag.name)).join('、') || '无'}`];
  return { markdown: `# ${escape(entry.title || '无标题记录')}\n\n${metadata.join('  \n')}\n\n${block(entry.content)}\n`, missingAssets: [...missingAssets] };
}
