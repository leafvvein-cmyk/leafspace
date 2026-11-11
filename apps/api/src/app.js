import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { config as defaults } from './config.js';
import { createAuth } from './auth.js';
import { createEntries } from './entries.js';
import { createSync } from './sync.js';
import { createSnapshots } from './snapshots.js';
import { createExports } from './exports.js';
import { createExportStorage } from './export-storage.js';
import { createExportWorker } from './export-worker.js';
import { createAssets } from './assets.js';
import { createImageStorage } from './image-storage.js';
import { createAssetCleanup } from './asset-cleanup.js';
import { createAccountDeletions } from './account-deletions.js';
import { createEntryPurge } from './entry-purge.js';
import { createTasks } from './tasks.js';
import { createVault } from './vault.js';
import { ApiError, data, errorHandler } from './errors.js';

const loopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

export function createApp({ pool, config = defaults, imageStorage, exportStorage }) {
  imageStorage ??= createImageStorage(config.imageStorageRoot);
  exportStorage ??= createExportStorage(config.exportStorageRoot);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(helmet());
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set('X-Request-ID', res.locals.requestId);
    res.set('Cache-Control', 'no-store');
    const origin = req.get('Origin');
    const allowed = [config.webOrigin, 'capacitor://localhost', 'https://localhost', 'http://localhost'];
    if (origin && allowed.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      if (origin === config.webOrigin) res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Reauth-Token, X-Deletion-Receipt, Idempotency-Key');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(origin && allowed.includes(origin) ? 204 : 403).end();
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  const router = express.Router();
  const auth = createAuth(pool, config);
  const entries = createEntries(pool, auth);
  router.get('/health/live', (req, res) => data(res, { status: 'ok' }));
  router.get('/health/ready', async (req, res) => {
    if (!loopback(req)) throw new ApiError(404, 'NOT_FOUND', '找不到该接口');
    try { await pool.query('SELECT 1'); data(res, { status: 'ready' }); }
    catch { throw new ApiError(503, 'NOT_READY', '服务暂未就绪'); }
  });
  router.get('/health/operations', async (req, res) => {
    if (!loopback(req)) throw new ApiError(404, 'NOT_FOUND', '找不到该接口');
    const { rows: [counts] } = await pool.query(`SELECT
      (SELECT count(*)::integer FROM snapshots WHERE status IN ('queued','running')) AS snapshot_pending,
      (SELECT count(*)::integer FROM snapshots WHERE status='failed') AS snapshot_failed,
      (SELECT count(*)::integer FROM export_jobs WHERE status IN ('queued','running')) AS export_pending,
      (SELECT count(*)::integer FROM export_jobs WHERE status='failed') AS export_failed,
      (SELECT count(*)::integer FROM account_deletions WHERE status IN ('queued','processing')) AS deletion_pending,
      (SELECT count(*)::integer FROM account_deletions WHERE status='failed') AS deletion_failed,
      (SELECT count(*)::integer FROM account_deletion_ledger l JOIN users u ON u.id=l.user_id WHERE l.status='completed') AS ledger_reappeared,
      (SELECT count(*)::integer FROM assets WHERE status='failed') AS asset_failed,
      (SELECT count(*)::integer FROM entries WHERE deleted_at IS NOT NULL AND purge_after<=now()) AS trash_overdue,
      (SELECT count(*)::integer FROM vault_key_rotations WHERE expires_at<=now()) AS vault_rotation_expired`);
    const failed = counts.snapshot_failed + counts.export_failed + counts.deletion_failed + counts.ledger_reappeared
      + counts.asset_failed + counts.trash_overdue + counts.vault_rotation_expired;
    data(res, { status: failed ? 'attention' : 'ok', counts });
  });
  router.get('/meta', (req, res) => data(res, {
    apiVersion: 'v1', buildId: process.env.BUILD_ID ?? 'development', supportedContentSchemas: [1],
    syncRetentionDays: 90, mutationRetentionDays: 180,
    limits: { entriesPerPage: 100, mutationsPerBatch: 20, bodyBytes: 1048576, batchBytes: 4194304 },
    implemented: ['account-password', 'recovery-code', 'sessions', 'entries', 'entry-mutations', 'entry-purge', 'sync-changes', 'sync-snapshots', 'calendar', 'basic-search', 'private-images', 'cloud-exports', 'account-deletions', 'tasks-core', 'task-safe-actions', 'vault-ciphertext-storage', 'vault-atomic-key-rotation', 'operational-health'],
  }));
  auth.mount(router);
  entries.mount(router);
  createAssets(pool, auth, imageStorage).mount(router);
  app.locals.assetCleanup = createAssetCleanup(pool, imageStorage);
  const sync = createSync(pool, auth);
  sync.mount(router);
  const snapshots = createSnapshots(pool, auth, sync);
  snapshots.mount(router);
  app.locals.snapshots = snapshots;
  createExports(pool, auth, exportStorage).mount(router);
  app.locals.exportWorker = createExportWorker(pool, exportStorage, imageStorage);
  const accountDeletions = createAccountDeletions(pool, auth, { imageStorage, exportStorage });
  accountDeletions.mount(router); app.locals.accountDeletions = accountDeletions;
  const entryPurge = createEntryPurge(pool, auth);
  entryPurge.mount(router); app.locals.entryPurge = entryPurge;
  createTasks(pool, auth).mount(router);
  const vault = createVault(pool, auth);
  vault.mount(router); app.locals.vault = vault;
  router.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', '接口不存在')));
  app.use('/api/v1', router);
  app.use(errorHandler);
  return app;
}
