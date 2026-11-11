import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { userTransaction } from './db.js';
import { ApiError, data, notFound } from './errors.js';

const revision = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const encoded = (max) => z.string().min(16).max(max).regex(/^[A-Za-z0-9_-]+$/);
const kdf = z.object({ algorithm: z.literal('argon2id'), memoryKiB: z.number().int().min(19456).max(1048576),
  iterations: z.number().int().min(2).max(10), parallelism: z.number().int().min(1).max(4), hashLength: z.literal(32) }).strict();
const configFields = { kdf, salt: encoded(256), wrappedKey: encoded(1024), wrapNonce: encoded(256), cryptoVersion: z.literal(1),
  recoveryWrappedKey: encoded(1024).optional(), recoveryNonce: encoded(256).optional(), recoveryVersion: z.literal(1).optional() };
const completeRecovery = (value, context) => {
  const recovery = [value.recoveryWrappedKey, value.recoveryNonce, value.recoveryVersion];
  if (recovery.some((item) => item != null) && recovery.some((item) => item == null)) context.addIssue({ code: 'custom', message: '恢复密钥包装参数不完整' });
};
const configInput = z.object({ requestId: z.uuid(), baseRevision: revision, ...configFields }).strict().superRefine(completeRecovery);
const itemInput = z.object({ requestId: z.uuid(), baseRevision: revision, ciphertext: encoded(350000), nonce: encoded(256), cryptoVersion: z.literal(1) }).strict();
const deleteInput = z.object({ requestId: z.uuid(), baseRevision: revision }).strict();
const rotationItem = z.object({ id: z.uuid(), baseRevision: revision, ciphertext: encoded(350000), nonce: encoded(256), cryptoVersion: z.literal(1) }).strict();
const rotationStartInput = z.object({ requestId: z.uuid(), baseConfigRevision: revision, itemCount: z.number().int().min(0).max(10000),
  ...configFields }).strict().superRefine((value, context) => {
    completeRecovery(value, context);
    if (!value.recoveryVersion) context.addIssue({ code: 'custom', message: '完整密钥轮换必须同时换发恢复密钥' });
  });
const rotationBatchInput = z.object({ requestId: z.uuid(), items: z.array(rotationItem).min(1).max(50) }).strict().superRefine((value, context) => {
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length) context.addIssue({ code: 'custom', message: '轮换批次包含重复账号记录' });
});
const rotationCommitInput = z.object({ requestId: z.uuid() }).strict();

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function configView(row) {
  return { kdf: row.kdf, salt: row.salt, wrappedKey: row.wrapped_key, wrapNonce: row.wrap_nonce, cryptoVersion: row.crypto_version,
    ...(row.recovery_version ? { recoveryWrappedKey: row.recovery_wrapped_key, recoveryNonce: row.recovery_nonce, recoveryVersion: row.recovery_version } : {}),
    revision: String(row.revision), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function itemView(row) {
  return { id: row.id, ciphertext: row.ciphertext, nonce: row.nonce, cryptoVersion: row.crypto_version, revision: String(row.revision),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null };
}
function rotationView(row, uploadedItemCount = 0) {
  return { id: row.id, baseConfigRevision: String(row.base_config_revision), expectedItemCount: row.expected_item_count,
    uploadedItemCount: Number(uploadedItemCount), status: row.status, createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString() };
}
function configPayload(input) {
  return { kdf: input.kdf, salt: input.salt, wrappedKey: input.wrappedKey, wrapNonce: input.wrapNonce, cryptoVersion: input.cryptoVersion,
    recoveryWrappedKey: input.recoveryWrappedKey, recoveryNonce: input.recoveryNonce, recoveryVersion: input.recoveryVersion };
}

export function createVault(pool, auth) {
  async function expire() {
    const { rowCount } = await pool.query('DELETE FROM vault_key_rotations WHERE expires_at<=now()');
    return rowCount;
  }
  async function receipt(client, userId, requestId, request, operation) {
    const hash = createHash('sha256').update(stable(request)).digest('hex');
    const { rows: [found] } = await client.query('SELECT request_hash,result FROM vault_request_receipts WHERE user_id=$1 AND request_id=$2', [userId, requestId]);
    if (found) {
      if (found.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此密码本操作编号已用于其他内容');
      return { ...found.result, replayed: true };
    }
    const result = await operation();
    await client.query('INSERT INTO vault_request_receipts(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)', [userId, requestId, hash, JSON.stringify(result)]);
    return result;
  }

  function packCursor(value) {
    const encodedValue = Buffer.from(stable(value)).toString('base64url');
    return `${encodedValue}.${auth.digest(encodedValue, 'vault-list-cursor')}`;
  }
  function unpackCursor(value, userId) {
    try {
      const [body, signature, extra] = value.split('.');
      if (!body || !signature || extra || auth.digest(body, 'vault-list-cursor') !== signature) throw new Error();
      const cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (cursor.userId !== userId || Number.isNaN(Date.parse(cursor.updatedAt)) || !z.uuid().safeParse(cursor.id).success) throw new Error();
      return cursor;
    } catch { throw new ApiError(422, 'CURSOR_INVALID', '密码本分页位置无效，请重新打开'); }
  }

  function mount(router) {
    router.get('/vault/config', auth.requireAuth, async (req, res) => {
      const { rows: [row] } = await pool.query('SELECT * FROM vault_configs WHERE user_id=$1', [req.auth.userId]);
      data(res, { config: row ? configView(row) : null });
    });
    router.put('/vault/config', auth.requireAuth, async (req, res) => {
      const input = configInput.parse(req.body);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, (client) => receipt(client, req.auth.userId, input.requestId, input, async () => {
        const { rows: [current] } = await client.query('SELECT * FROM vault_configs WHERE user_id=$1 FOR UPDATE', [req.auth.userId]);
        if (String(current?.revision ?? 0) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '密码本设置已在其他设备修改', { currentConfig: current ? configView(current) : null });
        const recoveryWrappedKey = input.recoveryWrappedKey ?? current?.recovery_wrapped_key ?? null;
        const recoveryNonce = input.recoveryNonce ?? current?.recovery_nonce ?? null;
        const recoveryVersion = input.recoveryVersion ?? current?.recovery_version ?? null;
        const values = [req.auth.userId, JSON.stringify(input.kdf), input.salt, input.wrappedKey, input.wrapNonce, input.cryptoVersion,
          recoveryWrappedKey, recoveryNonce, recoveryVersion];
        const { rows: [row] } = current
          ? await client.query(`UPDATE vault_configs SET kdf=$2,salt=$3,wrapped_key=$4,wrap_nonce=$5,crypto_version=$6,recovery_wrapped_key=$7,recovery_nonce=$8,recovery_version=$9,revision=revision+1,updated_at=now() WHERE user_id=$1 RETURNING *`, values)
          : await client.query(`INSERT INTO vault_configs(user_id,kdf,salt,wrapped_key,wrap_nonce,crypto_version,recovery_wrapped_key,recovery_nonce,recovery_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, values);
        return { config: configView(row) };
      }));
      data(res, result);
    });
    router.get('/vault/items', auth.requireAuth, async (req, res) => {
      const query = z.object({ cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
      const params = [req.auth.userId], clauses = ['user_id=$1'];
      const add = (value) => { params.push(value); return `$${params.length}`; };
      if (query.cursor) {
        const cursor = unpackCursor(query.cursor, req.auth.userId);
        clauses.push(`(date_trunc('milliseconds',updated_at),id)>(${add(cursor.updatedAt)}::timestamptz,${add(cursor.id)}::uuid)`);
      }
      const { rows } = await pool.query(`SELECT * FROM vault_items WHERE ${clauses.join(' AND ')} ORDER BY date_trunc('milliseconds',updated_at),id LIMIT ${add(query.limit + 1)}`, params);
      const hasMore = rows.length > query.limit, page = rows.slice(0, query.limit), last = page.at(-1);
      data(res, { items: page.map(itemView), hasMore, nextCursor: hasMore ? packCursor({ userId: req.auth.userId, updatedAt: last.updated_at.toISOString(), id: last.id }) : null });
    });
    router.put('/vault/items/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id), input = itemInput.parse(req.body);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, (client) => receipt(client, req.auth.userId, input.requestId, { id, ...input }, async () => {
        const { rows: [current] } = await client.query('SELECT * FROM vault_items WHERE user_id=$1 AND id=$2 FOR UPDATE', [req.auth.userId, id]);
        if (String(current?.revision ?? 0) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '账号记录已在其他设备修改', { currentItem: current ? itemView(current) : null });
        const values = [req.auth.userId, id, input.ciphertext, input.nonce, input.cryptoVersion];
        const { rows: [row] } = current
          ? await client.query('UPDATE vault_items SET ciphertext=$3,nonce=$4,crypto_version=$5,revision=revision+1,updated_at=now(),deleted_at=NULL WHERE user_id=$1 AND id=$2 RETURNING *', values)
          : await client.query('INSERT INTO vault_items(user_id,id,ciphertext,nonce,crypto_version) VALUES($1,$2,$3,$4,$5) RETURNING *', values);
        return { item: itemView(row) };
      }));
      data(res, result);
    });
    router.delete('/vault/items/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id), input = deleteInput.parse({ requestId: req.get('Idempotency-Key'), baseRevision: req.query.baseRevision });
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, (client) => receipt(client, req.auth.userId, input.requestId, { id, delete: true, ...input }, async () => {
        const { rows: [current] } = await client.query('SELECT * FROM vault_items WHERE user_id=$1 AND id=$2 FOR UPDATE', [req.auth.userId, id]);
        if (!current) throw notFound();
        if (String(current.revision) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '账号记录已在其他设备修改', { currentItem: itemView(current) });
        if (current.deleted_at) return { item: itemView(current) };
        const { rows: [row] } = await client.query('UPDATE vault_items SET revision=revision+1,updated_at=now(),deleted_at=now() WHERE user_id=$1 AND id=$2 RETURNING *', [req.auth.userId, id]);
        return { item: itemView(row) };
      }));
      data(res, result);
    });
    router.post('/vault/key-rotations', auth.requireAuth, async (req, res) => {
      const input = rotationStartInput.parse(req.body);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, (client) => receipt(client, req.auth.userId, input.requestId, input, async () => {
        await client.query('DELETE FROM vault_key_rotations WHERE user_id=$1 AND expires_at<=now()', [req.auth.userId]);
        const { rows: [current] } = await client.query('SELECT * FROM vault_configs WHERE user_id=$1 FOR UPDATE', [req.auth.userId]);
        if (!current) throw new ApiError(409, 'VAULT_NOT_INITIALIZED', '密码本尚未创建');
        if (String(current.revision) !== input.baseConfigRevision) throw new ApiError(409, 'REVISION_CONFLICT', '密码本设置已在其他设备修改', { currentConfig: configView(current) });
        const { rows: [count] } = await client.query('SELECT count(*)::integer AS count FROM vault_items WHERE user_id=$1', [req.auth.userId]);
        if (count.count !== input.itemCount) throw new ApiError(409, 'ROTATION_ITEM_SET_CHANGED', '密码本账号数量已变化，请重新同步后轮换');
        const id = randomUUID(), newConfig = configPayload(input);
        const { rows: [row] } = await client.query(`INSERT INTO vault_key_rotations(user_id,id,base_config_revision,expected_item_count,new_config)
          VALUES($1,$2,$3,$4,$5) RETURNING *`, [req.auth.userId, id, input.baseConfigRevision, input.itemCount, JSON.stringify(newConfig)]);
        return { rotation: rotationView(row, 0) };
      }));
      data(res, result, 201);
    });
    router.put('/vault/key-rotations/:id/items', auth.requireAuth, async (req, res) => {
      const rotationId = z.uuid().parse(req.params.id), input = rotationBatchInput.parse(req.body);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, (client) => receipt(client, req.auth.userId, input.requestId,
        { rotationId, ...input }, async () => {
          const { rows: [rotation] } = await client.query('SELECT * FROM vault_key_rotations WHERE user_id=$1 AND id=$2 FOR UPDATE', [req.auth.userId, rotationId]);
          if (!rotation) throw notFound();
          if (rotation.status !== 'staging' || rotation.expires_at <= new Date()) throw new ApiError(409, 'ROTATION_NOT_STAGING', '这次密码本密钥轮换已结束或过期');
          const ids = input.items.map((item) => item.id);
          const { rows: currentRows } = await client.query('SELECT id,revision FROM vault_items WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE', [req.auth.userId, ids]);
          const current = new Map(currentRows.map((row) => [row.id, String(row.revision)]));
          if (current.size !== ids.length || input.items.some((item) => current.get(item.id) !== item.baseRevision)) {
            throw new ApiError(409, 'ROTATION_ITEM_SET_CHANGED', '密码本账号版本已变化，请重新同步后轮换');
          }
          for (const item of input.items) {
            const { rowCount } = await client.query(`INSERT INTO vault_key_rotation_items(user_id,rotation_id,item_id,base_revision,ciphertext,nonce,crypto_version)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [req.auth.userId, rotationId, item.id, item.baseRevision,
              item.ciphertext, item.nonce, item.cryptoVersion]);
            if (!rowCount) throw new ApiError(409, 'ROTATION_ITEM_DUPLICATE', '这条账号记录已经使用另一个轮换请求上传');
          }
          const { rows: [count] } = await client.query('SELECT count(*)::integer AS count FROM vault_key_rotation_items WHERE user_id=$1 AND rotation_id=$2', [req.auth.userId, rotationId]);
          return { rotation: rotationView(rotation, count.count) };
        }));
      data(res, result);
    });
    router.post('/vault/key-rotations/:id/commit', auth.requireAuth, async (req, res) => {
      const rotationId = z.uuid().parse(req.params.id), input = rotationCommitInput.parse(req.body);
      const result = await userTransaction(pool, req.auth.userId, req.auth.sessionId, (client) => receipt(client, req.auth.userId, input.requestId,
        { rotationId, commit: true }, async () => {
          const { rows: [rotation] } = await client.query('SELECT * FROM vault_key_rotations WHERE user_id=$1 AND id=$2 FOR UPDATE', [req.auth.userId, rotationId]);
          if (!rotation) throw notFound();
          if (rotation.status !== 'staging' || rotation.expires_at <= new Date()) throw new ApiError(409, 'ROTATION_NOT_STAGING', '这次密码本密钥轮换已结束或过期');
          const { rows: [currentConfig] } = await client.query('SELECT * FROM vault_configs WHERE user_id=$1 FOR UPDATE', [req.auth.userId]);
          const { rows: currentItems } = await client.query('SELECT id,revision FROM vault_items WHERE user_id=$1 ORDER BY id FOR UPDATE', [req.auth.userId]);
          const { rows: staged } = await client.query('SELECT * FROM vault_key_rotation_items WHERE user_id=$1 AND rotation_id=$2 ORDER BY item_id', [req.auth.userId, rotationId]);
          const exactItems = currentItems.length === rotation.expected_item_count && staged.length === currentItems.length
            && currentItems.every((item, index) => item.id === staged[index].item_id && String(item.revision) === String(staged[index].base_revision));
          if (!currentConfig || String(currentConfig.revision) !== String(rotation.base_config_revision) || !exactItems) {
            throw new ApiError(409, 'ROTATION_ITEM_SET_CHANGED', '密码本在轮换期间发生变化，未应用任何新密文');
          }
          const next = rotation.new_config;
          const { rows: [savedConfig] } = await client.query(`UPDATE vault_configs SET kdf=$2,salt=$3,wrapped_key=$4,wrap_nonce=$5,crypto_version=$6,
            recovery_wrapped_key=$7,recovery_nonce=$8,recovery_version=$9,revision=revision+1,updated_at=now() WHERE user_id=$1 RETURNING *`,
            [req.auth.userId, JSON.stringify(next.kdf), next.salt, next.wrappedKey, next.wrapNonce, next.cryptoVersion,
              next.recoveryWrappedKey, next.recoveryNonce, next.recoveryVersion]);
          const { rows: savedItems } = await client.query(`UPDATE vault_items AS target SET ciphertext=source.ciphertext,nonce=source.nonce,
            crypto_version=source.crypto_version,revision=target.revision+1,updated_at=now() FROM vault_key_rotation_items AS source
            WHERE source.user_id=$1 AND source.rotation_id=$2 AND target.user_id=source.user_id AND target.id=source.item_id RETURNING target.*`,
            [req.auth.userId, rotationId]);
          const { rows: [completed] } = await client.query(`UPDATE vault_key_rotations SET status='completed',completed_at=now()
            WHERE user_id=$1 AND id=$2 RETURNING *`, [req.auth.userId, rotationId]);
          return { rotation: rotationView(completed, savedItems.length), config: configView(savedConfig),
            items: savedItems.sort((a, b) => a.id.localeCompare(b.id)).map(itemView) };
        }));
      data(res, result);
    });
  }
  return { mount, expire };
}

export function startVaultCleanup(service) {
  let stopped = false, active;
  const tick = () => {
    if (stopped || active) return;
    active = service.expire().catch(() => console.error(JSON.stringify({ event: 'vault_rotation_cleanup_unavailable' }))).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, 60 * 60 * 1000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await active; };
}
