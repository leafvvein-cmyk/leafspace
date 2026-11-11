import { h, button, toast } from './dom.js';

export async function privacyPage({ service, navigate, native, biometric }) {
  let { settings } = service.view(), busy = false;
  const biometricInfo = native && biometric
    ? await biometric.status().catch((error) => ({ available: false, reason: error.message || '系统身份验证当前不可用。' }))
    : null;
  const idle = h('select', {}, ...[1, 5, 15, 30].map((value) => h('option', { value }, `${value} 分钟`))); idle.value = String(settings.idleMinutes);
  const background = h('input', { type: 'checkbox', checked: settings.lockOnBackground });
  const status = h('p', { role: 'status', className: 'muted' });
  const pin = (label, autocomplete = 'off') => h('label', { className: 'form-field' }, h('span', {}, label), h('input', { type: 'password', inputmode: 'numeric', pattern: '\\d{6}', minlength: 6, maxlength: 6, autocomplete }));
  const root = h('div', { className: 'settings-layout privacy-page' }, h('section', { className: 'settings-card' },
    button('返回设置', () => navigate('/settings'), { className: 'text-button' }), h('p', { className: 'eyebrow' }, '当前设备'), h('h1', {}, '日记锁与隐私'),
    h('p', {}, native ? '日记锁会在 App 进入后台时立即遮挡正文。本机 PIN 验证信息保存在系统安全存储。' : '网页日记锁只遮挡界面，不能阻止能使用浏览器开发工具或读取 IndexedDB 的本机管理员。'),
    h('label', { className: 'setting-row' }, h('span', {}, '空闲后锁定'), idle),
    h('label', { className: 'setting-row' }, h('span', {}, native ? '进入后台立即锁定' : '网页切到后台立即锁定'), background),
    status));
  const card = root.firstElementChild;
  const run = async (action) => {
    if (busy) return; busy = true; root.querySelectorAll('button,input,select').forEach((control) => { control.disabled = true; }); status.textContent = '';
    try { await action(); settings = service.view().settings; toast('日记锁设置已保存'); }
    catch (error) { status.textContent = error.message; status.className = 'notice'; }
    finally { busy = false; if (root.isConnected) root.querySelectorAll('button,input,select').forEach((control) => { control.disabled = false; }); }
  };
  const saveOptions = button('保存锁定时机', () => run(() => service.update({ idleMinutes: Number(idle.value), lockOnBackground: background.checked })));
  if (!settings.enabled) {
    const first = pin('设置 6 位本机 PIN', 'new-password'), second = pin('再次输入 PIN', 'new-password');
    card.append(h('div', { className: 'lock-setup' }, first, second, button('开启日记锁', () => run(async () => {
      const values = [first, second].map((field) => field.querySelector('input').value);
      if (values[0] !== values[1]) throw new Error('两次 PIN 不一致');
      await service.enable(values[0], { idleMinutes: Number(idle.value), lockOnBackground: background.checked });
      await navigate('/settings/privacy', { replace: true });
    }), { className: 'button primary' })));
  } else {
    const current = pin('当前 PIN', 'current-password'), next = pin('新 6 位 PIN', 'new-password'), confirmation = pin('再次输入新 PIN', 'new-password');
    const disablePin = pin('输入当前 PIN 关闭日记锁', 'current-password');
    card.append(h('div', { className: 'account-actions' }, saveOptions, button('立即锁定', () => service.lock('manual'), { className: 'button primary' })),
      native && h('section', { className: 'settings-card' }, h('h2', {}, '系统身份验证'),
        h('p', {}, biometricInfo?.available
          ? `可使用${biometricInfo.label}解锁。启用前会先进行一次系统验证；日记不会读取或保存你的生物特征。`
          : `当前不可用：${biometricInfo?.reason || '设备未设置生物识别或锁屏密码。'} 本机 PIN 仍可正常使用。`),
        settings.systemUnlock
          ? button('关闭系统解锁', () => run(() => service.update({ systemUnlock: false })), { className: 'button' })
          : button('验证并启用系统解锁', () => run(async () => {
              if (!biometricInfo?.available || !biometric) throw new Error('当前设备不能使用系统身份验证。');
              if (!await biometric.authenticate()) throw new Error('已取消系统验证，设置未改变。');
              await service.update({ systemUnlock: true });
            }), { className: 'button', disabled: !biometricInfo?.available })),
      h('details', { className: 'settings-card' }, h('summary', {}, '修改本机 PIN'), current, next, confirmation,
        button('保存新 PIN', () => run(async () => {
          const first = next.querySelector('input').value, second = confirmation.querySelector('input').value;
          if (first !== second) throw new Error('两次新 PIN 不一致');
          await service.changePin(current.querySelector('input').value, first);
          [current, next, confirmation].forEach((field) => { field.querySelector('input').value = ''; });
        }))),
      h('details', { className: 'settings-card danger-zone' }, h('summary', {}, '关闭日记锁'), disablePin,
        h('p', { className: 'muted' }, '只关闭当前设备的界面锁，不会删除日记或退出账号。'),
        button('确认关闭', () => run(async () => { await service.disable(disablePin.querySelector('input').value); await navigate('/settings/privacy', { replace: true }); }), { className: 'button danger' })));
  }
  return root;
}
