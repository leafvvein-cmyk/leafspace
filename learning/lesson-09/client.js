const form = document.querySelector('#entry-form');
const titleInput = document.querySelector('#entry-title');
const contentInput = document.querySelector('#entry-content');
const formError = document.querySelector('#form-error');
const requestStatus = document.querySelector('#request-status');
const entryList = document.querySelector('#entry-list');
const entryCount = document.querySelector('#entry-count');

function createCard(entry) {
  const article = document.createElement('article');
  const title = document.createElement('h3');
  const meta = document.createElement('p');
  const content = document.createElement('p');
  article.className = 'entry-card';
  title.textContent = entry.title;
  meta.className = 'entry-meta';
  meta.textContent = `${entry.entryDate} · HTTP ${entry.id}`;
  content.textContent = entry.content;
  article.append(title, meta, content);
  return article;
}

function render(entries) {
  entryList.replaceChildren(...entries.map(createCard));
  entryCount.textContent = `${entries.length} 篇`;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `请求失败：HTTP ${response.status}`);
  return body.data;
}

async function loadEntries() {
  try {
    requestStatus.textContent = '正在请求 GET /api/entries…';
    const data = await request('/api/entries');
    render(data.entries);
    requestStatus.textContent = `GET /api/entries → HTTP 200，收到 ${data.entries.length} 篇。`;
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
    formError.hidden = true;
    requestStatus.textContent = '正在请求 POST /api/entries…';
    const data = await request('/api/entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    form.reset();
    await loadEntries();
    requestStatus.textContent = `POST /api/entries → HTTP 201，已创建“${data.entry.title}”。`;
    titleInput.focus();
  } catch (error) {
    formError.textContent = error.message;
    formError.hidden = false;
    requestStatus.textContent = 'POST 请求没有完成。';
  }
}

form.addEventListener('submit', saveEntry);
loadEntries();
