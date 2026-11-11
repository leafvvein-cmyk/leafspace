import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendEvent, userTransaction } from './db.js';
import { ApiError, data, notFound } from './errors.js';

const revision = z.string().regex(/^[1-9]\d{0,17}$/);
const item = z.object({ id: z.uuid(), baseRevision: revision }).strict();
const singleBody = z.object({ requestId: z.uuid(), baseRevision: revision, reauthToken: z.string() }).strict();
const batchBody = z.object({ requestId: z.uuid(), entries: z.array(item).min(1).max(20), reauthToken: z.string() }).strict();

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(stable(value)).digest('hex'); }

async function purgeRows(client, userId, rows) {
  if (!rows.length) return null;
  const ids = rows.map((row) => row.id);
  const { rows: linkedAssets } = await client.query('SELECT DISTINCT asset_id FROM entry_assets WHERE user_id=$1 AND entry_id=ANY($2::uuid[])', [userId, ids]);
  const changes = rows.map((row) => ({ entity: 'entry', id: row.id, action: 'purge', revision: String(BigInt(row.revision) + 1n) }));
  for (const change of changes) {
    await client.query(`INSERT INTO entry_tombstones(user_id,entry_id,final_revision,purged_at) VALUES($1,$2,$3,now())
      ON CONFLICT(user_id,entry_id) DO UPDATE SET final_revision=greatest(entry_tombstones.final_revision,excluded.final_revision),purged_at=excluded.purged_at`,
    [userId, change.id, change.revision]);
  }
  await client.query('DELETE FROM entries WHERE user_id=$1 AND id=ANY($2::uuid[])', [userId, ids]);
  if (linkedAssets.length) await client.query(`UPDATE assets a SET orphaned_at=coalesce(a.orphaned_at,now())
    WHERE a.user_id=$1 AND a.id=ANY($2::uuid[]) AND NOT EXISTS
      (SELECT 1 FROM entry_assets ea WHERE ea.user_id=a.user_id AND ea.asset_id=a.id)`, [userId, linkedAssets.map((row) => row.asset_id)]);
  // A frozen snapshot or export may still contain the purged plaintext. Change
  // the sync generation and revoke downloadable export artifacts atomically.
  const { rows: [state] } = await client.query('UPDATE sync_state SET generation=$2 WHERE user_id=$1 RETURNING generation', [userId, randomUUID()]);
  await client.query("UPDATE export_jobs SET status='cancelled' WHERE user_id=$1 AND status IN ('queued','running','ready','failed')", [userId]);
  const seq = await appendEvent(client, userId, changes);
  return { entryIds: ids, syncPosition: { generation: state.generation, seq: String(seq) } };
}

export function createEntryPurge(pool, auth) {
  async function execute(principal, operation, requestId, entries, reauthToken) {
    const request = { operation, entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)) };
    if (new Set(request.entries.map((entry) => entry.id)).size !== request.entries.length) throw new ApiError(422, 'VALIDATION_FAILED', '永久删除列表包含重复日记');
    const requestHash = digest(request);
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [receipt] } = await client.query('SELECT operation,request_hash,result FROM entry_purge_receipts WHERE user_id=$1 AND session_id=$2 AND request_id=$3', [principal.userId, principal.sessionId, requestId]);
      if (receipt) {
        if (receipt.operation !== operation || receipt.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此永久删除编号已用于其他内容');
        return { ...receipt.result, replayed: true };
      }
      const target = operation === 'purge_entry' ? request.entries[0].id : auth.targetKey(undefined, request.entries.map((entry) => entry.id));
      await auth.consumeReauth(client, principal, reauthToken, operation, target);
      const { rows } = await client.query('SELECT id,revision,deleted_at FROM entries WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE', [principal.userId, request.entries.map((entry) => entry.id)]);
      if (rows.length !== request.entries.length) throw notFound();
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const expected of request.entries) {
        const row = byId.get(expected.id);
        if (!row.deleted_at) throw new ApiError(409, 'ENTRY_NOT_TRASHED', '只有回收站中的日记可以永久删除');
        if (String(row.revision) !== expected.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '回收站内容已在其他设备变化，请刷新后重新确认');
      }
      const purged = await purgeRows(client, principal.userId, request.entries.map((entry) => byId.get(entry.id)));
      const result = { requestId, purged: purged.entryIds, syncPosition: purged.syncPosition };
      await client.query(`INSERT INTO entry_purge_receipts(user_id,session_id,request_id,operation,request_hash,result)
        VALUES($1,$2,$3,$4,$5,$6)`, [principal.userId, principal.sessionId, requestId, operation, requestHash, JSON.stringify(result)]);
      return result;
    });
  }

  function mount(router) {
    router.post('/entries/:id/purge', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id), body = singleBody.parse(req.body);
      data(res, await execute(req.auth, 'purge_entry', body.requestId, [{ id, baseRevision: body.baseRevision }], body.reauthToken));
    });
    router.post('/entries/purge-batch', auth.requireAuth, async (req, res) => {
      const body = batchBody.parse(req.body);
      data(res, await execute(req.auth, 'purge_entries', body.requestId, body.entries, body.reauthToken));
    });
  }

  async function expire() {
    const { rows: users } = await pool.query(`SELECT DISTINCT user_id FROM entries
      WHERE deleted_at IS NOT NULL AND purge_after<=now() ORDER BY user_id LIMIT 10`);
    let count = 0;
    for (const { user_id: userId } of users) {
      try {
        const purged = await userTransaction(pool, userId, null, async (client) => {
          const { rows } = await client.query(`SELECT id,revision,deleted_at FROM entries WHERE user_id=$1
            AND deleted_at IS NOT NULL AND purge_after<=now() ORDER BY purge_after,id FOR UPDATE SKIP LOCKED LIMIT 20`, [userId]);
          return purgeRows(client, userId, rows);
        });
        count += purged?.entryIds.length ?? 0;
      } catch (error) {
        if (error?.code !== 'SESSION_INVALID') throw error;
      }
    }
    await pool.query('DELETE FROM entry_purge_receipts WHERE expires_at<=now()');
    return count;
  }
  return { mount, expire };
}

export function startEntryPurgeWorker(service) {
  let stopped = false, active;
  const tick = () => {
    if (stopped || active) return;
    active = service.expire().catch(() => console.error(JSON.stringify({ event: 'entry_purge_worker_unavailable' }))).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 60 * 60 * 1000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
