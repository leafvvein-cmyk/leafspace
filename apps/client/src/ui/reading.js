import { validateContent } from '@diary/contracts';
import { h } from './dom.js';

// Construct elements from the shared schema, never from saved HTML strings.
export function readingContent(content, { resolveAsset } = {}) {
  validateContent(content);
  function imageNode(item) {
    const figure = h('figure', { className: 'diary-image', 'data-asset-id': item.attrs.assetId }), image = h('img', { alt: item.attrs.alt || '' }), caption = h('figcaption', {}, item.attrs.caption || '正在读取本机图片…');
    figure.append(image, caption);
    Promise.resolve(resolveAsset?.(item.attrs.assetId)).then((asset) => {
      if (!asset?.bytes || !figure.isConnected) throw new Error('此图片尚未下载到本机');
      const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType })); image.src = url;
      image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      caption.textContent = item.attrs.caption || '';
      if (!caption.textContent) caption.remove();
    }).catch((error) => { figure.classList.add('is-missing'); caption.textContent = error.message || '图片暂时无法读取'; });
    return figure;
  }
  function node(item) {
    if (item.type === 'text') {
      let text = document.createTextNode(item.text);
      for (const mark of item.marks ?? []) text = h({ bold: 'strong', italic: 'em', underline: 'u' }[mark.type], {}, text);
      return text;
    }
    const children = (item.content ?? []).map(node);
    switch (item.type) {
      case 'doc': return h('div', { className: 'rich-reading' }, children);
      case 'paragraph': return h('p', {}, children.length ? children : h('br'));
      case 'heading': return h(`h${item.attrs.level}`, {}, children);
      case 'blockquote': return h('blockquote', {}, children);
      case 'bulletList': return h('ul', {}, children);
      case 'orderedList': return h('ol', { start: item.attrs?.start ?? 1 }, children);
      case 'taskList': return h('ul', { className: 'reading-tasks' }, children);
      case 'taskItem': return h('li', { className: 'reading-task' }, h('span', { 'aria-label': item.attrs.checked ? '已完成' : '未完成' }, item.attrs.checked ? '☑' : '☐'), h('div', {}, children));
      case 'listItem': return h('li', {}, children);
      case 'hardBreak': return h('br');
      case 'horizontalRule': return h('hr');
      case 'image': return imageNode(item);
      default: throw new Error('不能显示此正文格式，请更新应用。');
    }
  }
  return node(content);
}
