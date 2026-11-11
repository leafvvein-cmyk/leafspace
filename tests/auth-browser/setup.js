import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'vite';
import { createApp } from '../../apps/api/src/app.js';
import { createPool } from '../../apps/api/src/db.js';
import { migrate } from '../../apps/api/src/migrate.js';
import { config as defaults } from '../../apps/api/src/config.js';
import { startSnapshotWorker } from '../../apps/api/src/snapshots.js';
import { startExportWorker } from '../../apps/api/src/export-worker.js';
import { startAssetCleanup } from '../../apps/api/src/asset-cleanup.js';
import { startAccountDeletionWorker } from '../../apps/api/src/account-deletions.js';
import { startEntryPurgeWorker } from '../../apps/api/src/entry-purge.js';

const transientLoopbackError = /EADDRINUSE|ENOBUFS|ERR_ADDRESS_IN_USE|ERR_NO_BUFFER_SPACE/;
async function connectWithRetry(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 4 || !transientLoopbackError.test(error.message ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

export default async function setup() {
  const name = `diary_auth_e2e_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const url = new URL(defaults.databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329' || !/^diary_auth_e2e_[0-9a-f_]+$/.test(name)) throw new Error('Auth browser tests require the isolated loopback diary PostgreSQL server.');
  url.pathname = '/postgres';
  const admin = createPool(url.href);
  let created = false, pool, server, stopWorkers = [];
  async function cleanup() {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await Promise.all(stopWorkers.map((stop) => stop())); stopWorkers = [];
    await pool?.end();
    // Exact generated name only: never touch diary_dev or an existing user DB.
    if (created && /^diary_auth_e2e_[0-9a-f_]+$/.test(name)) await connectWithRetry(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`));
    await admin.end();
  }
  try {
    await connectWithRetry(() => admin.query(`CREATE DATABASE "${name}"`)); created = true;
    url.pathname = `/${name}`; pool = createPool(url.href); await connectWithRetry(() => migrate(pool));
    const config = { ...defaults, production: false, webOrigin: 'http://127.0.0.2:4174', secret: 'isolated-browser-test-secret-never-deploy', authIpLimit: 10000 };
    const api = createApp({ pool, config });
    stopWorkers = [
      startSnapshotWorker(api.locals.snapshots),
      startExportWorker(api.locals.exportWorker),
      startAssetCleanup(api.locals.assetCleanup),
      startAccountDeletionWorker(api.locals.accountDeletions),
      startEntryPurgeWorker(api.locals.entryPurge),
    ];
    const clientRoot = fileURLToPath(new URL('../../apps/client', import.meta.url));
    const output = fileURLToPath(new URL('../../.runtime/auth-browser-dist', import.meta.url));
    await build({ root: clientRoot, mode: 'production', build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 1000,
      // This test build values transport stability over lazy-load performance.
      // The normal production build keeps its editor split point.
      rolldownOptions: { output: { codeSplitting: false } } } });
    const root = `${path.resolve(output)}${path.sep}`;
    const mime = new Map([
      ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
      ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
      ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.webmanifest', 'application/manifest+json'],
    ]);
    async function pages(req, res) {
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
    // Keep the production page bundle and real Express API on one loopback
    // listener. It preserves HTTP/cookie behavior while avoiding both Vite's
    // module-per-request graph and an extra proxy socket for each API call.
    server = await new Promise((resolve, reject) => {
      const listener = createHttpServer((req, res) => {
        if (req.url?.startsWith('/api/')) api(req, res);
        else void pages(req, res);
      });
      listener.once('error', reject);
      listener.listen(4174, '127.0.0.2', () => resolve(listener));
    });
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}
