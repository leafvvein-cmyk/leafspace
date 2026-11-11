import { randomUUID } from 'node:crypto';
import { freezeExport } from './export-snapshot.js';
import { exportArchive } from './export-archive.js';

function assetIds(entries) {
  const ids = new Set(), visit = (node) => { if (node?.type === 'image' && /^[0-9a-f-]{36}$/i.test(node.attrs?.assetId ?? '')) ids.add(node.attrs.assetId); for (const child of node?.content ?? []) visit(child); };
  entries.forEach((entry) => visit(entry.content)); return [...ids];
}

export function createExportWorker(pool, storage, imageStorage) {
  async function runOne() {
    await pool.query("UPDATE export_jobs SET status='failed',error_code='EXPORT_RETRY_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<now() AND attempts>=3");
    const token = randomUUID();
    const { rows: [job] } = await pool.query(`UPDATE export_jobs SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '10 minutes'
      WHERE id=(SELECT id FROM export_jobs WHERE (status='queued' OR status='running' AND lease_until<now()) AND attempts<3
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token]);
    if (!job) return false;
    let output;
    try {
      const frozen = await freezeExport(pool, job.id);
      if (!frozen) return true;
      const { rows } = await pool.query('SELECT record FROM export_records WHERE job_id=$1 ORDER BY ordinal', [job.id]);
      const entries = rows.map((row) => row.record), attachments = {};
      if (job.options.includeImages) {
        const ids = assetIds(entries);
        if (ids.length) {
          if (!imageStorage) throw new Error('image storage unavailable');
          const { rows: assets } = await pool.query("SELECT id,original_key FROM assets WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status='ready'", [job.user_id, ids]);
          for (const asset of assets) attachments[asset.id] = { path: `assets/${asset.id}.webp`, bytes: await imageStorage.read(asset.original_key) };
        }
      }
      output = await storage.write(job.id, token, exportArchive({ entries,
        format: job.options.format, includeImages: job.options.includeImages, attachments, snapshotAt: frozen.snapshot_at.toISOString() }));
      const result = await pool.query(`UPDATE export_jobs SET status='ready',progress=100,output_key=$3,expires_at=now()+interval '24 hours',
        error_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'`, [job.id, token, output]);
      if (!result.rowCount) await storage.remove(output);
    } catch (error) {
      if (output) await storage.remove(output);
      await pool.query(`UPDATE export_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
        error_code='EXPORT_GENERATION_FAILED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running'`, [job.id, token]);
    }
    return true;
  }
  async function expire() {
    await pool.query("UPDATE export_jobs SET status='expired' WHERE status='ready' AND expires_at<=now()");
    const { rows } = await pool.query("SELECT id,output_key FROM export_jobs WHERE status IN ('cancelled','expired') AND (output_key IS NOT NULL OR EXISTS(SELECT 1 FROM export_records WHERE job_id=export_jobs.id)) ORDER BY created_at LIMIT 100");
    for (const job of rows) {
      if (job.output_key) await storage.remove(job.output_key);
      await pool.query("DELETE FROM export_records WHERE job_id=$1 AND EXISTS(SELECT 1 FROM export_jobs WHERE id=$1 AND status IN ('cancelled','expired'))", [job.id]);
      await pool.query("UPDATE export_jobs SET output_key=NULL WHERE id=$1 AND status IN ('cancelled','expired') AND output_key IS NOT DISTINCT FROM $2", [job.id, job.output_key]);
    }
  }
  return { runOne, expire };
}

export function startExportWorker(service) {
  let stopped = false, active;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => { await service.expire(); await service.runOne(); })()
      .catch(() => console.error(JSON.stringify({ event: 'export_worker_unavailable' })))
      .finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
