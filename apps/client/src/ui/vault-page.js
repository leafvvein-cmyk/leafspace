import { h, button, downloadFile, toast } from './dom.js';
import { analyzeVaultHealth, generateTotp, generateVaultPassword, totpRemainingSeconds } from '../services/vault-crypto.js';

function passwordInput(label, autocomplete = 'off', required = true) {
  const input = h('input', { type: 'password', autocomplete, required, 'aria-label': label });
  const toggle = button('显示', () => { input.type = input.type === 'password' ? 'text' : 'password'; toggle.textContent = input.type === 'password' ? '显示' : '隐藏'; }, { className: 'text-button compact' });
  return { input, node: h('label', { className: 'form-field' }, h('span', {}, label), h('div', { className: 'password-field' }, input, toggle)) };
}

async function copySensitive(value, label) {
  await navigator.clipboard.writeText(value); toast(`${label}已复制，30 秒后会尝试清除`);
  setTimeout(async () => {
    try { if (await navigator.clipboard.readText() === value) await navigator.clipboard.writeText(''); } catch { /* Clipboard cleanup is best effort. */ }
  }, 30000);
}

function showRecoveryKey(value, message = '这是新的密码本恢复密钥，只显示这一次。') {
  const field = h('textarea', { readonly: true, rows: 5, 'aria-label': '一次性显示的密码本恢复密钥' }, value);
  const saved = h('input', { type: 'checkbox' });
  const done = button('我已安全保存', () => { if (saved.checked) dialog.close(); }, { className: 'button primary', disabled: true });
  saved.addEventListener('change', () => { done.disabled = !saved.checked; });
  const dialog = h('dialog', { className: 'vault-dialog' }, h('div', { className: 'vault-form' }, h('h2', {}, '保存密码本恢复密钥'),
    h('p', { className: 'notice' }, message), h('p', { className: 'muted' }, '它可以绕过旧保险库密码，请不要截图上传，也不要与密码本备份放在同一位置。新密钥生成后，旧恢复密钥立即失效。'),
    field, h('div', { className: 'dialog-actions' }, button('复制恢复密钥', () => copySensitive(value, '恢复密钥'), { className: 'button subtle' }),
      button('下载文本文件', () => downloadFile(`密码本恢复密钥-${new Date().toISOString().slice(0, 10)}.txt`, `${value}\n`), { className: 'button subtle' })),
    h('label', { className: 'checkbox-row' }, saved, '我已把恢复密钥保存在安全位置'), done));
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.addEventListener('close', () => { field.value = ''; value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); field.focus(); field.select();
}

function rotateRecoveryDialog(controller) {
  const current = passwordInput('确认保险库密码', 'current-password');
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
  const submit = h('button', { type: 'submit', className: 'button primary' }, '生成并使旧密钥失效');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { className: 'vault-form' }, h('h2', {}, '换发恢复密钥'),
    h('p', { className: 'muted' }, '需要当前保险库密码。生成成功后只显示一次，旧恢复密钥将不能再使用。'), current.node, alert,
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try {
      const recoveryKey = await controller.rotateRecoveryKey(current.input.value); current.input.value = ''; dialog.close();
      showRecoveryKey(recoveryKey, '新的恢复密钥已经生成，旧恢复密钥已失效。');
      controller.sync().catch(() => toast('新恢复设置已保存在本机，联网后可再次同步'));
    } catch (error) { current.input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; current.input.focus(); }
  });
  dialog.addEventListener('close', () => { current.input.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); current.input.focus();
}

function showDataKeyRotationRecovery(controller, refresh, recoveryKey) {
  const field = h('textarea', { readonly: true, rows: 5, 'aria-label': '数据密钥轮换后的密码本恢复密钥' }, recoveryKey);
  const saved = h('input', { type: 'checkbox' }), alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
  const start = button('已保存，开始原子轮换', async () => {
    start.disabled = true; cancel.disabled = true; alert.hidden = true;
    try {
      await controller.confirmDataKeyRotation(); field.value = ''; recoveryKey = ''; dialog.close();
      toast('全部账号已使用新的数据密钥重新加密，旧恢复密钥已经失效'); await refresh();
    } catch (error) {
      field.value = ''; recoveryKey = ''; dialog.close(); await refresh(); toast(error.message);
    }
  }, { className: 'button primary', disabled: true });
  const cancel = button('取消轮换', async () => {
    cancel.disabled = true; start.disabled = true;
    try { await controller.cancelDataKeyRotation(); field.value = ''; recoveryKey = ''; dialog.close(); toast('未改变现有数据密钥'); }
    catch (error) { alert.textContent = error.message; alert.hidden = false; cancel.disabled = false; }
  }, { className: 'button subtle' });
  saved.addEventListener('change', () => { start.disabled = !saved.checked; });
  const dialog = h('dialog', { className: 'vault-dialog' }, h('div', { className: 'vault-form' }, h('h2', {}, '保存新的恢复密钥'),
    h('p', { className: 'notice' }, '尚未改变现有密码本。只有保存新恢复密钥并点击开始后，才会向服务器分批暂存新密文并原子切换。'),
    h('p', { className: 'muted' }, '提交成功后，旧数据密钥和旧恢复密钥都不能读取新密文。过程中将暂时锁定密码本；网络中断会使用原请求编号安全重试。'),
    field, h('div', { className: 'dialog-actions' }, button('复制恢复密钥', () => copySensitive(recoveryKey, '恢复密钥'), { className: 'button subtle' }),
      button('下载文本文件', () => downloadFile(`密码本轮换恢复密钥-${new Date().toISOString().slice(0, 10)}.txt`, `${recoveryKey}\n`), { className: 'button subtle' })),
    h('label', { className: 'checkbox-row' }, saved, '我已把新的恢复密钥保存在安全位置'), alert,
    h('div', { className: 'dialog-actions' }, cancel, start)));
  dialog.addEventListener('cancel', (event) => event.preventDefault());
  dialog.addEventListener('close', () => { field.value = ''; recoveryKey = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); field.focus(); field.select();
}

function rotateDataKeyDialog(controller, refresh) {
  const current = passwordInput('确认保险库密码', 'current-password');
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
  const submit = h('button', { type: 'submit', className: 'button primary' }, '验证并准备轮换');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { className: 'vault-form' }, h('h2', {}, '轮换全部数据密钥'),
    h('p', { className: 'notice' }, '这是高级安全操作，会为所有 App 和网站账号生成全新的随机数据密钥并逐条重新加密。'),
    h('p', { className: 'muted' }, '开始前必须完成云同步并处理冲突。系统会先在本机验证全部密文；任何记录损坏都不会产生部分轮换。'),
    current.node, alert, h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try {
      const recoveryKey = await controller.prepareDataKeyRotation(current.input.value); current.input.value = ''; dialog.close();
      showDataKeyRotationRecovery(controller, refresh, recoveryKey);
    } catch (error) { current.input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; current.input.focus(); }
  });
  dialog.addEventListener('close', () => { current.input.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); current.input.focus();
}

function recoverDialog(controller, refresh) {
  const recovery = h('textarea', { rows: 5, required: true, autocomplete: 'off', spellcheck: false, 'aria-label': '密码本恢复密钥' });
  const next = passwordInput('新保险库密码', 'new-password'), confirmation = passwordInput('确认新保险库密码', 'new-password');
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
  const submit = h('button', { type: 'submit', className: 'button primary' }, '恢复并设置新密码');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { className: 'vault-form' }, h('h2', {}, '使用恢复密钥'),
    h('p', { className: 'muted' }, '验证成功后会设置新保险库密码并换发恢复密钥，旧恢复密钥立即失效。'),
    h('label', { className: 'form-field' }, h('span', {}, '密码本恢复密钥'), recovery), next.node, confirmation.node, alert,
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try {
      if (next.input.value !== confirmation.input.value) throw new Error('两次输入的新保险库密码不一致');
      const newRecoveryKey = await controller.recover(recovery.value, next.input.value);
      recovery.value = ''; next.input.value = ''; confirmation.input.value = ''; dialog.close(); await refresh();
      showRecoveryKey(newRecoveryKey, '密码本已经恢复。请保存新恢复密钥，旧密钥已经失效。');
      controller.sync().catch(() => toast('恢复后的密钥设置已保存在本机，联网后可再次同步'));
    } catch (error) { recovery.value = ''; next.input.value = ''; confirmation.input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; recovery.focus(); }
  });
  dialog.addEventListener('close', () => { recovery.value = ''; next.input.value = ''; confirmation.input.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); recovery.focus();
}

function itemDialog(controller, refresh, existing) {
  const item = existing?.item ?? { type: 'website', serviceName: '', username: '', password: '', loginUrl: '', appIdentifier: '', note: '', tags: [], favorite: false,
    otpSecret: '', otpDigits: 6, otpPeriod: 30 };
  const type = h('select', { 'aria-label': '账号类型' }, h('option', { value: 'website' }, '网站账号'), h('option', { value: 'app' }, 'App 账号'));
  type.value = item.type;
  const serviceName = h('input', { value: item.serviceName, required: true, maxlength: 120, autocomplete: 'off' });
  const username = h('input', { value: item.username, required: true, maxlength: 300, autocomplete: 'off', 'aria-label': '登录账号' });
  const secret = passwordInput('密码', 'new-password'); secret.input.value = item.password;
  const generate = button('生成强密码', () => {
    secret.input.value = generateVaultPassword(); secret.input.type = 'text';
    const toggle = secret.node.querySelector('.password-field .text-button');
    if (toggle) toggle.textContent = '隐藏';
    secret.input.dispatchEvent(new Event('input', { bubbles: true }));
    toast('已在本机生成 24 位强密码，请保存记录后再离开');
  }, { className: 'text-button compact' });
  secret.node.querySelector('.password-field').append(generate);
  const loginUrl = h('input', { value: item.loginUrl, maxlength: 2048, type: 'url', inputmode: 'url', placeholder: 'https://example.com/login', autocomplete: 'off' });
  const appIdentifier = h('input', { value: item.appIdentifier, maxlength: 300, placeholder: '例如 com.example.app', autocomplete: 'off' });
  const note = h('textarea', { maxlength: 5000, rows: 4, autocomplete: 'off' }, item.note);
  const tags = h('input', { value: (item.tags ?? []).join('，'), maxlength: 640, autocomplete: 'off', placeholder: '例如：工作，社交，购物' });
  const otpSecret = passwordInput('动态验证码密钥（可选）', 'off', false); otpSecret.input.value = item.otpSecret ?? '';
  const otpDigits = h('select', { 'aria-label': '动态验证码位数' }, h('option', { value: '6' }, '6 位'), h('option', { value: '8' }, '8 位'));
  otpDigits.value = String(item.otpDigits ?? 6);
  const otpPeriod = h('select', { 'aria-label': '动态验证码周期' }, h('option', { value: '30' }, '30 秒'), h('option', { value: '60' }, '60 秒'));
  otpPeriod.value = String(item.otpPeriod ?? 30);
  const favorite = h('input', { type: 'checkbox', checked: item.favorite });
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
  const conditional = h('div');
  const renderConditional = () => conditional.replaceChildren(type.value === 'website'
    ? h('label', { className: 'form-field' }, h('span', {}, '登录地址（可选）'), loginUrl)
    : h('label', { className: 'form-field' }, h('span', {}, 'App 标识（可选）'), appIdentifier));
  type.addEventListener('change', renderConditional); renderConditional();
  const submit = h('button', { type: 'submit', className: 'button primary' }, existing ? '保存修改' : '加密保存');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { method: 'dialog', className: 'vault-form' },
    h('h2', {}, existing ? '编辑账号记录' : '添加账号记录'),
    h('label', { className: 'form-field' }, h('span', {}, '类型'), type),
    h('label', { className: 'form-field' }, h('span', {}, '应用或网站名称'), serviceName),
    h('label', { className: 'form-field' }, h('span', {}, '登录账号（手机号、邮箱或用户名）'), username), secret.node, conditional,
    h('label', { className: 'form-field' }, h('span', {}, '备注（可选）'), note),
    h('label', { className: 'form-field' }, h('span', {}, '标签（可选，用逗号分隔）'), tags),
    h('details', { className: 'vault-otp-settings' }, h('summary', {}, '动态验证码 TOTP（可选）'),
      h('p', { className: 'muted' }, '输入验证器提供的 Base32 密钥。密钥与账号一起端到端加密，不会作为明文字段上传。'), otpSecret.node,
      h('div', { className: 'form-grid' }, h('label', { className: 'form-field' }, h('span', {}, '位数'), otpDigits),
        h('label', { className: 'form-field' }, h('span', {}, '周期'), otpPeriod))),
    h('label', { className: 'checkbox-row' }, favorite, '收藏'), alert,
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try {
      await controller.save({ type: type.value, serviceName: serviceName.value, username: username.value, password: secret.input.value,
        loginUrl: loginUrl.value, appIdentifier: appIdentifier.value, note: note.value,
        tags: tags.value.split(/[,，]/).map((value) => value.trim()).filter(Boolean), favorite: favorite.checked,
        otpSecret: otpSecret.input.value, otpDigits: Number(otpDigits.value), otpPeriod: Number(otpPeriod.value) }, existing?.record);
      secret.input.value = ''; otpSecret.input.value = ''; dialog.close(); toast(existing ? '账号记录已加密更新' : '账号记录已加密保存'); await refresh();
      controller.sync().then(refresh).catch(() => toast('已安全保存在本机，联网后可再次同步'));
    } catch (error) { alert.textContent = error.message; alert.hidden = false; submit.disabled = false; }
  });
  dialog.addEventListener('close', () => { secret.input.value = ''; otpSecret.input.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); serviceName.focus();
}

function changePasswordDialog(controller, refresh) {
  const current = passwordInput('当前保险库密码', 'current-password'), next = passwordInput('新保险库密码', 'new-password'), confirmation = passwordInput('确认新保险库密码', 'new-password');
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true }), submit = h('button', { type: 'submit', className: 'button primary' }, '更换保险库密码');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { className: 'vault-form' }, h('h2', {}, '更换保险库密码'),
    h('p', { className: 'muted' }, '只重新包装随机数据密钥，不会把保险库密码或账号明文上传到服务器。'), current.node, next.node, confirmation.node, alert,
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); alert.hidden = true; submit.disabled = true;
    try {
      if (next.input.value !== confirmation.input.value) throw new Error('两次输入的新保险库密码不一致');
      if (current.input.value === next.input.value) throw new Error('新保险库密码需要与当前密码不同');
      await controller.changePassword(current.input.value, next.input.value);
      current.input.value = ''; next.input.value = ''; confirmation.input.value = ''; dialog.close(); toast('保险库密码已在本机更换'); await refresh();
      controller.sync().then(refresh).catch(() => toast('新密码已保存在本机，联网后可再次同步'));
    } catch (error) { alert.textContent = error.message; alert.hidden = false; submit.disabled = false; }
  });
  dialog.addEventListener('close', () => { current.input.value = ''; next.input.value = ''; confirmation.input.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); current.input.focus();
}

function exportDialog(controller) {
  const secret = passwordInput('确认保险库密码', 'current-password');
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true }), submit = h('button', { type: 'submit', className: 'button primary' }, '下载加密备份');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { className: 'vault-form' }, h('h2', {}, '导出密码本加密备份'),
    h('p', { className: 'muted' }, '文件只包含密钥包装参数和账号密文。恢复时仍需当前保险库密码。'), secret.node, alert,
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try {
      const backup = await controller.exportEncrypted(secret.input.value), day = new Date().toISOString().slice(0, 10);
      secret.input.value = ''; await downloadFile(`密码本加密备份-${day}.json`, backup); dialog.close(); toast('加密备份已交给系统保存，请同时保管好保险库密码');
    } catch (error) { secret.input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; secret.input.focus(); }
  });
  dialog.addEventListener('close', () => { secret.input.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); secret.input.focus();
}

function importDialog(controller, refresh) {
  const file = h('input', { type: 'file', accept: '.json,application/json', required: true, 'aria-label': '选择密码本加密备份' });
  const secret = passwordInput('备份的保险库密码', 'current-password');
  const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true }), submit = h('button', { type: 'submit', className: 'button primary' }, '验证并导入');
  const dialog = h('dialog', { className: 'vault-dialog' }, h('form', { className: 'vault-form' }, h('h2', {}, '导入密码本加密备份'),
    h('p', { className: 'muted' }, '只可导入到空密码本。系统会先用密码验证全部密文，验证失败时不会写入任何记录。'),
    h('label', { className: 'form-field' }, h('span', {}, '加密备份文件'), file), secret.node, alert,
    h('div', { className: 'dialog-actions' }, button('取消', () => dialog.close()), submit)));
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); submit.disabled = true; alert.hidden = true;
    try {
      const selected = file.files?.[0]; if (!selected) throw new Error('请选择密码本加密备份');
      if (selected.size > 25 * 1024 * 1024) throw new Error('加密备份不能超过 25 MB');
      const count = await controller.importEncrypted(await selected.text(), secret.input.value);
      secret.input.value = ''; file.value = ''; dialog.close(); toast(`已验证并导入 ${count} 条加密账号记录`); await refresh();
      controller.sync().then(refresh).catch(() => toast('备份已安全导入本机，联网后可再次同步'));
    } catch (error) { secret.input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; secret.input.focus(); }
  });
  dialog.addEventListener('close', () => { secret.input.value = ''; file.value = ''; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); file.focus();
}

export async function vaultPage({ controller, alive }) {
  const root = h('section', { className: 'page vault-page' });
  let renderId = 0, syncError = null, concealVisible = () => {};
  async function render() {
    concealVisible(); concealVisible = () => {};
    const version = ++renderId;
    const config = await controller.config(); if (!alive() || version !== renderId) return;
    if (!config) {
      const first = passwordInput('创建保险库密码', 'new-password'), second = passwordInput('确认保险库密码', 'new-password');
      const acknowledgement = h('input', { type: 'checkbox' });
      const alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
      const submit = h('button', { type: 'submit', className: 'button primary' }, '创建并解锁');
      const form = h('form', { className: 'vault-auth-card' }, h('p', { className: 'eyebrow' }, '独立加密空间'), h('h1', {}, '创建密码本'),
        h('p', {}, '这个密码与日记账号密码不同。创建后会一次性显示独立恢复密钥。'), first.node, second.node,
        h('label', { className: 'checkbox-row' }, acknowledgement, '我明白：必须把恢复密钥与加密备份分开保管'), alert, submit,
        button('从加密备份恢复', () => importDialog(controller, render), { className: 'button subtle' }));
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); alert.hidden = true;
        try {
          if (first.input.value !== second.input.value) throw new Error('两次输入的保险库密码不一致');
          if (!acknowledgement.checked) throw new Error('请先确认恢复密钥保管说明');
          submit.disabled = true; const recoveryKey = await controller.initialize(first.input.value); first.input.value = ''; second.input.value = ''; await render();
          showRecoveryKey(recoveryKey);
          controller.sync().then(render).catch(() => toast('密码本已在本机创建，联网后可再次同步'));
        } catch (error) { alert.textContent = error.message; alert.hidden = false; submit.disabled = false; }
      });
      root.replaceChildren(form); first.input.focus(); return;
    }
    if (!controller.unlocked) {
      const secret = passwordInput('保险库密码', 'current-password'), alert = h('p', { role: 'alert', className: 'form-alert', hidden: true });
      const submit = h('button', { type: 'submit', className: 'button primary' }, '解锁密码本');
      const form = h('form', { className: 'vault-auth-card' }, h('p', { className: 'eyebrow' }, '已加密'), h('h1', {}, '密码本已锁定'),
        h('p', {}, '解锁只在当前运行内存中保留密钥；切到后台或闲置 5 分钟会再次锁定。'), secret.node, alert, submit,
        config.recoveryVersion ? button('忘记密码，使用恢复密钥', () => recoverDialog(controller, render), { className: 'button subtle' }) : null);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); submit.disabled = true; alert.hidden = true;
        try { await controller.unlock(secret.input.value); secret.input.value = ''; await render(); }
        catch (error) { secret.input.value = ''; alert.textContent = error.message; alert.hidden = false; submit.disabled = false; secret.input.focus(); }
      });
      root.replaceChildren(form); secret.input.focus(); return;
    }
    const [bundles, syncSummary] = await Promise.all([controller.list(), controller.syncSummary()]); if (!alive() || version !== renderId) return;
    const conflicts = syncSummary.conflicts ? await controller.conflicts() : []; if (!alive() || version !== renderId) return;
    const health = analyzeVaultHealth(bundles);
    const availableTags = [...new Set(bundles.flatMap(({ item }) => item?.tags ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const search = h('input', { type: 'search', placeholder: '搜索名称、账号、地址或备注', 'aria-label': '搜索密码本', autocomplete: 'off' });
    const filter = h('select', { 'aria-label': '筛选账号记录' }, h('option', { value: '' }, '全部账号'), h('option', { value: 'app' }, '仅 App'),
      h('option', { value: 'website' }, '仅网站'), h('option', { value: 'favorite' }, '仅收藏'),
      h('option', { value: 'issues' }, `需要检查（${health.issueIds.size}）`),
      ...availableTags.map((tag) => h('option', { value: `tag:${tag}` }, `标签：${tag}`)));
    const healthNote = h('p', { className: 'vault-health-note', role: 'status' }, health.issueIds.size
      ? `本机检查发现 ${health.weakIds.size} 条密码较短或组合简单，${health.reusedIds.size} 条记录使用了重复密码，${health.damagedIds.size} 条密文无法读取。`
      : '本机检查未发现短密码、简单密码或重复密码。');
    const cards = h('div', { className: 'vault-grid' });
    const draw = () => {
      concealVisible();
      const hiders = [];
      const query = search.value.trim().toLocaleLowerCase(), selected = filter.value;
      const visible = bundles.filter(({ item, record }) => (!query || (item
        ? [item.serviceName, item.username, item.loginUrl, item.appIdentifier, item.note, item.tags.join(' ')].some((value) => value.toLocaleLowerCase().includes(query))
        : record.id.toLocaleLowerCase().includes(query))) && (!selected || selected === item?.type
          || selected === 'favorite' && item?.favorite || selected === 'issues' && health.issueIds.has(record.id)
          || selected.startsWith('tag:') && item?.tags.includes(selected.slice(4))))
        .sort((a, b) => Number(Boolean(b.item)) - Number(Boolean(a.item)) || Number(b.item?.favorite) - Number(a.item?.favorite)
          || (a.item?.serviceName ?? '').localeCompare(b.item?.serviceName ?? '', 'zh-CN'));
      cards.replaceChildren(...visible.map((bundle) => {
        const { item, record } = bundle, password = h('span', { className: 'vault-secret' }, '••••••••'); let shown = false, cancelHide = null;
        if (!item) return h('article', { className: 'vault-card vault-card-damaged' }, h('div', { className: 'vault-card-heading' },
          h('span', { className: 'vault-kind' }, '异常'), h('h2', {}, '无法读取的账号记录')), h('p', { className: 'vault-account' }, `记录编号：${record.id}`),
          h('p', {}, '这条密文可能已损坏。其他账号仍可正常使用；请先保留当前设备数据和已有加密备份，不要反复同步或立即删除。'),
          h('div', { className: 'vault-card-actions' }, button('删除损坏记录', async () => {
            if (!confirm(`删除损坏记录 ${record.id}？删除后可能无法恢复，建议先保留现有数据和备份。`)) return;
            await controller.remove(record); toast('损坏记录已删除'); await render();
            controller.sync().then(render).catch(() => toast('删除已保存在本机，联网后可再次同步'));
          }, { className: 'text-button compact danger-text' })));
        const hide = () => { shown = false; password.textContent = '••••••••'; reveal.textContent = '查看密码'; cancelHide?.(); cancelHide = null; };
        const reveal = button('查看密码', () => {
          if (shown) { hide(); return; }
          shown = true; password.textContent = item.password; reveal.textContent = '隐藏密码';
          cancelHide = controller.protectSensitive(hide);
        }, { className: 'text-button compact' });
        hiders.push(hide);
        const otp = item.otpSecret ? h('span', { className: 'vault-secret', hidden: true, 'aria-label': '当前动态验证码' }) : null;
        let otpCancel = null;
        const hideOtp = () => { if (!otp) return; otp.hidden = true; otp.textContent = ''; otpCancel?.(); otpCancel = null; };
        const revealOtp = item.otpSecret ? button('显示动态验证码', async () => {
          if (!otp.hidden) { hideOtp(); return; }
          const remaining = totpRemainingSeconds(Date.now(), item.otpPeriod);
          otp.textContent = `${await generateTotp(item.otpSecret, { digits: item.otpDigits, period: item.otpPeriod })} · ${remaining} 秒内有效`;
          otp.hidden = false; otpCancel = controller.protectSensitive(hideOtp, remaining * 1000);
        }, { className: 'text-button compact' }) : null;
        hiders.push(hideOtp);
        const actions = h('div', { className: 'vault-card-actions' }, reveal, revealOtp,
          button('复制账号', () => copySensitive(item.username, '账号').catch((error) => toast(error.message)), { className: 'text-button compact' }),
          button('复制密码', () => copySensitive(item.password, '密码').catch((error) => toast(error.message)), { className: 'text-button compact' }),
          button('编辑', () => itemDialog(controller, render, bundle), { className: 'text-button compact' }),
          button('删除', async () => { if (!confirm(`删除“${item.serviceName}”的这条账号记录？`)) return; await controller.remove(record); toast('账号记录已删除'); await render();
            controller.sync().then(render).catch(() => toast('删除已保存在本机，联网后可再次同步')); }, { className: 'text-button compact danger-text' }));
        const warnings = h('div', { className: 'vault-health-badges' }, health.weakIds.has(record.id) ? h('span', {}, '密码需要检查') : null,
          health.reusedIds.has(record.id) ? h('span', {}, '与其他记录重复') : null);
        return h('article', { className: 'vault-card' }, h('div', { className: 'vault-card-heading' }, h('span', { className: 'vault-kind' }, item.type === 'app' ? 'APP' : 'WEB'),
          h('h2', {}, `${item.favorite ? '★ ' : ''}${item.serviceName}`)), h('p', { className: 'vault-account' }, item.username), h('div', { className: 'vault-password-row' }, password), otp,
          item.tags.length ? h('div', { className: 'vault-tags', 'aria-label': '账号标签' }, ...item.tags.map((tag) => h('span', {}, tag))) : null,
          warnings,
          item.loginUrl && button('打开登录页', () => { if (confirm('即将在新窗口打开这个地址，是否继续？')) window.open(item.loginUrl, '_blank', 'noopener,noreferrer'); }, { className: 'text-button compact' }),
          item.appIdentifier && h('p', { className: 'muted' }, `App 标识：${item.appIdentifier}`), item.note && h('p', { className: 'vault-note' }, item.note), actions);
      }), ...(!visible.length ? [h('p', { className: 'empty-inline' }, query ? '没有匹配的账号记录。' : '还没有账号记录，点击“添加账号”开始。')] : []));
      concealVisible = () => { for (const hide of hiders) hide(); };
    };
    search.addEventListener('input', draw); filter.addEventListener('change', draw); draw();
    const conflictSection = conflicts.length ? h('section', { className: 'vault-conflicts', 'aria-label': '密码本冲突' }, h('h2', {}, '需要选择的跨设备修改'),
      ...conflicts.map((conflict) => {
        if (conflict.itemId === 'config') return h('article', { className: 'vault-conflict-card' }, h('strong', {}, '保险库密钥设置冲突'),
          h('p', {}, '两台设备创建了不同的保险库。为避免永久丢失，系统没有自动覆盖；请暂时保留两台设备。'));
        const localName = conflict.localItem?.serviceName ?? '本机删除版本', remoteName = conflict.remoteItem?.serviceName ?? '云端删除版本';
        return h('article', { className: 'vault-conflict-card' }, h('strong', {}, localName),
          h('p', {}, `本机：${conflict.localItem ? `${conflict.localItem.username} · ${conflict.localItem.note || '无备注'}` : '已删除'}`),
          h('p', {}, `云端：${conflict.remoteItem ? `${conflict.remoteItem.username} · ${conflict.remoteItem.note || '无备注'}` : '已删除'}`),
          h('div', { className: 'page-actions' }, button('保留本机版本', async () => { await controller.resolveConflict(conflict.id, 'local'); toast('已保留本机版本并重新加密同步'); await render(); }, { className: 'button' }),
            button(`保留云端版本：${remoteName}`, async () => { await controller.resolveConflict(conflict.id, 'cloud'); toast('已采用云端版本'); await render(); }, { className: 'button subtle' })));
      })) : null;
    const header = h('header', { className: 'page-header vault-header' }, h('div', {}, h('p', { className: 'eyebrow' }, '仅在本机解密'), h('h1', {}, '密码本'),
      h('p', { className: 'muted' }, '保存 App 和网站账号；普通日记备份不会包含这些记录。')),
      h('div', { className: 'page-actions' }, button('导出加密备份', () => exportDialog(controller), { className: 'button subtle', glyph: 'download' }),
        button('更换密码', () => changePasswordDialog(controller, render), { className: 'button subtle' }),
        button(config.recoveryVersion ? '换发恢复密钥' : '生成恢复密钥', () => rotateRecoveryDialog(controller), { className: 'button subtle' }),
        controller.dataKeyRotationAvailable ? button('轮换数据密钥', () => rotateDataKeyDialog(controller, render), { className: 'button subtle' }) : null,
        button('锁定', () => controller.lock(), { className: 'button subtle' }), button('添加账号', () => itemDialog(controller, render), { className: 'button primary' })));
    const syncNode = (syncSummary.waiting || syncSummary.conflicts || syncError) ? h('p', { className: 'vault-sync-note', role: 'status' },
      syncSummary.conflicts ? `${syncSummary.conflicts} 条密码本修改发生跨设备冲突，已停止覆盖并保留双方密文。` : syncError ? `云同步暂不可用：${syncError}` : `${syncSummary.waiting} 条加密修改等待上传。`) : null;
    root.replaceChildren(...[header, syncNode, conflictSection, h('div', { className: 'vault-filters' }, search, filter), healthNote, cards,
      h('p', { className: 'vault-security-note' }, '风险提示只在解锁后的本机内存中计算，不会上传密码。它是基础检查，不能替代泄露数据库检测。账号设备间只同步密文，服务器不能读取服务名、账号或密码。请定期导出独立加密备份，并将备份文件与保险库密码分开保存。')].filter(Boolean));
  }
  try { await controller.sync(); } catch (error) { syncError = error.message; }
  await render();
  return root;
}
