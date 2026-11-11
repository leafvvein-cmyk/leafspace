import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { userTransaction } from './db.js';
import { canonical, selectEntry } from './entries.js';
import { ApiError, data, notFound } from './errors.js';

export function createSnapshots(pool, auth, sync) {
  const view = (job) => ({ snapshotId: job.id, status: job.status, recordCount: String(job.record_count),
    snapshotAt: job.snapshot_at?.toISOString() ?? null, expiresAt: job.expires_at?.toISOString() ?? null, error: job.error_code });
  async function owned(client, userId, id) {
    const { rows: [job] } = await client.query(`SELECT s.*, st.generation AS current_generation,
      (s.expires_at IS NOT NULL AND s.expires_at<=now()) AS timed_out
      FROM snapshots s JOIN sync_state st ON st.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2`, [id, userId]);
    if (!job) throw notFound();
    if (job.timed_out || job.generation && job.generation !== job.current_generation) job.status = 'expired';
    return job;
  }
  async function create(principal, body) {
    const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(body);
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [previous] } = await client.query('SELECT id FROM snapshots WHERE user_id=$1 AND request_id=$2', [principal.userId, requestId]);
      if (previous) return view(await owned(client, principal.userId, previous.id));
      const { rows: [quota] } = await client.query(`SELECT count(*)::int AS count FROM snapshots WHERE user_id=$1
        AND (status IN ('queued','running') OR status='ready' AND expires_at>now())`, [principal.userId]);
      if (quota.count >= 3) throw new ApiError(429, 'SNAPSHOT_LIMIT', '快照任务较多，请等待现有任务完成或过期');
      const { rows: [job] } = await client.query('INSERT INTO snapshots(id,user_id,request_id) VALUES($1,$2,$3) RETURNING *', [randomUUID(), principal.userId, requestId]);
      return view(job);
    });
  }
  function packPage(userId, snapshotId, after) {
    const encoded = Buffer.from(JSON.stringify({ userId, snapshotId, after })).toString('base64url');
    return `${encoded}.${auth.digest(encoded, 'snapshot-page-v1')}`;
  }
  function readPageCursor(raw, userId, snapshotId) {
    try {
      const [encoded, signature, extra] = raw.split('.');
      if (extra !== undefined || !signature || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const expected = Buffer.from(auth.digest(encoded, 'snapshot-page-v1')), actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (value.userId !== userId || value.snapshotId !== snapshotId || !Number.isSafeInteger(value.after) || value.after < 0) throw new Error();
      return value.after;
    } catch { throw new ApiError(400, 'SNAPSHOT_CURSOR_INVALID', '快照分页位置无效'); }
  }
  async function pages(principal, id, input) {
    const query = z.object({ pageCursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(input);
    const after = query.pageCursor ? readPageCursor(query.pageCursor, principal.userId, id) : 0;
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const job = await owned(client, principal.userId, id);
      if (job.status === 'expired') throw new ApiError(410, 'SNAPSHOT_EXPIRED', '快照已过期，请保留草稿并重新创建快照');
      if (job.status !== 'ready') throw new ApiError(409, 'SNAPSHOT_NOT_READY', '快照尚未准备完成');
      const { rows } = await client.query(`SELECT ordinal,octet_length(record::text) AS size FROM snapshot_records
        WHERE snapshot_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT $3`, [id, after, query.limit]);
      let last = after, bytes = 0; const records = [];
      for (const row of rows) {
        if (records.length && bytes + row.size > 4 * 1024 * 1024) break;
        const { rows: [item] } = await client.query('SELECT record FROM snapshot_records WHERE snapshot_id=$1 AND ordinal=$2', [id, row.ordinal]);
        if (!item || Number(row.ordinal) !== last + 1) throw new ApiError(410, 'SNAPSHOT_EXPIRED', '快照内容不完整，请重建');
        records.push(item.record); bytes += row.size; last = Number(row.ordinal);
      }
      if (!records.length && last < Number(job.record_count)) throw new ApiError(410, 'SNAPSHOT_EXPIRED', '快照内容不完整，请重建');
      const hasMore = last < Number(job.record_count);
      return { records, hasMore, nextPageCursor: hasMore ? packPage(principal.userId, id, last) : null,
        baselineCursor: hasMore ? null : sync.baseline(principal.userId, job.generation, job.baseline_seq),
        snapshotPosition: hasMore ? null : { generation: job.generation, seq: String(job.baseline_seq) } };
    });
  }
  async function runOne() {
    // Claim is durable. A crashed process's lease is reclaimed, not silently lost.
    await pool.query(`UPDATE snapshots SET status='failed',error_code='SNAPSHOT_RETRY_EXHAUSTED',lease_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until<now() AND attempts>=3`);
    const token = randomUUID();
    const { rows: [job] } = await pool.query(`UPDATE snapshots SET status='running',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '10 minutes'
      WHERE id=(SELECT id FROM snapshots WHERE (status='queued' OR status='running' AND lease_until<now()) AND attempts<3
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token]);
    if (!job) return false;
    try {
      await userTransaction(pool, job.user_id, null, async (client, user) => {
        await client.query("SET LOCAL statement_timeout='30s'");
        const { rows: [claim] } = await client.query('SELECT * FROM snapshots WHERE id=$1 AND lease_token=$2 AND status=\'running\' FOR UPDATE', [job.id, token]);
        if (!claim) return;
        const deadline = Date.now() + 120000;
        const { rows: [state] } = await client.query('SELECT generation,last_seq,now() AS snapshot_at FROM sync_state WHERE user_id=$1', [job.user_id]);
        let ordinal = 0;
        const insert = async (records) => {
          if (Date.now() > deadline) throw new Error('Snapshot generation deadline');
          if (!records.length) return;
          await client.query(`INSERT INTO snapshot_records(snapshot_id,ordinal,record)
            SELECT $1,(value->>'ordinal')::bigint,value->'record' FROM jsonb_array_elements($2::jsonb)`,
          [job.id, JSON.stringify(records.map((record) => ({ ordinal: ++ordinal, record })))]);
        };
        // No password hashes, session tokens, recovery secrets or device settings.
        const { rows: [recovery] } = await client.query('SELECT EXISTS(SELECT 1 FROM recovery_codes WHERE user_id=$1 AND consumed_at IS NULL) AS configured', [job.user_id]);
        await insert([{ entity: 'profile', id: user.id, value: { id: user.id, username: user.username_normalized, displayName: user.display_name,
          timezone: user.timezone, revision: String(user.profile_revision), recoveryCodeConfigured: recovery.configured } }]);
        const { rows: [settings] } = await client.query('SELECT value,revision FROM user_settings WHERE user_id=$1', [job.user_id]);
        if (settings) await insert([{ entity: 'settings', id: user.id, value: { ...settings.value, revision: String(settings.revision) } }]);
        let tagAfter = null;
        while (true) {
          const { rows } = await client.query('SELECT id,name,revision FROM tags WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100', [job.user_id, tagAfter]);
          if (!rows.length) break;
          await insert(rows.map((tag) => ({ entity: 'tag', id: tag.id, value: { id: tag.id, name: tag.name, revision: String(tag.revision) } })));
          tagAfter = rows.at(-1).id;
        }
        let entryAfter = null;
        while (true) {
          const { rows } = await client.query(`${selectEntry} WHERE e.user_id=$1 AND ($2::uuid IS NULL OR e.id>$2) ORDER BY e.id LIMIT 10`, [job.user_id, entryAfter]);
          if (!rows.length) break;
          await insert(rows.map((row) => ({ entity: 'entry', id: row.id, value: canonical(row) })));
          entryAfter = rows.at(-1).id;
        }
        await client.query(`UPDATE snapshots SET status='ready',generation=$1,baseline_seq=$2,record_count=$3,snapshot_at=$4,
          expires_at=clock_timestamp()+interval '30 minutes',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$5 AND lease_token=$6`,
        [state.generation, state.last_seq, ordinal, state.snapshot_at, job.id, token]);
      }, { repeatableRead: true, statementTimeoutMs: 30000 });
    } catch {
      await pool.query(`UPDATE snapshots SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
        error_code='SNAPSHOT_GENERATION_FAILED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [job.id, token]);
    }
    return true;
  }
  async function expire() {
    // Only temporary frozen copies are removed; source entries are untouched.
    await pool.query(`DELETE FROM snapshot_records WHERE snapshot_id IN
      (SELECT id FROM snapshots WHERE expires_at<=now() AND EXISTS(SELECT 1 FROM snapshot_records r WHERE r.snapshot_id=snapshots.id) ORDER BY expires_at LIMIT 100)`);
    await pool.query("UPDATE snapshots SET status='expired' WHERE status='ready' AND expires_at<=now()");
  }
  function mount(router) {
    router.post('/sync/snapshots', auth.requireAuth, async (req, res) => data(res, await create(req.auth, req.body), 202));
    router.get('/sync/snapshots/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      data(res, await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => view(await owned(client, req.auth.userId, id))));
    });
    router.get('/sync/snapshots/:id/pages', auth.requireAuth, async (req, res) => data(res, await pages(req.auth, z.uuid().parse(req.params.id), req.query)));
  }
  return { mount, runOne, expire };
}

export function startSnapshotWorker(service) {
  let stopped = false, active;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => { await service.expire(); await service.runOne(); })()
      .catch(() => console.error(JSON.stringify({ event: 'snapshot_worker_unavailable' })))
      .finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
