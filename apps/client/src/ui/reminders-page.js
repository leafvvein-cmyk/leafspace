import { h, button, toast } from './dom.js';

const WEEKDAYS = [['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 7]];

export async function remindersPage({ service, navigate, native }) {
  let settings = await service.load(), state = await service.permission(), busy = false;
  const enabled = h('input', { type: 'checkbox', checked: settings.enabled });
  const time = h('input', { type: 'time', value: settings.time, required: true });
  const policy = h('select', {}, h('option', { value: 'device' }, '跟随设备当地时间'), h('option', { value: 'fixed' }, `固定在 ${settings.timezone}`)); policy.value = settings.timezonePolicy;
  const dayInputs = WEEKDAYS.map(([label, value]) => [value, h('input', { type: 'checkbox', checked: settings.days.includes(value), 'aria-label': `星期${label}` })]);
  const status = h('p', { role: 'status', className: state === 'denied' ? 'notice' : 'muted' }, state === 'denied' ? '系统通知权限已拒绝。应用不会反复请求，请到系统设置中手动开启。' : native ? `系统权限：${state === 'granted' ? '已允许' : '尚未请求'}` : '电脑端只在日记页面打开时提醒；关闭浏览器后不会在后台通知。');
  const save = button('保存提醒', async () => {
    if (busy) return;
    const days = dayInputs.filter(([, input]) => input.checked).map(([value]) => value);
    if (enabled.checked && !days.length) { status.textContent = '请至少选择一天。'; status.className = 'notice'; return; }
    if (enabled.checked && native && state === 'prompt' && !window.confirm('开启后，系统会询问是否允许“日记”发送本地通知。通知只显示“给今天留一句话”，不包含标题或正文。继续吗？')) return;
    busy = true; save.disabled = true;
    try {
      const result = await service.save({ enabled: enabled.checked, time: time.value, days, timezonePolicy: policy.value, timezone: settings.timezone }, { requestPermission: true });
      settings = result.settings; state = result.permission; enabled.checked = settings.enabled;
      status.textContent = settings.enabled ? '提醒已保存在当前设备。系统可能受省电、专注模式或权限设置影响而延迟。' : state === 'denied' ? '系统权限未允许，提醒保持关闭。请到系统设置中手动开启后再回来保存。' : '提醒已关闭。';
      status.className = state === 'denied' ? 'notice' : 'muted'; toast(settings.enabled ? '提醒已保存' : '提醒已关闭');
    } catch (error) { status.textContent = error.message; status.className = 'notice'; }
    finally { busy = false; save.disabled = false; }
  }, { className: 'button primary' });
  const test = button('测试提醒', async () => {
    if (busy) return; busy = true; test.disabled = true;
    try { const result = await service.test(); status.textContent = result.delivered === 'scheduled' ? '测试通知将在约 5 秒后由系统显示。' : '已显示电脑端前台提醒。'; status.className = 'muted'; }
    catch (error) { status.textContent = error.message; status.className = 'notice'; }
    finally { busy = false; test.disabled = false; }
  });
  return h('div', { className: 'settings-layout reminders-page' }, h('section', { className: 'settings-card' },
    button('返回设置', () => navigate('/settings'), { className: 'text-button' }), h('p', { className: 'eyebrow' }, '当前设备'), h('h1', {}, '写作提醒'),
    h('p', {}, '提醒设置只保存在这台设备，不会自动开启其他电脑或手机。通知永远不显示日记标题和正文。'),
    h('label', { className: 'setting-row' }, h('span', {}, '开启每日提醒'), enabled),
    h('label', { className: 'setting-row' }, h('span', {}, '提醒时间'), time),
    h('fieldset', { className: 'weekday-picker' }, h('legend', {}, '提醒星期'), dayInputs.map(([value, input]) => h('label', {}, input, WEEKDAYS.find(([, day]) => day === value)[0]))),
    h('label', { className: 'setting-row' }, h('span', {}, '时区策略'), policy),
    h('p', { className: 'muted' }, '“跟随设备”适合旅行后仍按当地钟点提醒；“固定时区”按当前时区换算，手机会预排未来四周并在打开 App 时续排。系统不保证精确到秒。'),
    status, h('div', { className: 'account-actions' }, save, test)));
}
