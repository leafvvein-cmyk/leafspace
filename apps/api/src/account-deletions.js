import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { transaction, userTransaction } from './db.js';
import { ApiError, data, notFound } from './errors.js';

const receipt = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function createAccountDeletions(pool, auth, { imageStorage, exportStorage }) {
  const view = (row) => ({ deletionId: row.id, status: row.status, requestedAt: row.requested_at,
    completedAt: row.completed_at, receiptExpiresAt: row.receipt_expires_at,
    ...(row.status === 'failed' ? { message: '清理暂未完成，服务会自动重试。' } : {}) });

  async function create(principal, raw) {
    const body = z.object({ deletionId: z.uuid(), requestId: z.uuid(), reauthToken: z.string(), receiptToken: receipt, confirmed: z.literal(true) }).strict().parse(raw);
    const requestHash = auth.digest(JSON.stringify([body.deletionId, body.confirmed]), 'account-deletion-request');
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [previous] } = await client.query('SELECT * FROM account_deletions WHERE user_id=$1 AND request_id=$2', [principal.userId, body.requestId]);
      if (previous) {
        if (previous.id !== body.deletionId || previous.request_hash !== requestHash || previous.receipt_digest !== auth.digest(body.receiptToken, 'deletion-receipt')) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此注销请求编号已用于其他内容');
        return { ...view(previous), receiptToken: body.receiptToken };
      }
      await auth.consumeReauth(client, principal, body.reauthToken, 'delete_account');
      const { rows: [job] } = await client.query(`INSERT INTO account_deletions(id,user_id,request_id,request_hash,receipt_digest)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [body.deletionId, principal.userId, body.requestId, requestHash, auth.digest(body.receiptToken, 'deletion-receipt')]);
      await client.query(`INSERT INTO account_deletion_ledger(user_id,deletion_id,status,requested_at)
        VALUES($1,$2,'requested',$3)`, [principal.userId, body.deletionId, job.requested_at]);
      await client.query("UPDATE users SET status='deleting' WHERE id=$1 AND status='active'", [principal.userId]);
      await client.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [principal.userId]);
      return { ...view(job), receiptToken: body.receiptToken };
    });
  }

  async function status(id, token) {
    const { rows: [row] } = await pool.query('SELECT * FROM account_deletions WHERE id=$1', [id]);
    if (!row || !receipt.safeParse(token).success) throw notFound();
    const supplied = Buffer.from(auth.digest(token, 'deletion-receipt')), expected = Buffer.from(row.receipt_digest);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw notFound();
    return view(row);
  }

  async function runOne() {
    const token = randomUUID();
    const { rows: [job] } = await pool.query(`UPDATE account_deletions SET status='processing',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '10 minutes'
      WHERE id=(SELECT id FROM account_deletions WHERE (status IN ('requested','failed') OR status='processing' AND lease_until<now()) AND attempts<10
      ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token]);
    if (!job) return false;
    try {
      const [{ rows: images }, { rows: exports }] = await Promise.all([
        pool.query('SELECT source_key,original_key,thumbnail_key FROM assets WHERE user_id=$1', [job.user_id]),
        pool.query('SELECT output_key FROM export_jobs WHERE user_id=$1 AND output_key IS NOT NULL', [job.user_id]),
      ]);
      for (const image of images) for (const key of [image.source_key, image.original_key, image.thumbnail_key]) if (key) await imageStorage.remove(key);
      for (const item of exports) if (item.output_key) await exportStorage.remove(item.output_key);
      await transaction(pool, async (client) => {
        const { rows: [locked] } = await client.query("SELECT * FROM account_deletions WHERE id=$1 AND status='processing' AND lease_token=$2 FOR UPDATE", [job.id, token]);
        if (!locked) return;
        const userId = locked.user_id;
        await client.query('DELETE FROM snapshot_records WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id=$1)', [userId]);
        await client.query('DELETE FROM snapshots WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM export_records WHERE job_id IN (SELECT id FROM export_jobs WHERE user_id=$1)', [userId]);
        await client.query('DELETE FROM export_jobs WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM entry_assets WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM entry_tags WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM asset_request_receipts WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM assets WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM mutation_receipts WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM entry_tombstones WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM sync_events WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM entries WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM tags WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM auth_operation_receipts WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM reauth_tokens WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM recovery_codes WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM user_settings WHERE user_id=$1', [userId]);
        await client.query('DELETE FROM sync_state WHERE user_id=$1', [userId]);
        await client.query("UPDATE account_deletion_ledger SET status='completed',completed_at=now() WHERE user_id=$1", [userId]);
        await client.query('DELETE FROM users WHERE id=$1', [userId]);
        await client.query(`UPDATE account_deletions SET user_id=NULL,status='completed',completed_at=now(),receipt_expires_at=now()+interval '30 days',
          lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1`, [job.id]);
      });
    } catch {
      await pool.query("UPDATE account_deletions SET status='failed',error_code='ACCOUNT_CLEANUP_FAILED',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2", [job.id, token]);
    }
    return true;
  }

  async function expireReceipts() { await pool.query("DELETE FROM account_deletions WHERE status='completed' AND receipt_expires_at<=now()"); }
  async function reconcileLedger() {
    return transaction(pool, async (client) => {
      const { rows } = await client.query(`SELECT l.user_id FROM account_deletion_ledger l JOIN users u ON u.id=l.user_id
        WHERE l.status='completed' ORDER BY l.completed_at,l.user_id FOR UPDATE OF u`);
      for (const row of rows) {
        await client.query("UPDATE users SET status='deleting' WHERE id=$1", [row.user_id]);
        await client.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [row.user_id]);
        const { rowCount } = await client.query("SELECT id FROM account_deletions WHERE user_id=$1 AND status IN ('requested','processing','failed')", [row.user_id]);
        if (!rowCount) await client.query(`INSERT INTO account_deletions(id,user_id,request_id,request_hash,receipt_digest)
          VALUES($1,$2,$3,$4,$5)`, [randomUUID(), row.user_id, randomUUID(), auth.digest(row.user_id, 'ledger-reconciliation'), auth.digest(randomUUID(), 'ledger-cleanup-receipt')]);
      }
      return rows.length;
    });
  }
  function mount(router) {
    router.post('/account-deletions', auth.requireAuth, async (req, res) => data(res, await create(req.auth, req.body), 202));
    router.get('/account-deletions/:id', async (req, res) => data(res, await status(z.uuid().parse(req.params.id), req.get('X-Deletion-Receipt'))));
  }
  return { mount, runOne, expireReceipts, reconcileLedger };
}

export function startAccountDeletionWorker(service) {
  let stopped = false, active;
  const tick = () => {
    if (stopped || active) return;
    active = (async () => { await service.expireReceipts(); await service.runOne(); })().catch(() => console.error(JSON.stringify({ event: 'account_deletion_worker_unavailable' }))).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 5000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
