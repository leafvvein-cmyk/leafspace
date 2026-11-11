const entryForm = document.querySelector('#entry-form');
const titleInput = document.querySelector('#entry-title');
const contentInput = document.querySelector('#entry-content');
const formError = document.querySelector('#form-error');
const entryList = document.querySelector('#entry-list');
const emptyState = document.querySelector('#empty-state');
const entryCount = document.querySelector('#entry-count');
const listStatus = document.querySelector('#list-status');
const clearButton = document.querySelector('#clear-button');

const entries = [];

function createEntry(title, content) {
  return {
    id: crypto.randomUUID(),
    title,
    content,
    createdAt: new Date().toLocaleString('zh-CN'),
  };
}

function createEntryCard(entry, position) {
  const article = document.createElement('article');
  const meta = document.createElement('p');
  const heading = document.createElement('h3');
  const content = document.createElement('p');

  article.className = 'entry-card';
  article.dataset.entryId = entry.id;
  meta.className = 'entry-meta';
  meta.textContent = `第 ${position} 篇 · ${entry.createdAt}`;
  heading.textContent = entry.title;
  content.textContent = entry.content;
  article.append(meta, heading, content);
  return article;
}

function renderEntries() {
  entryList.replaceChildren();

  let position = 1;
  for (const entry of entries) {
    entryList.append(createEntryCard(entry, position));
    position = position + 1;
  }

  const count = entries.length;
  entryCount.textContent = `${count} 篇`;
  emptyState.hidden = count > 0;
  clearButton.disabled = count === 0;
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
}

function saveEntry(event) {
  event.preventDefault();
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();

  if (title === '' || content === '') {
    showError('标题和正文都要填写。');
    (title === '' ? titleInput : contentInput).focus();
    return;
  }

  entries.push(createEntry(title, content));
  formError.hidden = true;
  entryForm.reset();
  renderEntries();
  listStatus.textContent = `已加入“${title}”，列表现在有 ${entries.length} 篇日记。`;
  titleInput.focus();
}

function clearEntries() {
  if (entries.length === 0) return;
  entries.length = 0;
  renderEntries();
  listStatus.textContent = '练习列表已清空。';
}

entryForm.addEventListener('submit', saveEntry);
clearButton.addEventListener('click', clearEntries);
renderEntries();
