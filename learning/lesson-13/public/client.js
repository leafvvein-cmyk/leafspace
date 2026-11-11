const status = document.querySelector('#status');
const loginPanel = document.querySelector('#login-panel');
const diaryPanel = document.querySelector('#diary-panel');
const entriesNode = document.querySelector('#entries');

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body?.data;
}

function showLogin(message = '请使用练习账号登录。') {
  loginPanel.hidden = false; diaryPanel.hidden = true; status.textContent = message;
}
function showDiary(username) {
  loginPanel.hidden = true; diaryPanel.hidden = false; document.querySelector('#welcome').textContent = `${username} 的服务端日记`;
}
function renderEntries(entries) {
  entriesNode.replaceChildren();
  if (!entries.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '服务端还没有日记。'; entriesNode.append(empty); return; }
  for (const entry of entries) {
    const article = document.createElement('article'); article.className = 'entry';
    const title = document.createElement('h4'); title.textContent = entry.title;
    const content = document.createElement('p'); content.textContent = entry.content;
    const time = document.createElement('time'); time.dateTime = entry.entryDate; time.textContent = entry.entryDate;
    article.append(title, content, time); entriesNode.append(article);
  }
}
async function loadEntries() {
  entriesNode.innerHTML = '<p class="empty">正在从 API 读取…</p>';
  try { const data = await request('/api/entries'); renderEntries(data.entries); status.textContent = `读取成功：服务器返回 ${data.entries.length} 篇日记。`; }
  catch (error) { if (error.status === 401) showLogin('登录状态已失效，请重新登录。'); else { entriesNode.innerHTML = '<p class="error">读取失败，请稍后重试。</p>'; status.textContent = error.message; } }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('button'); submit.disabled = true;
  try { const data = await request('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.querySelector('.error').hidden = true; showDiary(data.user.username); await loadEntries(); }
  catch (error) { const node = form.querySelector('.error'); node.textContent = error.message; node.hidden = false; }
  finally { submit.disabled = false; }
});
document.querySelector('#entry-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('button'); submit.disabled = true;
  try { await request('/api/entries', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.querySelector('.error').hidden = true; form.querySelector('[name=title]').value = ''; form.querySelector('[name=content]').value = ''; await loadEntries(); status.textContent = 'HTTP 201：日记已写入服务端，再次 GET 后列表已更新。'; }
  catch (error) { const node = form.querySelector('.error'); node.textContent = error.message; node.hidden = false; }
  finally { submit.disabled = false; }
});
document.querySelector('#reload').addEventListener('click', loadEntries);
document.querySelector('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); showLogin('已删除服务端会话。'); });

document.querySelector('#entry-form [name=entryDate]').value = new Date().toLocaleDateString('en-CA');
(async () => { try { const data = await request('/api/me'); showDiary(data.user.username); await loadEntries(); } catch { showLogin(); } })();
