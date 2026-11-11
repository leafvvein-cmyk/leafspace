import { createApp } from './app.js';
import { createPool } from './db.js';
import { config } from './config.js';
import { startSnapshotWorker } from './snapshots.js';
import { startExportWorker } from './export-worker.js';
import { startAssetCleanup } from './asset-cleanup.js';
import { startAccountDeletionWorker } from './account-deletions.js';
import { startEntryPurgeWorker } from './entry-purge.js';
import { startVaultCleanup } from './vault.js';

const pool = createPool(config.databaseUrl);
const { rowCount: snapshotSchemaReady } = await pool.query("SELECT name FROM _diary_migrations WHERE name='016_vault_key_rotation.sql'");
if (!snapshotSchemaReady) { await pool.end(); throw new Error('Run database migrations before starting the API.'); }
const app = createApp({ pool, config });
const reconciledDeletions = await app.locals.accountDeletions.reconcileLedger();
if (reconciledDeletions) console.warn(JSON.stringify({ event: 'account_deletion_ledger_reconciled', count: reconciledDeletions }));
const stopSnapshots = startSnapshotWorker(app.locals.snapshots);
const stopExports = startExportWorker(app.locals.exportWorker);
const stopAssets = startAssetCleanup(app.locals.assetCleanup);
const stopDeletions = startAccountDeletionWorker(app.locals.accountDeletions);
const stopEntryPurge = startEntryPurgeWorker(app.locals.entryPurge);
const stopVaultCleanup = startVaultCleanup(app.locals.vault);
const server = app.listen(config.port, config.host, () => {
  console.log(`Diary API: http://${config.host}:${config.port}/api/v1`);
  if (!config.production) console.log('Development credentials: loopback-only. Do not expose this configuration publicly.');
});
const stop = () => { server.close(async () => { await Promise.all([stopSnapshots(), stopExports(), stopAssets(), stopDeletions(), stopEntryPurge(), stopVaultCleanup()]); await pool.end(); process.exit(0); }); server.closeIdleConnections(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
