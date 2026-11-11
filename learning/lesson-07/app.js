const STORAGE_KEY = 'diary-learning:lesson-07:v1';
const STORAGE_VERSION = 1;

const form = document.querySelector('#entry-form');
const titleInput = document.querySelector('#entry-title');
const contentInput = document.querySelector('#entry-content');
const formError = document.querySelector('#form-error');
const storageStatus = document.querySelector('#storage-status');
const entryCount = document.querySelector('#entry-count');
const entryList = document.querySelector('#entry-list');
const emptyState = document.querySelector('#empty-state');
const resetButton = document.querySelector('#reset-button');

let entries = [];

function validEntry(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.id === 'string'
    && typeof entry.title === 'string' && entry.title.length <= 80
    && typeof entry.content === 'string' && entry.content.length <= 5000
    && typeof entry.createdAt === 'string';
}

function loadEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    storageStatus.textContent = '本机还没有第 07 课数据。';
    return [];
  }

  try {
    const saved = JSON.parse(raw);
    if (saved?.version !== STORAGE_VERSION || !Array.isArray(saved.entries) || !saved.entries.every(validEntry)) {
      throw new Error('存储结构不符合第 07 课规则');
    }
    storageStatus.textContent = `已从浏览器恢复 ${saved.entries.length} 篇练习日记。`;
    return saved.entries;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    storageStatus.textContent = '发现无法读取的练习数据，已隔离清除；正式应用应先导出或保留损坏副本。';
    return [];
  }
}

function persistEntries() {
  const payload = { version: STORAGE_VERSION, entries };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    storageStatus.textContent = `已确认写入浏览器：${entries.length} 篇。`;
    return true;
  } catch {
    storageStatus.textContent = '浏览器存储失败。本次内存内容仍显示，请不要刷新，并先复制重要文字。';
    return false;
  }
}

function createCard(entry) {
  const article = document.createElement('article');
  const body = document.createElement('div');
  const heading = document.createElement('h3');
  const meta = document.createElement('p');
  const content = document.createElement('p');
  const remove = document.createElement('button');

  article.className = 'entry-card';
  heading.textContent = entry.title;
  meta.className = 'entry-meta';
  meta.textContent = entry.createdAt;
  content.textContent = entry.content;
  remove.className = 'delete-button';
  remove.type = 'button';
  remove.textContent = `删除“${entry.title}”`;
  remove.addEventListener('click', () => deleteEntry(entry.id));
  body.append(heading, meta, content);
  article.append(body, remove);
  return article;
}

function renderEntries() {
  entryList.replaceChildren();
  for (const entry of entries) entryList.append(createCard(entry));
  entryCount.textContent = `${entries.length} 篇`;
  emptyState.hidden = entries.length > 0;
  resetButton.disabled = entries.length === 0;
}

function saveEntry(event) {
  event.preventDefault();
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  if (title.length < 2 || content.length < 5) {
    formError.textContent = '标题至少 2 个字符，正文至少 5 个字符。';
    formError.hidden = false;
    return;
  }

  entries.unshift({ id: crypto.randomUUID(), title, content, createdAt: new Date().toLocaleString('zh-CN') });
  formError.hidden = true;
  form.reset();
  persistEntries();
  renderEntries();
  titleInput.focus();
}

function deleteEntry(id) {
  entries = entries.filter((entry) => entry.id !== id);
  persistEntries();
  renderEntries();
}

function resetEntries() {
  if (!window.confirm('只删除第 07 课的全部练习数据？')) return;
  entries = [];
  localStorage.removeItem(STORAGE_KEY);
  storageStatus.textContent = '第 07 课的练习数据已删除。';
  renderEntries();
}

entries = loadEntries();
renderEntries();
form.addEventListener('submit', saveEntry);
resetButton.addEventListener('click', resetEntries);
