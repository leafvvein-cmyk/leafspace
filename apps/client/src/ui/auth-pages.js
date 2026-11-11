import { h, button, icon, downloadFile, toast } from './dom.js';

export function createAuthPage({ mode = 'login', submit, navigate, continueLocal }) {
  const register = mode === 'register', recover = mode === 'recover';
  let busy = false;
  const fields = new Map();
  const alert = h('p', { className: 'form-alert', role: 'alert', hidden: true });
  function field(key, label, { password = false, autocomplete, hint } = {}) {
    const id = `auth-${key}`;
    const input = h('input', { id, name: key, type: password ? 'password' : 'text', autocomplete, required: true, autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': `${id}-hint ${id}-error` });
    const error = h('span', { id: `${id}-error`, className: 'field-error', hidden: true });
    const reveal = password && button('显示', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      reveal.querySelector('span').textContent = input.type === 'password' ? '显示' : '隐藏';
      reveal.setAttribute('aria-pressed', String(input.type === 'text'));
    }, { className: 'password-toggle', 'aria-label': `显示${label}`, 'aria-pressed': 'false' });
    fields.set(key, { input, error });
    return h('div', { className: 'form-field' }, h('label', { for: id }, label), h('div', { className: 'input-with-action' }, input, reveal), h('small', { id: `${id}-hint`, className: 'field-hint' }, hint), error);
  }
  const title = register ? '创建日记账号' : recover ? '找回密码' : '登录日记本';
  const form = h('form', { className: 'auth-form', novalidate: true },
    field('username', '账号', { autocomplete: 'username', hint: '3–32 位字母、数字及 ._-，不区分大小写' }),
    recover && field('recoveryCode', '恢复码', { autocomplete: 'off', hint: '使用你曾保存的恢复码，不是手机验证码' }),
    field('password', recover ? '新密码' : '密码', { password: true, autocomplete: register || recover ? 'new-password' : 'current-password', hint: register || recover ? '12–128 个字符，可以粘贴或使用密码管理器' : undefined }),
    (register || recover) && field('confirmation', recover ? '确认新密码' : '确认密码', { password: true, autocomplete: 'new-password' }), alert,
    h('button', { className: 'button primary full-width auth-submit', type: 'submit' }, recover ? '重置密码' : register ? '创建账号' : '登录'));
  const links = h('div', { className: 'auth-links' },
    button(register || recover ? '返回登录' : '创建账号', () => { if (!busy) navigate(register || recover ? '/login' : '/register'); }, { className: 'text-button' }),
    !recover && !register && button('忘记密码', () => { if (!busy) navigate('/recover'); }, { className: 'text-button' }));
  const root = h('main', { id: 'main', tabindex: '-1', className: 'auth-layout' },
    h('section', { className: 'auth-intro', 'aria-label': '日记本' }, h('div', { className: 'auth-brand' }, icon('book', 32), '日记'), h('h1', {}, '给每一天，', h('br'), '留一页。'), h('p', {}, '记录自己的生活，慢慢翻阅。')),
    h('section', { className: 'auth-panel' }, h('div', { className: 'auth-card' }, h('h2', {}, title), h('p', { className: 'muted' }, recover ? '重置成功后，所有已登录设备都会退出。' : '只使用账号和密码。'), form, links,
      h('div', { className: 'auth-local' }, button('继续使用本机学习空间', () => { if (!busy) continueLocal(); }, { className: 'text-button', glyph: 'offline' }), h('p', { className: 'field-hint' }, '原有本机日记会保留，不会自动迁入新账号。')))));
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    busy = true; alert.hidden = true;
    for (const { input, error } of fields.values()) { input.removeAttribute('aria-invalid'); error.hidden = true; }
    const values = Object.fromEntries([...fields].map(([key, { input }]) => [key, input.value]));
    root.querySelectorAll('input,button').forEach((control) => { control.disabled = true; });
    try { await submit(values); }
    catch (error) {
      alert.textContent = error.retryAfter ? `${error.message} 请在约 ${Math.ceil(error.retryAfter / 60)} 分钟后再试。` : error.message || '暂时无法完成，请稍后重试。';
      alert.hidden = false;
      for (const [key, message] of Object.entries(error.fields ?? {})) {
        const field = fields.get(key); if (!field) continue;
        field.input.setAttribute('aria-invalid', 'true'); field.error.textContent = message; field.error.hidden = false;
      }
    } finally {
      busy = false;
      if (root.isConnected) root.querySelectorAll('input,button').forEach((control) => { control.disabled = false; });
      else for (const { input } of fields.values()) input.value = '';
    }
  });
  return root;
}

export function createRecoveryPage({ code, generate, continueWriting, skip, account }) {
  const value = h('textarea', { className: 'recovery-code', readonly: true, 'aria-label': '一次性显示的恢复码', spellcheck: 'false', rows: 3 });
  value.value = code || '';
  const saved = h('input', { type: 'checkbox', id: 'recovery-saved' });
  const next = button('已保存，继续', continueWriting, { className: 'button primary', disabled: true });
  saved.addEventListener('change', () => { next.disabled = !saved.checked; });
  return h('main', { id: 'main', tabindex: '-1', className: 'onboarding-page' }, h('section', { className: 'settings-card recovery-card' },
    h('p', { className: 'eyebrow' }, account), h('h1', {}, '请保存你的恢复码'),
    h('p', {}, '忘记密码时，可以用它重置。不要发给别人；服务端不会保存可以重新显示的明文。'),
    code ? [value,
      h('div', { className: 'dialog-actions' }, button('复制恢复码', async () => {
        try { await navigator.clipboard.writeText(code); toast('已复制，请存入你信任的位置。'); }
        catch { value.focus(); value.select(); toast('请手动复制选中的恢复码。'); }
      }), button('下载恢复码', async () => {
        try { await downloadFile('日记恢复码.txt', `日记账号：${account}\n恢复码：${code}\n此码可用于重置密码，请私密保存。`, 'text/plain;charset=utf-8'); toast('请确认文件已保存。'); }
        catch (error) { toast(error.message); }
      }, { glyph: 'download' })),
      h('label', { className: 'checkbox-row', for: 'recovery-saved' }, saved, '我已把恢复码保存在安全的位置'), next,
    ] : [h('p', { className: 'notice' }, '此页面不会重新显示之前的恢复码。如未保存，请验证密码后生成新码；新码使旧码失效。'), button('验证密码并生成新码', generate, { className: 'button primary' })],
    button('暂时跳过', skip, { className: 'text-button' })));
}

export function askPassword(message) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': '当前密码' });
    const form = h('form', {}, h('h2', {}, '再次验证密码'), h('p', {}, message), h('label', { className: 'form-field' }, h('span', {}, '当前密码'), input), h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), h('button', { type: 'submit', className: 'button primary' }, '继续')));
    const dialog = h('dialog', { className: 'confirmation' }, form);
    form.addEventListener('submit', (event) => { event.preventDefault(); settled = true; const password = input.value; input.value = ''; dialog.close(); resolve(password); });
    dialog.addEventListener('close', () => { input.value = ''; dialog.remove(); if (!settled) resolve(null); });
    document.body.append(dialog); dialog.showModal(); input.focus();
  });
}
