import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isDate } from '@diary/contracts';
import { userTransaction } from './db.js';
import { ApiError, data, notFound } from './errors.js';

const date = z.string().refine(isDate, '日期无效');
const input = z.object({ requestId: z.uuid(), format: z.enum(['json_zip', 'markdown_zip']),
  entryIds: z.array(z.uuid()).min(1).max(1000).optional(), from: date.optional(), to: date.optional(),
  kind: z.enum(['daily', 'moment']).optional(), includeImages: z.boolean().default(true) }).strict()
  .refine((value) => !value.entryIds || !value.from && !value.to, '记录编号不能与日期范围同时使用')
  .refine((value) => !value.from || !value.to || value.from <= value.to, '起始日期不能晚于结束日期');

export function createExports(pool, auth, storage) {
  const view = (job) => ({ jobId: job.id, status: job.status, progress: job.progress,
    createdAt: job.created_at, snapshotAt: job.snapshot_at, expiresAt: job.expires_at, error: job.error_code });
  const owned = async (client, userId, id) => {
    const { rows: [job] } = await client.query('SELECT * FROM export_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId]);
    if (!job) throw notFound();
    if (job.status === 'ready' && job.expires_at <= new Date()) job.status = 'expired';
    return job;
  };
  async function create(principal, raw) {
    const { requestId, ...options } = input.parse(raw);
    if (options.entryIds) options.entryIds = [...new Set(options.entryIds)].sort();
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [previous] } = await client.query('SELECT * FROM export_jobs WHERE user_id=$1 AND request_id=$2', [principal.userId, requestId]);
      if (previous) {
        const equal = Object.keys(options).length === Object.keys(previous.options).length
          && Object.entries(options).every(([key, value]) => JSON.stringify(value) === JSON.stringify(previous.options[key]));
        if (!equal) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一导出请求编号不能用于不同条件');
        return view(previous);
      }
      const { rows: [quota] } = await client.query("SELECT count(*)::int AS count FROM export_jobs WHERE user_id=$1 AND status IN ('queued','running')", [principal.userId]);
      if (quota.count >= 3) throw new ApiError(429, 'EXPORT_LIMIT', '请等待或取消已有导出任务');
      const { rows: [job] } = await client.query('INSERT INTO export_jobs(id,user_id,request_id,options) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), principal.userId, requestId, options]);
      return view(job);
    });
  }
  function mount(router) {
    router.get('/exports', auth.requireAuth, async (req, res) => {
      const query = z.object({ before: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().parse(req.query);
      data(res, await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const { rows } = await client.query(`SELECT * FROM export_jobs WHERE user_id=$1 AND ($2::uuid IS NULL OR id<$2)
          ORDER BY id DESC LIMIT $3`, [req.auth.userId, query.before ?? null, query.limit + 1]);
        const selected = rows.slice(0, query.limit);
        const items = selected.map((job) => view({ ...job, status: job.status === 'ready' && job.expires_at <= new Date() ? 'expired' : job.status }));
        return { items, hasMore: rows.length > query.limit, nextCursor: rows.length > query.limit ? selected.at(-1).id : null };
      }));
    });
    router.post('/exports/:id/download', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const job = await owned(client, req.auth.userId, id);
        if (job.status !== 'ready' || !job.output_key) throw new ApiError(409, 'EXPORT_NOT_READY', '导出未就绪或已失效');
        const expires = Math.min(Date.now() + 300000, job.expires_at.getTime());
        const value = Buffer.from(JSON.stringify({ jobId: id, userId: req.auth.userId, sessionId: req.auth.sessionId, expires })).toString('base64url');
        const ticket = `${value}.${auth.digest(value, 'export-download-v1')}`;
        return { url: `/api/v1/exports/${id}/file?ticket=${encodeURIComponent(ticket)}`, expiresAt: new Date(expires).toISOString() };
      });
      data(res, result);
    });
    router.get('/exports/:id/file', async (req, res) => {
      let ticket;
      try {
        if (typeof req.query.ticket !== 'string' || req.query.ticket.length > 3000) throw new Error();
        const [value, signature, extra] = req.query.ticket.split('.');
        if (!value || !signature || extra !== undefined) throw new Error();
        const expected = Buffer.from(auth.digest(value, 'export-download-v1')), actual = Buffer.from(signature);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        ticket = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (ticket.jobId !== z.uuid().parse(req.params.id) || !Number.isSafeInteger(ticket.expires) || ticket.expires <= Date.now()) throw new Error();
      } catch { throw new ApiError(403, 'EXPORT_LINK_INVALID', '下载链接无效或已过期，请重新申请'); }
      const key = await userTransaction(pool, ticket.userId, ticket.sessionId, async (client) => {
        const job = await owned(client, ticket.userId, ticket.jobId);
        if (job.status !== 'ready' || !job.output_key) throw new ApiError(410, 'EXPORT_EXPIRED', '导出已取消或过期');
        return job.output_key;
      });
      res.set('Referrer-Policy', 'no-referrer');
      await new Promise((resolve, reject) => res.download(storage.path(key), `diary-${ticket.jobId}.zip`, { dotfiles: 'allow' }, (error) => error ? reject(error) : resolve()));
    });
    router.post('/exports', auth.requireAuth, async (req, res) => data(res, await create(req.auth, req.body), 202));
    router.get('/exports/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      data(res, await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => view(await owned(client, req.auth.userId, id))));
    });
    router.delete('/exports/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      data(res, await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        await owned(client, req.auth.userId, id);
        const { rows: [job] } = await client.query("UPDATE export_jobs SET status='cancelled' WHERE id=$1 AND user_id=$2 RETURNING *", [id, req.auth.userId]);
        return view(job);
      }));
    });
  }
  return { mount };
}
