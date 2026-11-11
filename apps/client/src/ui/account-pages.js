import { h, button } from './dom.js';

function frame(title, navigate, ...children) {
  return h('main', { id: 'main', tabindex: '-1', className: 'account-page' },
    h('nav', { className: 'account-actions', 'aria-label': '账号导航' }, button('返回日记', () => navigate('/today'), { glyph: 'back' }), button('账号与安全', () => navigate('/settings/account')), button('设备会话', () => navigate('/settings/devices'))),
    h('h1', {}, title), ...children);
}
function field(label, attributes) {
  const input = h('input', attributes);
  return { input, root: h('label', { className: 'form-field' }, h('span', {}, label), input) };
}
function actionState(root, alert, action) {
  let busy = false;
  return async (...args) => {
    if (busy || !root.isConnected) return; busy = true; alert.hidden = true;
    root.querySelectorAll('input,button').forEach((item) => { item.disabled = true; });
    try { await action(...args); }
    catch (error) { if (root.isConnected) { alert.textContent = error.message || '操作未完成。'; alert.hidden = false; } }
    finally { busy = false; if (root.isConnected) root.querySelectorAll('input,button').forEach((item) => { item.disabled = false; }); }
  };
}
export function accountPage({ profile, navigate, onProfile, onPassword, onRecovery, onLogout, onLocal, onDelete }) {
  const root = frame('账号与安全', navigate), alert = h('p', { className: 'form-alert', role: 'alert', hidden: true });
  const run = (action) => actionState(root, alert, action);
  const name = field('昵称', { name: 'displayName', value: profile.displayName, maxlength: 80, autocomplete: 'nickname' });
  const timezone = field('日记时区', { name: 'timezone', value: profile.timezone, placeholder: 'Asia/Shanghai' });
  const form = h('form', { className: 'auth-form' }, name.root, timezone.root, h('button', { type: 'submit', className: 'button primary' }, '保存资料'));
  const saveProfile = run(() => onProfile({ displayName: name.input.value, timezone: timezone.input.value }));
  form.addEventListener('submit', (event) => { event.preventDefault(); saveProfile(); });
  const password = field('新密码', { type: 'password', name: 'password', autocomplete: 'new-password', required: true });
  const confirmation = field('确认新密码', { type: 'password', name: 'confirmation', autocomplete: 'new-password', required: true });
  const passwordForm = h('form', { className: 'auth-form' }, h('p', { className: 'field-hint' }, '12–128 个字符。修改后，所有设备都需要重新登录。'), password.root, confirmation.root, h('button', { type: 'submit', className: 'button' }, '验证当前密码并修改'));
  const changePassword = run(() => onPassword({ password: password.input.value, confirmation: confirmation.input.value }));
  passwordForm.addEventListener('submit', (event) => { event.preventDefault(); changePassword(); });
  root.append(alert,
    h('section', { className: 'settings-card' }, h('h2', {}, profile.username), h('p', { className: 'muted' }, '账号名用于登录，不可在此修改。中文昵称不会放入请求凭据。'), form),
    h('section', { className: 'settings-card' }, h('h2', {}, '恢复码'), h('p', {}, profile.recoveryCodeConfigured ? '已设置恢复码。旧码无法重新显示，生成新码会使旧码失效。' : '尚无可用恢复码。忘记密码时需要它找回账号。'), button('验证密码并生成新码', run(onRecovery))),
    h('section', { className: 'settings-card' }, h('h2', {}, '修改密码'), passwordForm),
    h('section', { className: 'settings-card' }, h('h2', {}, '本机数据与退出'), h('p', { className: 'muted' }, '本机学习空间与账号日记分开保存。退出不会删除任何日记。'), h('div', { className: 'account-actions' }, button('查看本机学习空间', run(onLocal)), button('退出登录', run(onLogout), { className: 'button danger' }))),
    h('section', { className: 'settings-card danger-zone' }, h('h2', {}, '注销账号'), h('p', { className: 'muted' }, '永久停用账号并清理云端日记、图片和导出。开始前请先备份。'), button('查看注销说明', run(onDelete), { className: 'button danger' })));
  return root;
}

export function deleteAccountPage({ profile, navigate, onBackup, onDelete }) {
  const root = frame('注销账号', navigate), alert = h('p', { className: 'form-alert', role: 'alert', hidden: true });
  const confirmed = h('input', { type: 'checkbox' }), account = field(`输入账号 ${profile.username} 确认`, { autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const submit = button('验证密码并永久注销', () => run(), { className: 'button danger', disabled: true });
  const enable = () => { submit.disabled = !confirmed.checked || account.input.value.trim().toLowerCase() !== profile.username; };
  confirmed.addEventListener('change', enable); account.input.addEventListener('input', enable);
  const run = actionState(root, alert, async () => {
    if (!confirmed.checked || account.input.value.trim().toLowerCase() !== profile.username) throw new Error('请勾选确认并准确输入账号名');
    await onDelete();
  });
  root.append(alert,
    h('section', { className: 'settings-card danger-zone' }, h('h2', {}, '这是永久操作'),
      h('p', {}, '确认后账号会立即停用，所有设备退出。服务端随后清理云端正文、标签、图片、导出和同步数据。'),
      h('p', {}, '其他离线设备以及当前设备已经保存的本机副本不会被远程抹除；需要在对应设备上另行清理。滚动备份按运维保留周期自然到期。'),
      h('div', { className: 'account-actions' }, button('导出当前设备本机备份', onBackup, { glyph: 'download' }), button('创建云端完整导出', () => navigate('/settings/exports')))),
    h('section', { className: 'settings-card' }, account.root,
      h('label', { className: 'checkbox-row' }, confirmed, '我已完成所需备份，并确认永久注销这个账号'), submit));
  return root;
}

export function deletionReceiptPage({ receipt, refresh, navigate }) {
  const names = { requested: '已收到注销请求', processing: '正在清理云端数据', completed: '云端主数据已清理完成', failed: '清理暂未完成' };
  return h('main', { id: 'main', tabindex: '-1', className: 'account-page' }, h('section', { className: 'settings-card receipt-card' },
    h('p', { className: 'eyebrow' }, '只读清理回执'), h('h1', {}, names[receipt.status] ?? '注销状态待确认'),
    h('p', {}, receipt.status === 'completed' ? '账号身份和在线主数据已经清理，无法恢复登录。' : receipt.message || '账号已停用，后台任务会继续处理。'),
    h('p', { className: 'muted' }, `请求时间：${new Date(receipt.requestedAt).toLocaleString()}`),
    receipt.completedAt && h('p', { className: 'muted' }, `完成时间：${new Date(receipt.completedAt).toLocaleString()}`),
    h('p', {}, '本回执不包含账号名或日记内容。当前设备上的离线副本仍由你自行保管或清理。'),
    h('div', { className: 'account-actions' }, receipt.status !== 'completed' && button('刷新清理状态', refresh), button('返回登录页', () => navigate('/login')))));
}
export function devicesPage({ items, navigate, onRevoke, onRevokeOthers }) {
  const root = frame('设备会话', navigate), alert = h('p', { className: 'form-alert', role: 'alert', hidden: true });
  const format = (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const run = (action) => actionState(root, alert, action);
  root.append(alert, h('p', { className: 'muted' }, '这里只显示仍有效的登录会话。退出某台设备不会删除那台设备上的本机日记。'),
    h('section', { className: 'settings-card' }, items.map((item) => h('article', { className: 'session-card' },
      h('div', {}, h('h2', {}, `${item.name}${item.isCurrent ? ' · 当前会话' : ''}`), h('p', {}, `${item.platform} · 登录于 ${format(item.createdAt)}`), h('p', {}, `最近活动 ${format(item.lastSeenAt)}`)),
      !item.isCurrent && button('退出该设备', run(() => onRevoke(item.id)), { className: 'button danger' })))),
    items.some((item) => !item.isCurrent) && button('退出其他所有设备', run(onRevokeOthers), { className: 'button danger' }));
  return root;
}
