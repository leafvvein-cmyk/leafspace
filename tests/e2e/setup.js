import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

export default async function setup() {
  const clientRoot = fileURLToPath(new URL('../../apps/client', import.meta.url));
  const output = fileURLToPath(new URL('../../.runtime/writing-browser-dist', import.meta.url));
  await build({ root: clientRoot, mode: 'production', build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 1000,
    // Browser regression repeatedly creates clean contexts. One script avoids
    // exhausting Windows socket buffers while the normal build remains split.
    rolldownOptions: { output: { codeSplitting: false } } } });
  const root = `${path.resolve(output)}${path.sep}`;
  const mime = new Map([
    ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
    ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webmanifest', 'application/manifest+json'],
  ]);

  async function pageResponse(req, res) {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let relative = pathname.replace(/^\/+/, '');
      if (!relative || !path.extname(relative)) relative = 'index.html';
      const filename = path.resolve(output, relative);
      if (!filename.startsWith(root)) { res.writeHead(400).end('Bad Request'); return; }
      const bytes = await readFile(filename);
      res.writeHead(200, { 'Content-Type': mime.get(path.extname(filename)) ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(status === 404 ? 'Not Found' : 'Server Error');
    }
  }

  const server = await new Promise((resolve, reject) => {
    const listener = createHttpServer((req, res) => {
      if (req.url?.startsWith('/api/')) {
        const body = JSON.stringify({ error: { code: 'SESSION_INVALID', message: '测试学习空间未登录账号' }, meta: { requestId: 'writing-e2e' } });
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body);
      } else void pageResponse(req, res);
    });
    listener.once('error', reject);
    listener.listen(4175, '127.0.0.1', () => resolve(listener));
  });
  return () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}
