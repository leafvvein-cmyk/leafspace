import { userTransaction } from './db.js';
import { canonical, selectEntry } from './entries.js';
import { ApiError } from './errors.js';

export async function freezeExport(pool, id) {
  const { rows: [owner] } = await pool.query('SELECT user_id FROM export_jobs WHERE id=$1', [id]);
  if (!owner) return null;
  return userTransaction(pool, owner.user_id, null, async (client) => {
    const { rows: [job] } = await client.query('SELECT * FROM export_jobs WHERE id=$1 FOR UPDATE', [id]);
    if (!job || !['queued', 'running'].includes(job.status)) return null;
    if (job.snapshot_at) return job;
    const options = job.options;
    let after = null, ordinal = 0, bytes = 0;
    const deadline = Date.now() + 120000;
    while (true) {
      if (Date.now() > deadline) throw new ApiError(422, 'EXPORT_TOO_LARGE', '导出内容过多，请缩小范围');
      const { rows } = await client.query(`${selectEntry} WHERE e.user_id=$1 AND e.deleted_at IS NULL
        AND ($2::uuid IS NULL OR e.id>$2) AND ($3::uuid[] IS NULL OR e.id=ANY($3))
        AND ($4::date IS NULL OR e.entry_date >= $4) AND ($5::date IS NULL OR e.entry_date <= $5)
        AND ($6::text IS NULL OR e.kind=$6) ORDER BY e.id LIMIT 10`,
      [owner.user_id, after, options.entryIds ?? null, options.from ?? null, options.to ?? null, options.kind ?? null]);
      if (!rows.length) break;
      for (const row of rows) {
        const record = canonical(row), json = JSON.stringify(record);
        bytes += Buffer.byteLength(json);
        if (bytes > 64 * 1024 * 1024) throw new ApiError(422, 'EXPORT_TOO_LARGE', '导出内容过多，请缩小范围');
        await client.query('INSERT INTO export_records(job_id,ordinal,entry_id,record) VALUES($1,$2,$3,$4)', [id, ++ordinal, record.id, json]);
      }
      after = rows.at(-1).id;
    }
    if (options.entryIds && ordinal !== options.entryIds.length) throw new ApiError(422, 'EXPORT_SELECTION_UNAVAILABLE', '部分选中记录不可导出，请重新选择');
    const { rows: [frozen] } = await client.query("UPDATE export_jobs SET status='running',progress=30,snapshot_at=now(),record_count=$2 WHERE id=$1 RETURNING *", [id, ordinal]);
    return frozen;
  }, { repeatableRead: true, statementTimeoutMs: 30000 });
}
