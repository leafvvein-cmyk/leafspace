import { z } from 'zod';
import { userTransaction } from './db.js';
import { ApiError, data, notFound } from './errors.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { processImage } from './image-processing.js';

const identity = { size: z.number().int().min(1).max(10485760), sha256: z.string().regex(/^[a-f0-9]{64}$/) };
export function createAssets(pool, auth, storage) {
  const view = (asset) => ({ assetId: asset.id, status: asset.status, width: asset.width, height: asset.height, error: asset.error_code });
  async function credentials(principal, assetId, body, initial) {
    const value = (initial ? z.object({ requestId: z.uuid(), assetId: z.uuid(), mimeType: z.enum(['image/jpeg','image/png','image/webp']), ...identity })
      : z.object({ requestId: z.uuid(), ...identity })).strict().parse(body);
    const id = initial ? value.assetId : z.uuid().parse(assetId);
    const hash = auth.digest(JSON.stringify([initial ? 'initialize' : 'renew', id, value.mimeType ?? null, value.size, value.sha256]), 'asset-request');
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [receipt] } = await client.query('SELECT * FROM asset_request_receipts WHERE user_id=$1 AND request_id=$2', [principal.userId, value.requestId]);
      if (receipt) {
        if (receipt.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一请求编号不能用于不同图片');
        return receipt.response;
      }
      let { rows: [asset] } = await client.query('SELECT * FROM assets WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, principal.userId]);
      if (!asset && initial) {
        const { rows: [quota] } = await client.query("SELECT count(*)::int AS count FROM assets WHERE user_id=$1 AND status IN ('pending','processing')", [principal.userId]);
        if (quota.count >= 100) throw new ApiError(429, 'ASSET_UPLOAD_LIMIT', '待上传图片过多，请先完成或取消已有上传');
        const created = await client.query('INSERT INTO assets(id,user_id,mime_type,source_size,source_sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING *', [id, principal.userId, value.mimeType, value.size, value.sha256]);
        asset = created.rows[0];
        if (!asset) throw new ApiError(409, 'ASSET_ID_UNAVAILABLE', '图片编号不可用，请生成新编号');
      }
      if (!asset) throw notFound();
      if (asset.status !== 'pending' || asset.expires_at <= new Date()) throw new ApiError(409, 'ASSET_UPLOAD_EXPIRED', '此图片不能继续上传，请重新检查资源状态');
      if (asset.source_size !== value.size || asset.source_sha256 !== value.sha256 || initial && asset.mime_type !== value.mimeType) throw new ApiError(409, 'ASSET_IDENTITY_CHANGED', '不能替换已登记图片的文件身份');
      const expires = Math.min(Date.now() + 300000, asset.expires_at.getTime());
      const encoded = Buffer.from(JSON.stringify({ userId: principal.userId, sessionId: principal.sessionId, assetId: id, expires })).toString('base64url');
      const ticket = `${encoded}.${auth.digest(encoded, 'asset-upload-v1')}`;
      const response = { assetId: id, uploadUrl: `/api/v1/assets/${id}/source?ticket=${encodeURIComponent(ticket)}`,
        headers: { 'Content-Type': asset.mime_type }, expiresAt: new Date(expires).toISOString() };
      await client.query('INSERT INTO asset_request_receipts(user_id,request_id,request_hash,response) VALUES($1,$2,$3,$4)', [principal.userId, value.requestId, hash, response]);
      return response;
    });
  }
  function mount(router) {
    router.post('/assets/uploads', auth.requireAuth, async (req, res) => data(res, await credentials(req.auth, null, req.body, true), 201));
    router.post('/assets/:id/upload-credentials', auth.requireAuth, async (req, res) => data(res, await credentials(req.auth, req.params.id, req.body, false)));
    router.put('/assets/:id/source', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }), async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      let ticket;
      try {
        if (typeof req.query.ticket !== 'string' || req.query.ticket.length > 3000) throw new Error();
        const [value, signature, extra] = req.query.ticket.split('.');
        if (!value || !signature || extra !== undefined) throw new Error();
        const expected = Buffer.from(auth.digest(value, 'asset-upload-v1')), actual = Buffer.from(signature);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
        ticket = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (ticket.assetId !== id || !Number.isSafeInteger(ticket.expires) || ticket.expires <= Date.now()) throw new Error();
      } catch { throw new ApiError(403, 'ASSET_UPLOAD_LINK_INVALID', '上传链接无效或已过期，请重新申请'); }
      if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'IMAGE_TYPE_UNSUPPORTED', '仅支持 JPEG、PNG、WebP');
      const sourceKey = await userTransaction(pool, ticket.userId, ticket.sessionId, async (client) => {
        const { rows: [asset] } = await client.query('SELECT * FROM assets WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, ticket.userId]);
        if (!asset) throw notFound();
        if (asset.status !== 'pending') throw new ApiError(409, 'ASSET_UPLOAD_EXPIRED', '此图片不能继续上传');
        if (req.get('Content-Type')?.split(';')[0] !== asset.mime_type || req.body.length !== asset.source_size
          || createHash('sha256').update(req.body).digest('hex') !== asset.source_sha256) throw new ApiError(422, 'ASSET_IDENTITY_CHANGED', '上传内容与登记的图片不一致');
        const key = await storage.putSource(id, req.body);
        await client.query('UPDATE assets SET source_key=$3 WHERE id=$1 AND user_id=$2', [id, ticket.userId, key]);
        return key;
      });
      data(res, { assetId: id, status: 'pending', received: Boolean(sourceKey) });
    });
    router.post('/assets/:id/complete', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id), body = z.object({ requestId: z.uuid() }).strict().parse(req.body);
      const requestHash = auth.digest(JSON.stringify(['complete', id]), 'asset-request');
      const claim = await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const { rows: [receipt] } = await client.query('SELECT * FROM asset_request_receipts WHERE user_id=$1 AND request_id=$2', [req.auth.userId, body.requestId]);
        if (receipt) {
          if (receipt.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '同一请求编号不能用于其他图片操作');
          return { response: receipt.response };
        }
        const { rows: [asset] } = await client.query('SELECT * FROM assets WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, req.auth.userId]);
        if (!asset) throw notFound();
        if (asset.status === 'ready') return { response: view(asset) };
        if (asset.status !== 'pending' || !asset.source_key) throw new ApiError(409, 'ASSET_SOURCE_NOT_READY', '图片文件尚未完整上传');
        await client.query("UPDATE assets SET status='processing' WHERE id=$1 AND user_id=$2", [id, req.auth.userId]);
        return { asset };
      });
      if (claim.response) return data(res, claim.response, 202);
      let keys;
      try {
        const source = await storage.read(claim.asset.source_key);
        const processed = await processImage(source, { mimeType: claim.asset.mime_type, size: claim.asset.source_size, sha256: claim.asset.source_sha256 });
        keys = await storage.putVariants(id, randomUUID(), processed.original, processed.thumbnail);
        const response = await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
          const { rows: [asset] } = await client.query(`UPDATE assets SET status='ready',original_key=$3,thumbnail_key=$4,width=$5,height=$6,error_code=NULL
            WHERE id=$1 AND user_id=$2 AND status='processing' RETURNING *`, [id, req.auth.userId, keys.original, keys.thumbnail, processed.width, processed.height]);
          if (!asset) throw new ApiError(409, 'ASSET_PROCESSING_CHANGED', '图片处理状态已变化');
          const result = view(asset);
          await client.query('INSERT INTO asset_request_receipts(user_id,request_id,request_hash,response) VALUES($1,$2,$3,$4)', [req.auth.userId, body.requestId, requestHash, result]);
          return result;
        });
        await storage.remove(claim.asset.source_key);
        data(res, response, 202);
      } catch (error) {
        if (keys) await Promise.all([storage.remove(keys.original), storage.remove(keys.thumbnail)]);
        await pool.query("UPDATE assets SET status='failed',error_code='IMAGE_PROCESSING_FAILED' WHERE id=$1 AND user_id=$2 AND status='processing'", [id, req.auth.userId]);
        throw error;
      }
    });
    router.post('/assets/:id/read-url', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      const { variant } = z.object({ variant: z.enum(['thumbnail', 'original']) }).strict().parse(req.body);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const { rows: [asset] } = await client.query('SELECT * FROM assets WHERE id=$1 AND user_id=$2', [id, req.auth.userId]);
        if (!asset) throw notFound();
        if (asset.status !== 'ready' || !asset[`${variant}_key`]) throw new ApiError(409, 'ASSET_NOT_READY', '图片尚未处理完成');
        const expires = Date.now() + 300000;
        const value = Buffer.from(JSON.stringify({ userId: req.auth.userId, sessionId: req.auth.sessionId,
          assetId: id, variant, key: asset[`${variant}_key`], expires })).toString('base64url');
        const ticket = `${value}.${auth.digest(value, 'asset-read-v1')}`;
        return { url: `/api/v1/assets/${id}/file?ticket=${encodeURIComponent(ticket)}`, expiresAt: new Date(expires).toISOString() };
      });
      data(res, result);
    });
    router.get('/assets/:id/file', async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      let ticket;
      try {
        if (typeof req.query.ticket !== 'string' || req.query.ticket.length > 3000) throw new Error();
        const [value, signature, extra] = req.query.ticket.split('.');
        if (!value || !signature || extra !== undefined) throw new Error();
        const expected = Buffer.from(auth.digest(value, 'asset-read-v1')), actual = Buffer.from(signature);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error();
        ticket = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (ticket.assetId !== id || !['thumbnail', 'original'].includes(ticket.variant)
          || typeof ticket.key !== 'string' || !Number.isSafeInteger(ticket.expires) || ticket.expires <= Date.now()) throw new Error();
      } catch { throw new ApiError(403, 'ASSET_READ_LINK_INVALID', '图片链接无效或已过期，请重新申请'); }
      const key = await userTransaction(pool, ticket.userId, ticket.sessionId, async (client) => {
        const { rows: [asset] } = await client.query('SELECT * FROM assets WHERE id=$1 AND user_id=$2', [id, ticket.userId]);
        if (!asset || asset.status !== 'ready' || asset[`${ticket.variant}_key`] !== ticket.key) throw new ApiError(410, 'ASSET_UNAVAILABLE', '图片已不可用');
        return ticket.key;
      });
      const bytes = await storage.read(key);
      res.set('Content-Type', 'image/webp');
      res.set('Content-Disposition', 'inline');
      res.set('Content-Length', String(bytes.length));
      res.send(bytes);
    });
    router.get('/assets/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      data(res, await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const { rows: [asset] } = await client.query('SELECT * FROM assets WHERE id=$1 AND user_id=$2', [id, req.auth.userId]);
        if (!asset) throw notFound(); return view(asset);
      }));
    });
  }
  return { mount };
}
