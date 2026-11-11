/** Shared, framework-free diary rules. No DOM, storage, or server dependencies. */
export const CONTENT_SCHEMA_VERSION = 1;
export const MOODS = [
  { value: 1, label: '很低落', face: '◡' },
  { value: 2, label: '低落', face: '⌢' },
  { value: 3, label: '平静', face: '−' },
  { value: 4, label: '愉快', face: '◡' },
  { value: 5, label: '很开心', face: 'ᴗ' },
];

export class ValidationError extends Error {
  constructor(message, field = 'content') {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = 'VALIDATION_FAILED';
  }
}

export function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function localDate(now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function offsetDate(value, amount) {
  if (!isDate(value)) throw new ValidationError('请选择有效日期', 'entryDate');
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export const emptyContent = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });

export function contentText(content) {
  if (!content || typeof content !== 'object') return '';
  if (content.type === 'text') return content.text ?? '';
  if (content.type === 'hardBreak') return '\n';
  const children = (content.content ?? []).map(contentText).join('');
  return ['paragraph', 'heading', 'blockquote', 'listItem', 'taskItem'].includes(content.type)
    ? `${children}\n` : children;
}

export function containsImage(content) {
  return content?.type === 'image' || (content?.content ?? []).some(containsImage);
}

export function hasContent(entry) {
  return Boolean(entry.title?.trim() || contentText(entry.content).trim() || containsImage(entry.content));
}

export function normalizeTags(input) {
  const tags = input.map((tag) => typeof tag === 'string' ? tag.trim() : tag.name?.trim()).filter(Boolean);
  const byName = new Map();
  for (const name of tags) {
    if ([...name].length > 24) throw new ValidationError('每个标签最多 24 个字符', 'tags');
    const key = name.normalize('NFKC').toLowerCase();
    if (!byName.has(key)) byName.set(key, { name });
  }
  if (byName.size > 10) throw new ValidationError('每篇最多添加 10 个标签', 'tags');
  return [...byName.values()];
}

const nodeTypes = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'horizontalRule', 'hardBreak', 'image',
]);
const allowedAttributes = {
  heading: new Set(['level']), orderedList: new Set(['start', 'type']),
  taskItem: new Set(['checked']), image: new Set(['assetId', 'alt', 'caption']),
};

const blocks = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'horizontalRule', 'image']);
const inline = new Set(['text', 'hardBreak']);
const allowedChildren = {
  doc: blocks, blockquote: blocks, paragraph: inline, heading: inline,
  bulletList: new Set(['listItem']), orderedList: new Set(['listItem']), taskList: new Set(['taskItem']),
  listItem: blocks, taskItem: blocks,
};

export function validateContent(content) {
  let nodes = 0;
  const visit = (node, depth) => {
    if (++nodes > 10000 || depth > 20) throw new ValidationError('正文结构过大');
    if (!node || typeof node !== 'object' || !nodeTypes.has(node.type)) {
      throw new ValidationError('正文含不支持的格式');
    }
    if (Object.keys(node).some((key) => !['type', 'content', 'text', 'attrs', 'marks'].includes(key))) {
      throw new ValidationError('正文包含未知字段');
    }
    if (node.type === 'text' && typeof node.text !== 'string') throw new ValidationError('文字节点无效');
    if (node.type !== 'text' && node.text != null) throw new ValidationError('非文字节点不能包含 text');
    if (node.type === 'text' && !node.text.length) throw new ValidationError('文字节点不能为空');
    if (node.attrs != null) {
      if (typeof node.attrs !== 'object' || Array.isArray(node.attrs)) throw new ValidationError('格式属性无效');
      for (const key of Object.keys(node.attrs)) {
        if (!allowedAttributes[node.type]?.has(key)) throw new ValidationError('正文属性不受支持');
      }
    }
    if (node.type === 'heading' && ![1, 2, 3].includes(node.attrs?.level)) throw new ValidationError('标题级别无效');
    if (node.type === 'orderedList' && node.attrs?.start != null && (!Number.isInteger(node.attrs.start) || node.attrs.start < 1)) throw new ValidationError('列表起点无效');
    if (node.type === 'orderedList' && node.attrs?.type != null && !['1', 'a', 'A', 'i', 'I'].includes(node.attrs.type)) throw new ValidationError('列表类型无效');
    if (node.type === 'taskItem' && typeof node.attrs?.checked !== 'boolean') throw new ValidationError('待办状态无效');
    if (node.type === 'image' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.attrs?.assetId ?? '')) throw new ValidationError('图片引用无效');
    if (node.type === 'image' && ['alt', 'caption'].some((key) => node.attrs?.[key] != null && (typeof node.attrs[key] !== 'string' || [...node.attrs[key]].length > 500))) throw new ValidationError('图片说明无效');
    if (node.marks) {
      if (!inline.has(node.type) || !Array.isArray(node.marks) || node.marks.some((mark) =>
        !['bold', 'italic', 'underline'].includes(mark.type) || Object.keys(mark).some((key) => key !== 'type'))) {
        throw new ValidationError('不支持此文字样式');
      }
    }
    if (node.content != null && !Array.isArray(node.content)) throw new ValidationError('正文子节点无效');
    const children = node.content ?? [];
    if (children.some((child) => !allowedChildren[node.type]?.has(child?.type))) throw new ValidationError('正文嵌套结构无效');
    if (['doc', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'].includes(node.type) && !children.length) throw new ValidationError('正文容器不能为空');
    if (node.type === 'listItem' && children[0]?.type !== 'paragraph') throw new ValidationError('列表项必须以段落开始');
    if (!allowedChildren[node.type] && node.content != null) throw new ValidationError('叶节点不能包含子节点');
    for (const child of node.content ?? []) visit(child, depth + 1);
  };
  if (content?.type !== 'doc') throw new ValidationError('正文必须是文档');
  visit(content, 0);
  if (new TextEncoder().encode(JSON.stringify(content)).length > 1048576 || [...contentText(content)].length > 100000) {
    throw new ValidationError('正文超出长度限制');
  }
  return content;
}

export function validateEntry(entry, { allowEmpty = false } = {}) {
  if (!['daily', 'moment'].includes(entry.kind)) throw new ValidationError('记录类型无效', 'kind');
  if (!isDate(entry.entryDate)) throw new ValidationError('请选择有效日期', 'entryDate');
  try { new Intl.DateTimeFormat('en', { timeZone: entry.timezone }); }
  catch { throw new ValidationError('时区无效', 'timezone'); }
  if (typeof entry.timezone !== 'string' || !entry.timezone) throw new ValidationError('请选择时区', 'timezone');
  if (entry.kind === 'moment' && !Number.isFinite(Date.parse(entry.occurredAt))) throw new ValidationError('随记时间无效', 'occurredAt');
  if (typeof entry.title !== 'string' || [...entry.title].length > 120) throw new ValidationError('标题最多 120 个字符', 'title');
  if (entry.contentSchemaVersion !== 1) throw new ValidationError('正文版本不受支持');
  if (entry.mood !== null && ![1, 2, 3, 4, 5].includes(entry.mood)) throw new ValidationError('心情值无效', 'mood');
  if (!Array.isArray(entry.tags)) throw new ValidationError('标签格式无效', 'tags');
  normalizeTags(entry.tags);
  validateContent(entry.content);
  if (!allowEmpty && !hasContent(entry)) throw new ValidationError('请写一点内容再保存');
  return entry;
}

export function makeDraft({ kind = 'daily', entryDate = localDate(), now = new Date(), id = crypto.randomUUID() } = {}) {
  return {
    id, kind, entryDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    occurredAt: kind === 'moment' ? now.toISOString() : null,
    title: '', contentSchemaVersion: 1, content: emptyContent(), mood: null, tags: [],
    revision: '0', localRevision: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    deletedAt: null, purgeAfter: null,
  };
}
