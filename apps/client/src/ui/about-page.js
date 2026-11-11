import { h, button } from './dom.js';

export function aboutPage({ pwa, navigate, native, loadMeta, localSchema }) {
  const appVersion = typeof __DIARY_APP_VERSION__ === 'string' ? __DIARY_APP_VERSION__ : 'development';
  const root = h('main', { className: 'account-page', id: 'main', tabindex: '-1' }, button('返回日记', () => navigate('/today'), { glyph: 'back' }), h('h1', {}, '关于与安装'));
  const controls = h('section', { className: 'settings-card' });
  const versions = h('section', { className: 'settings-card version-details' }, h('h2', {}, '版本信息'),
    h('p', {}, `应用版本：${appVersion}`), h('p', {}, `运行平台：${native ? '手机 App' : 'Web / PWA'}`),
    h('p', {}, `本地数据库：v${localSchema.database} · 完整备份：v${localSchema.backup} · 正文格式：v${localSchema.content}`),
    h('p', { role: 'status', className: 'muted', 'data-api-version': true }, '正在读取 API 版本…'));
  root.append(controls,
    versions,
    h('section', { className: 'settings-card' }, h('h2', {}, '本机内容与离线'),
      h('p', {}, '离线页面缓存只包含程序，不包含账号接口响应、密码或日记正文。日记仍保存在独立本机数据库；清除站点数据可能同时删除日记，请先导出备份。'),
      h('p', {}, '账号空间已接入云端同步，可在同步中心查看结果；提前设置本机 PIN 后，断网时可打开该账号已保存在本机的副本，但云端认证、同步和账号安全操作仍需重新联网登录。PWA 不等于 Android/iOS 安装包，也不代表完整产品已完成。')));
  const unsubscribe = pwa.subscribe((state) => {
    controls.replaceChildren(h('h2', {}, native ? '手机 App' : state.installed ? '已在独立窗口中打开' : '安装到桌面'),
      h('p', { className: 'muted build-id' }, `页面版本：${state.buildId}`),
      h('p', { role: 'status' }, state.status),
      !native && h('div', { className: 'account-actions' },
        !state.installed && button(state.installing ? '等待浏览器确认…' : state.canInstall ? '安装日记' : '查看安装方式', () => pwa.install(), { disabled: !state.enabled || state.installing, className: 'button primary' }),
        button('检查更新', () => pwa.check(), { disabled: !state.enabled || state.updating }),
        state.canUpdate && button('保存并更新', () => pwa.update(), { disabled: state.updating, className: 'button primary' })),
      h('p', { className: 'muted' }, '更新不会清空本机数据库。有其他日记窗口时，请先完成写作并关闭其他窗口。'));
  });
  Promise.resolve().then(() => loadMeta()).then((meta) => {
    if (!versions.isConnected) return;
    versions.querySelector('[data-api-version]').textContent = `API：${meta.apiVersion} · 服务版本：${meta.buildId} · 支持正文格式：${meta.supportedContentSchemas.join('、')}`;
  }).catch(() => {
    if (versions.isConnected) versions.querySelector('[data-api-version]').textContent = 'API 版本暂时无法读取；网页与本机日记仍可离线使用。';
  });
  return { root, destroy: unsubscribe };
}
