const form = document.querySelector('#entry-form');
const titleInput = document.querySelector('#entry-title');
const contentInput = document.querySelector('#entry-content');
const formError = document.querySelector('#form-error');
const requestStatus = document.querySelector('#request-status');
const entryList = document.querySelector('#entry-list');
const entryCount = document.querySelector('#entry-count');

async function request(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body;
}

function createCard(entry) {
  const article = document.createElement('article');
  const body = document.createElement('div');
  const title = document.createElement('h3');
  const meta = document.createElement('p');
  const content = document.createElement('p');
  const remove = document.createElement('button');
  article.className = 'entry-card';
  title.textContent = entry.title;
  meta.className = 'entry-meta';
  meta.textContent = `${entry.entryDate} · revision ${entry.revision}`;
  content.textContent = entry.content;
  remove.className = 'delete-button';
  remove.type = 'button';
  remove.textContent = `删除“${entry.title}”`;
  remove.addEventListener('click', async () => {
    if (!window.confirm(`删除练习日记“${entry.title}”？`)) return;
    try {
      await request(`/api/entries/${entry.id}`, { method: 'DELETE' });
      requestStatus.textContent = `DELETE /api/entries/:id → HTTP 204，已删除“${entry.title}”。`;
      await loadEntries(false);
    } catch (error) {
      requestStatus.textContent = `删除失败：${error.message}`;
    }
  });
  body.append(title, meta, content);
  article.append(body, remove);
  return article;
}

async function loadEntries(updateStatus = true) {
  try {
    const body = await request('/api/entries');
    entryList.replaceChildren(...body.data.entries.map(createCard));
    entryCount.textContent = `${body.data.entries.length} 篇`;
    if (updateStatus) requestStatus.textContent = `GET /api/entries → HTTP 200 · requestId ${body.meta.requestId}`;
  } catch (error) {
    requestStatus.textContent = `读取失败：${error.message}`;
  }
}

async function saveEntry(event) {
  event.preventDefault();
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  if (title.length < 2 || content.length < 5) {
    formError.textContent = '标题至少 2 个字符，正文至少 5 个字符。';
    formError.hidden = false;
    return;
  }
  try {
    const body = await request('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) });
    formError.hidden = true;
    form.reset();
    await loadEntries(false);
    requestStatus.textContent = `POST /api/entries → HTTP 201 · requestId ${body.meta.requestId}`;
    titleInput.focus();
  } catch (error) {
    formError.textContent = error.message;
    formError.hidden = false;
  }
}

form.addEventListener('submit', saveEntry);
loadEntries();
