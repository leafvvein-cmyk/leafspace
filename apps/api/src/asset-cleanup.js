/** Two-phase cleanup: claim database rows first, remove private files, then
 * clear keys. A crash leaves deleted rows with keys for the next pass. */
export function createAssetCleanup(pool, storage) {
  async function expire() {
    const { rows } = await pool.query(`WITH candidates AS (
      SELECT a.id FROM assets a WHERE a.orphaned_at<=now()-interval '7 days'
        AND a.status<>'deleted' AND NOT EXISTS(SELECT 1 FROM entry_assets ea WHERE ea.user_id=a.user_id AND ea.asset_id=a.id)
      ORDER BY a.orphaned_at,a.id FOR UPDATE SKIP LOCKED LIMIT 100
    ) UPDATE assets a SET status='deleted',error_code=NULL FROM candidates c WHERE a.id=c.id
      RETURNING a.id,a.source_key,a.original_key,a.thumbnail_key`);
    const leftovers = await pool.query("SELECT id,source_key,original_key,thumbnail_key FROM assets WHERE status='deleted' AND (source_key IS NOT NULL OR original_key IS NOT NULL OR thumbnail_key IS NOT NULL) ORDER BY id LIMIT 100");
    const pending = new Map([...rows, ...leftovers.rows].map((row) => [row.id, row]));
    for (const asset of pending.values()) {
      for (const key of [asset.source_key, asset.original_key, asset.thumbnail_key]) if (key) await storage.remove(key);
      await pool.query("UPDATE assets SET source_key=NULL,original_key=NULL,thumbnail_key=NULL WHERE id=$1 AND status='deleted'", [asset.id]);
    }
    return pending.size;
  }
  return { expire };
}

export function startAssetCleanup(service) {
  let stopped = false, active;
  const tick = () => {
    if (stopped || active) return;
    active = service.expire().catch(() => console.error(JSON.stringify({ event: 'asset_cleanup_unavailable' }))).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 60 * 60 * 1000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
