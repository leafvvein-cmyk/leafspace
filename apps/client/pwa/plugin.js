import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function diaryPwa({ native = false } = {}) {
  const buildId = randomUUID();
  const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  let building = false;
  return {
    name: 'diary-owned-pwa',
    config(_config, environment) {
      building = environment.command === 'build';
      return { define: { __DIARY_BUILD_ID__: JSON.stringify(building ? buildId : 'development'), __DIARY_APP_VERSION__: JSON.stringify(appVersion), __DIARY_PWA__: JSON.stringify(building && !native) } };
    },
    transformIndexHtml() {
      if (!building || native) return [];
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'icon', href: '/diary-icon.svg', type: 'image/svg+xml' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/diary-icon-192.png', sizes: '192x192' }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#8D4F39' }, injectTo: 'head' },
      ];
    },
    generateBundle: { order: 'post', handler(_options, bundle) {
      if (native) return;
      const icon = readFileSync(new URL('./icon.svg', import.meta.url), 'utf8');
      const icon192 = readFileSync(new URL('./icon-192.png', import.meta.url));
      const icon512 = readFileSync(new URL('./icon-512.png', import.meta.url));
      this.emitFile({ type: 'asset', fileName: 'diary-icon.svg', source: icon });
      this.emitFile({ type: 'asset', fileName: 'diary-icon-192.png', source: icon192 });
      this.emitFile({ type: 'asset', fileName: 'diary-icon-512.png', source: icon512 });
      const manifest = { id: '/', name: '日记', short_name: '日记', lang: 'zh-CN', description: '记录每天的日记与随记', start_url: '/today', scope: '/', display: 'standalone', background_color: '#F7F3EC', theme_color: '#8D4F39', icons: [
        { src: '/diary-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/diary-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        { src: '/diary-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      ] };
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) });
      // Only build-owned static files. Never enumerate uploads or API routes.
      const files = [...Object.keys(bundle).filter((name) => name === 'index.html' || /^assets\/.+\.(js|css|woff2?)$/.test(name)), 'diary-icon.svg', 'diary-icon-192.png', 'diary-icon-512.png', 'manifest.webmanifest'].map((name) => `/${name}`).sort();
      if (!files.includes('/index.html')) this.error('The PWA build must contain its static index.html.');
      const worker = readFileSync(new URL('./worker.js', import.meta.url), 'utf8')
        .replace('__PRECACHE_JSON__', JSON.stringify(files)).replace('__BUILD_JSON__', JSON.stringify(buildId));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker });
    } },
  };
}
