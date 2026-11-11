import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateEntry, contentText, containsImage, normalizeTags, isDate } from '@diary/contracts';
import { userTransaction, appendEvent } from './db.js';
import { ApiError, data, notFound } from './errors.js';

const revisionSchema = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const tagInput = z.union([z.object({ id: z.uuid() }).strict(), z.object({ name: z.string().trim().min(1).max(48) }).strict()]);
const payloadSchema = z.object({
  kind: z.enum(['daily', 'moment']), entryDate: z.string(), timezone: z.string(), occurredAt: z.string().nullable(),
  title: z.string(), contentSchemaVersion: z.literal(1), content: z.unknown(), mood: z.number().int().nullable(), tags: z.array(tagInput).max(10),
}).strict();
const mutationSchema = z.object({ mutationId: z.uuid(), entryId: z.uuid(), baseRevision: revisionSchema, operation: z.enum(['upsert', 'trash', 'restore']), payload: z.record(z.string(), z.unknown()) }).strict();
export const selectEntry = `SELECT e.*, coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) ORDER BY t.normalized_name)
  FROM entry_tags et JOIN tags t ON t.id=et.tag_id AND t.user_id=et.user_id WHERE et.entry_id=e.id AND et.user_id=e.user_id),'[]'::jsonb) AS tags FROM entries e`;

export function canonical(entry) {
  return {
    id: entry.id, kind: entry.kind, entryDate: entry.entry_date, timezone: entry.timezone,
    occurredAt: entry.occurred_at?.toISOString() ?? null, title: entry.title,
    contentSchemaVersion: entry.content_schema_version, content: entry.content, plainText: entry.plain_text,
    mood: entry.mood, tagIds: entry.tags.map((tag) => tag.id), tags: entry.tags,
    revision: String(entry.revision), createdAt: entry.created_at.toISOString(), updatedAt: entry.updated_at.toISOString(),
    deletedAt: entry.deleted_at?.toISOString() ?? null, purgeAfter: entry.purge_after?.toISOString() ?? null,
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function entryPayload(current) {
  const entry = canonical(current);
  return { kind: entry.kind, entryDate: entry.entryDate, timezone: entry.timezone, occurredAt: entry.occurredAt, title: entry.title, contentSchemaVersion: entry.contentSchemaVersion, content: entry.content, mood: entry.mood, tags: entry.tagIds.map((id) => ({ id })) };
}

function contentAssetIds(node, ids = new Set()) {
  if (node?.type === 'image') ids.add(node.attrs.assetId);
  for (const child of node?.content ?? []) contentAssetIds(child, ids);
  return [...ids];
}

export function createEntries(pool, auth) {
  async function get(client, userId, id) {
    const { rows: [entry] } = await client.query(`${selectEntry} WHERE e.id=$1 AND e.user_id=$2`, [id, userId]);
    return entry;
  }

  async function resolveTags(client, userId, inputs) {
    const tags = new Map();
    const events = [];
    for (const input of inputs) {
      let row;
      if (input.id) {
        ({ rows: [row] } = await client.query('SELECT * FROM tags WHERE id=$1 AND user_id=$2', [input.id, userId]));
        if (!row) throw new ApiError(422, 'TAG_NOT_FOUND', '标签已删除或不可用');
      } else {
        const [{ name }] = normalizeTags([input.name]);
        const normalized = name.normalize('NFKC').toLowerCase();
        ({ rows: [row] } = await client.query('SELECT * FROM tags WHERE user_id=$1 AND normalized_name=$2', [userId, normalized]));
        if (!row) {
          ({ rows: [row] } = await client.query('INSERT INTO tags(id,user_id,name,normalized_name) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), userId, name, normalized]));
          events.push({ entity: 'tag', id: row.id, action: 'upsert', value: { id: row.id, name: row.name, revision: String(row.revision) } });
        }
      }
      tags.set(row.id, row);
    }
    return { tags: [...tags.values()], events };
  }

  async function applyMutation(principal, raw) {
    const mutation = mutationSchema.parse(raw);
    const requestHash = createHash('sha256').update(stable(mutation)).digest('hex');
    return userTransaction(pool, principal.userId, principal.sessionId, async (client) => {
      const { rows: [receipt] } = await client.query('SELECT * FROM mutation_receipts WHERE user_id=$1 AND mutation_id=$2', [principal.userId, mutation.mutationId]);
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此操作编号已用于不同内容，请生成新的操作');
        return { ...receipt.result, status: receipt.result.status === 'applied' ? 'replayed' : receipt.result.status };
      }
      let result;
      await client.query('SAVEPOINT entry_operation');
      try {
        const { rowCount: purged } = await client.query('SELECT entry_id FROM entry_tombstones WHERE user_id=$1 AND entry_id=$2', [principal.userId, mutation.entryId]);
        if (purged) throw new ApiError(410, 'ENTRY_PURGED', '这篇日记已永久删除，本机稿只能另存为新记录');
        const { rows: [owner] } = await client.query('SELECT user_id FROM entries WHERE id=$1', [mutation.entryId]);
        if (owner && owner.user_id !== principal.userId) throw notFound();
        const current = await get(client, principal.userId, mutation.entryId);
        if (current && String(current.revision) !== mutation.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '这篇日记已在其他设备更新', { currentEntry: canonical(current), currentRevision: String(current.revision) });
        if (!current && (mutation.baseRevision !== '0' || mutation.operation !== 'upsert')) throw notFound();
        if (mutation.operation === 'upsert' && current?.deleted_at) throw new ApiError(409, 'ENTRY_TRASHED', '这篇日记已移到回收站，请明确恢复或另存', { currentEntry: canonical(current) });
        if (mutation.operation === 'trash' && current.deleted_at || mutation.operation === 'restore' && !current.deleted_at) {
          result = { mutationId: mutation.mutationId, status: 'applied', entry: canonical(current), changeSeq: null };
        } else {
          let payload;
          if (mutation.operation === 'upsert') payload = payloadSchema.parse(mutation.payload);
          else if (mutation.operation === 'restore') {
            const overrides = z.object({ kind: z.enum(['daily', 'moment']).optional(), entryDate: z.string().optional(), timezone: z.string().optional(), occurredAt: z.string().nullable().optional() }).strict().parse(mutation.payload);
            payload = { ...entryPayload(current), ...overrides };
          } else {
            z.object({}).strict().parse(mutation.payload);
            payload = entryPayload(current);
          }
          validateEntry(payload);
          const assetIds = containsImage(payload.content) ? contentAssetIds(payload.content) : [];
          if (assetIds.length) {
            const { rows } = await client.query("SELECT id FROM assets WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status='ready'", [principal.userId, assetIds]);
            if (rows.length !== assetIds.length) throw new ApiError(422, 'ASSET_NOT_READY', '正文引用的图片尚未处理完成或不属于当前账号');
          }
          const trashed = mutation.operation === 'trash';
          if (payload.kind === 'daily' && !trashed) {
            const { rows: [existing] } = await client.query("SELECT id FROM entries WHERE user_id=$1 AND entry_date=$2 AND kind='daily' AND deleted_at IS NULL AND id<>$3", [principal.userId, payload.entryDate, mutation.entryId]);
            if (existing) throw new ApiError(409, 'DAILY_ALREADY_EXISTS', '这个日期已有每日记录，请合并或另存为随记', { existingEntryId: existing.id });
          }
          const resolved = await resolveTags(client, principal.userId, payload.tags);
          const plainText = contentText(payload.content).trim();
          if (!current) {
            await client.query(`INSERT INTO entries(id,user_id,kind,entry_date,timezone,occurred_at,title,content_schema_version,content,plain_text,mood,sort_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($6::timestamptz,now()))`, [mutation.entryId, principal.userId, payload.kind, payload.entryDate, payload.timezone, payload.occurredAt, payload.title, payload.contentSchemaVersion, JSON.stringify(payload.content), plainText, payload.mood]);
          } else {
            await client.query(`UPDATE entries SET kind=$1,entry_date=$2,timezone=$3,occurred_at=$4,title=$5,content=$6,plain_text=$7,mood=$8,
              revision=revision+1,sort_at=coalesce($4::timestamptz,created_at),updated_at=now(),
              deleted_at=CASE WHEN $9::boolean THEN now() ELSE NULL END,purge_after=CASE WHEN $9::boolean THEN now()+interval '30 days' ELSE NULL END
              WHERE id=$10 AND user_id=$11`, [payload.kind, payload.entryDate, payload.timezone, payload.occurredAt, payload.title, JSON.stringify(payload.content), plainText, payload.mood, trashed, mutation.entryId, principal.userId]);
          }
          await client.query('DELETE FROM entry_tags WHERE entry_id=$1 AND user_id=$2', [mutation.entryId, principal.userId]);
          if (resolved.tags.length) await client.query('INSERT INTO entry_tags(user_id,entry_id,tag_id) SELECT $1::uuid,$2::uuid,unnest($3::uuid[])', [principal.userId, mutation.entryId, resolved.tags.map((tag) => tag.id)]);
          const { rows: previousAssets } = await client.query('DELETE FROM entry_assets WHERE entry_id=$1 AND user_id=$2 RETURNING asset_id', [mutation.entryId, principal.userId]);
          if (assetIds.length) await client.query('INSERT INTO entry_assets(user_id,entry_id,asset_id) SELECT $1::uuid,$2::uuid,unnest($3::uuid[])', [principal.userId, mutation.entryId, assetIds]);
          const touchedAssets = [...new Set([...previousAssets.map((row) => row.asset_id), ...assetIds])];
          if (touchedAssets.length) await client.query(`UPDATE assets a SET orphaned_at=CASE
            WHEN EXISTS(SELECT 1 FROM entry_assets ea WHERE ea.user_id=a.user_id AND ea.asset_id=a.id) THEN NULL
            ELSE coalesce(a.orphaned_at,now()) END WHERE a.user_id=$1 AND a.id=ANY($2::uuid[])`, [principal.userId, touchedAssets]);
          const entry = canonical(await get(client, principal.userId, mutation.entryId));
          const seq = await appendEvent(client, principal.userId, [...resolved.events, { entity: 'entry', id: entry.id, action: 'upsert', value: entry }]);
          result = { mutationId: mutation.mutationId, status: 'applied', entry, changeSeq: String(seq) };
        }
        await client.query('RELEASE SAVEPOINT entry_operation');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT entry_operation');
        if (!(error instanceof ApiError) && !['ValidationError', 'ZodError'].includes(error.name)) throw error;
        result = { mutationId: mutation.mutationId, status: error.status === 409 || error.status === 410 ? 'conflict' : 'rejected', error: { code: error.code ?? 'VALIDATION_FAILED', message: error.name === 'ZodError' ? '请检查日记字段' : error.message, ...(error.details ? { details: error.details } : {}) } };
      }
      if (result.status === 'applied') {
        const { rows: [position] } = await client.query('SELECT generation,last_seq FROM sync_state WHERE user_id=$1', [principal.userId]);
        result.syncPosition = { generation: position.generation, seq: String(position.last_seq) };
      }
      await client.query('INSERT INTO mutation_receipts(user_id,mutation_id,request_hash,result) VALUES($1,$2,$3,$4)', [principal.userId, mutation.mutationId, requestHash, JSON.stringify(result)]);
      return result;
    });
  }

  function packCursor(value) {
    const content = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${content}.${auth.digest(content, 'list-cursor')}`;
  }
  function unpackCursor(cursor, userId, filterHash) {
    try {
      const [encoded, signature] = cursor.split('.');
      if (auth.digest(encoded, 'list-cursor') !== signature) throw new Error();
      const value = JSON.parse(Buffer.from(encoded, 'base64url'));
      if (value.userId !== userId || value.filterHash !== filterHash || !isDate(value.date) || !z.uuid().safeParse(value.id).success || !Number.isFinite(Date.parse(value.sortAt))) throw new Error();
      return value;
    } catch { throw new ApiError(400, 'CURSOR_INVALID', '分页位置已失效，请重新查询'); }
  }

  const querySchema = z.object({ date: z.string().optional(), from: z.string().optional(), to: z.string().optional(), kind: z.enum(['daily', 'moment']).optional(), mood: z.coerce.number().int().min(1).max(5).optional(), tagId: z.uuid().optional(), q: z.string().max(200).optional(), state: z.enum(['active', 'trash']).default('active'), cursor: z.string().max(3000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

  function mount(router) {
    router.post('/sync/mutations', auth.requireAuth, async (req, res) => {
      const { mutations } = z.object({ mutations: z.array(mutationSchema).min(1).max(20) }).strict().parse(req.body);
      const failed = new Set(), results = [];
      for (const mutation of mutations) {
        if (failed.has(mutation.entryId)) { results.push({ mutationId: mutation.mutationId, status: 'rejected', error: { code: 'DEPENDENCY_BLOCKED', message: '前一个依赖操作未完成' } }); continue; }
        const result = await applyMutation(req.auth, mutation);
        results.push(result);
        if (!['applied', 'replayed'].includes(result.status)) failed.add(mutation.entryId);
      }
      data(res, { results });
    });
    async function single(req, res, operation, created = false) {
      const result = await applyMutation(req.auth, { ...req.body, ...(req.params.id ? { entryId: z.uuid().parse(req.params.id) } : {}), operation });
      if (result.error) {
        const code = result.error.code;
        const status = code === 'NOT_FOUND' ? 404 : code === 'ENTRY_PURGED' ? 410 : result.status === 'conflict' ? 409 : 422;
        throw new ApiError(status, code, result.error.message, result.error.details);
      }
      data(res, result, created && result.status === 'applied' ? 201 : 200);
    }
    router.post('/entries', auth.requireAuth, (req, res) => single(req, res, 'upsert', true));
    router.put('/entries/:id', auth.requireAuth, (req, res) => single(req, res, 'upsert'));
    router.post('/entries/:id/trash', auth.requireAuth, (req, res) => { req.body = { ...req.body, payload: req.body.payload ?? {} }; return single(req, res, 'trash'); });
    router.post('/entries/:id/restore', auth.requireAuth, (req, res) => { req.body = { ...req.body, payload: req.body.payload ?? {} }; return single(req, res, 'restore'); });
    router.get('/entries/:id', auth.requireAuth, async (req, res) => {
      const entry = await get(pool, req.auth.userId, z.uuid().parse(req.params.id));
      if (!entry) throw notFound();
      data(res, canonical(entry));
    });
    router.get('/entries', auth.requireAuth, async (req, res) => {
      const query = querySchema.parse(req.query);
      if (['date', 'from', 'to'].some((key) => query[key] && !isDate(query[key])) || query.date && (query.from || query.to) || query.from && query.to && query.from > query.to || [...(query.q ?? '')].length > 100) throw new ApiError(422, 'VALIDATION_FAILED', '查询日期或关键词无效');
      const filterHash = auth.digest(stable({ ...query, cursor: null, limit: null }), 'list-filter');
      const params = [req.auth.userId], clauses = ['e.user_id=$1', query.state === 'active' ? 'e.deleted_at IS NULL' : 'e.deleted_at IS NOT NULL'];
      const add = (value) => { params.push(value); return `$${params.length}`; };
      if (query.date) clauses.push(`e.entry_date=${add(query.date)}::date`);
      if (query.from) clauses.push(`e.entry_date>=${add(query.from)}::date`);
      if (query.to) clauses.push(`e.entry_date<=${add(query.to)}::date`);
      if (query.kind) clauses.push(`e.kind=${add(query.kind)}`);
      if (query.mood) clauses.push(`e.mood=${add(query.mood)}`);
      if (query.tagId) clauses.push(`EXISTS(SELECT 1 FROM entry_tags et WHERE et.user_id=e.user_id AND et.entry_id=e.id AND et.tag_id=${add(query.tagId)}::uuid)`);
      if (query.q) {
        const needle = add(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
        clauses.push(`(e.title ILIKE ${needle} OR e.plain_text ILIKE ${needle} OR EXISTS(SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id AND t.user_id=et.user_id WHERE et.user_id=e.user_id AND et.entry_id=e.id AND t.name ILIKE ${needle}))`);
      }
      if (query.cursor) {
        const cursor = unpackCursor(query.cursor, req.auth.userId, filterHash);
        clauses.push(`(e.entry_date,e.sort_at,e.id)<(${add(cursor.date)}::date,${add(cursor.sortAt)}::timestamptz,${add(cursor.id)}::uuid)`);
      }
      const { rows } = await pool.query(`${selectEntry} WHERE ${clauses.join(' AND ')} ORDER BY e.entry_date DESC,e.sort_at DESC,e.id DESC LIMIT ${add(query.limit + 1)}`, params);
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit), last = page.at(-1);
      data(res, { items: page.map((row) => { const entry = canonical(row); delete entry.content; entry.summary = entry.plainText.slice(0, 200); delete entry.plainText; return entry; }), hasMore, nextCursor: hasMore ? packCursor({ userId: req.auth.userId, filterHash, date: last.entry_date, sortAt: last.sort_at.toISOString(), id: last.id }) : null });
    });
    router.get('/calendar', auth.requireAuth, async (req, res) => {
      const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).strict().parse(req.query);
      if (!isDate(`${month}-01`)) throw new ApiError(422, 'VALIDATION_FAILED', '月份无效');
      const { rows } = await pool.query(`SELECT id,kind,entry_date,mood FROM entries WHERE user_id=$1 AND entry_date >= $2::date AND entry_date < $2::date+interval '1 month' AND deleted_at IS NULL ORDER BY sort_at DESC,id DESC`, [req.auth.userId, `${month}-01`]);
      const days = new Map();
      for (const entry of rows) {
        const day = days.get(entry.entry_date) ?? { date: entry.entry_date, dailyId: null, momentCount: 0, totalCount: 0, mood: null };
        day.totalCount++;
        if (entry.kind === 'daily') { day.dailyId = entry.id; if (entry.mood !== null) day.mood = entry.mood; }
        else day.momentCount++;
        if (day.mood === null && entry.mood !== null) day.mood = entry.mood;
        days.set(entry.entry_date, day);
      }
      data(res, { month, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) });
    });
    router.get('/stats', auth.requireAuth, async (req, res) => {
      const { rows: [row] } = await pool.query('SELECT count(*)::int AS entries,count(DISTINCT entry_date)::int AS days FROM entries WHERE user_id=$1 AND deleted_at IS NULL', [req.auth.userId]);
      data(res, row);
    });
    router.get('/tags', auth.requireAuth, async (req, res) => {
      const { rows } = await pool.query(`SELECT t.id,t.name,t.revision,count(e.id)::int AS count FROM tags t LEFT JOIN entry_tags et ON et.user_id=t.user_id AND et.tag_id=t.id LEFT JOIN entries e ON e.user_id=et.user_id AND e.id=et.entry_id AND e.deleted_at IS NULL WHERE t.user_id=$1 GROUP BY t.id ORDER BY t.normalized_name LIMIT 100`, [req.auth.userId]);
      data(res, { items: rows.map((tag) => ({ id: tag.id, name: tag.name, revision: String(tag.revision), activeEntryCount: tag.count })), hasMore: false, nextCursor: null });
    });
  }
  return { mount, applyMutation, get };
}
