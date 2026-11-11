import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nextTaskDueAt, normalizeTaskRecurrence } from '@diary/contracts/task-recurrence';
import { isConfiguredNativeAppAction, nativeAppActionCatalog } from '@diary/contracts/app-actions';
import { userTransaction } from './db.js';
import { ApiError, data, notFound } from './errors.js';

const revision = z.string().regex(/^(0|[1-9]\d{0,17})$/);
const checklistItem = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(500), completed: z.boolean() }).strict();
const recurrence = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('daily'), interval: z.number().int().min(1).max(365) }).strict(),
  z.object({ frequency: z.literal('weekly'), interval: z.number().int().min(1).max(52), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional() }).strict(),
  z.object({ frequency: z.literal('monthly'), interval: z.number().int().min(1).max(120), dayOfMonth: z.number().int().min(1).max(31).optional() }).strict(),
]);
const payload = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().max(5000).default(''),
  dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
  timezone: z.string().trim().min(1).max(100).default('Asia/Shanghai'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  recurrence: recurrence.nullable().default(null),
  reminderMinutesBefore: z.number().int().min(0).max(40320).nullable().default(null),
  checklist: z.array(checklistItem).max(100).default([]),
  linkedEntryId: z.uuid().nullable().default(null),
}).strict();
const createInput = z.object({ taskId: z.uuid(), requestId: z.uuid(), payload }).strict();
const updateInput = z.object({ requestId: z.uuid(), baseRevision: revision, patch: payload.partial().refine((value) => Object.keys(value).length > 0, '至少修改一个字段') }).strict();
const transitionInput = z.object({ requestId: z.uuid(), baseRevision: revision }).strict();
const actionInput = z.object({
  id: z.uuid(), type: z.enum(['internal', 'https', 'external_app']), label: z.string().trim().min(1).max(80), target: z.string().trim().min(1).max(2048),
}).strict();

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validateTimezone(timezone) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new ApiError(422, 'VALIDATION_FAILED', '待办时区无效'); }
}

function validatePayload(value) {
  validateTimezone(value.timezone);
  try { value = { ...value, recurrence: normalizeTaskRecurrence(value.recurrence, value.dueAt, value.timezone) }; }
  catch (error) { throw new ApiError(422, 'VALIDATION_FAILED', error.message); }
  const ids = value.checklist.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new ApiError(422, 'VALIDATION_FAILED', '待办子项编号不能重复');
  return value;
}

function canonical(row, actions = []) {
  return {
    id: row.id, seriesId: row.series_id, title: row.title, note: row.note,
    dueAt: row.due_at?.toISOString() ?? null, timezone: row.timezone, priority: row.priority,
    recurrence: row.recurrence, reminderMinutesBefore: row.reminder_minutes_before,
    checklist: row.checklist, linkedEntryId: row.linked_entry_id, status: row.status,
    revision: String(row.revision), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, deletedAt: row.deleted_at?.toISOString() ?? null,
    actions: actions.map((action) => ({ ...action, target: action.config?.target })),
  };
}

export function createTasks(pool, auth) {
  function packCursor(value) {
    const encoded = Buffer.from(stable(value)).toString('base64url');
    return `${encoded}.${auth.digest(encoded, 'task-list-cursor')}`;
  }

  function unpackCursor(value, userId, filterHash) {
    try {
      const [encoded, signature, extra] = value.split('.');
      if (!encoded || !signature || extra || auth.digest(encoded, 'task-list-cursor') !== signature) throw new Error();
      const cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (cursor.userId !== userId || cursor.filterHash !== filterHash || ![0, 1].includes(cursor.nullDue)
        || cursor.dueAt !== null && Number.isNaN(Date.parse(cursor.dueAt)) || Number.isNaN(Date.parse(cursor.createdAt))
        || !z.uuid().safeParse(cursor.id).success) throw new Error();
      return cursor;
    } catch { throw new ApiError(422, 'CURSOR_INVALID', '待办分页位置无效，请重新打开列表'); }
  }

  async function get(client, userId, id, { lock = false } = {}) {
    const { rows: [row] } = await client.query(`SELECT * FROM tasks WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
    return row;
  }

  async function view(client, userId, row) {
    const { rows } = await client.query('SELECT id,action_type,action_key,label,config,position FROM task_actions WHERE user_id=$1 AND task_id=$2 ORDER BY position,id', [userId, row.id]);
    return canonical(row, rows.map((item) => ({ id: item.id, type: item.action_type, key: item.action_key, label: item.label, config: item.config })));
  }

  async function withReceipt(client, userId, requestId, requestValue, operation) {
    const requestHash = createHash('sha256').update(stable(requestValue)).digest('hex');
    const { rows: [receipt] } = await client.query('SELECT request_hash,result FROM task_request_receipts WHERE user_id=$1 AND request_id=$2', [userId, requestId]);
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此待办操作编号已用于其他内容');
      return { ...receipt.result, replayed: true };
    }
    const result = await operation();
    await client.query('INSERT INTO task_request_receipts(user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)', [userId, requestId, requestHash, JSON.stringify(result)]);
    return result;
  }

  async function assertLinkedEntry(client, userId, entryId) {
    if (!entryId) return;
    const { rowCount } = await client.query('SELECT id FROM entries WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [entryId, userId]);
    if (!rowCount) throw new ApiError(422, 'ENTRY_NOT_AVAILABLE', '关联的日记不存在或已在回收站');
  }

  async function create(principal, raw) {
    const input = createInput.parse(raw), value = validatePayload(input.payload);
    return userTransaction(pool, principal.userId, principal.sessionId, (client) => withReceipt(client, principal.userId, input.requestId, input, async () => {
      const { rows: [owner] } = await client.query('SELECT user_id FROM tasks WHERE id=$1', [input.taskId]);
      if (owner) throw owner.user_id === principal.userId ? new ApiError(409, 'TASK_EXISTS', '这个待办编号已经存在') : notFound();
      await assertLinkedEntry(client, principal.userId, value.linkedEntryId);
      const { rows: [row] } = await client.query(`INSERT INTO tasks(id,user_id,series_id,title,note,due_at,timezone,priority,recurrence,reminder_minutes_before,checklist,linked_entry_id)
        VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [input.taskId, principal.userId, value.title, value.note, value.dueAt, value.timezone, value.priority, value.recurrence, value.reminderMinutesBefore, JSON.stringify(value.checklist), value.linkedEntryId]);
      return { task: await view(client, principal.userId, row) };
    }));
  }

  async function update(principal, id, raw) {
    const input = updateInput.parse(raw);
    return userTransaction(pool, principal.userId, principal.sessionId, (client) => withReceipt(client, principal.userId, input.requestId, { id, ...input }, async () => {
      const current = await get(client, principal.userId, id, { lock: true });
      if (!current) throw notFound();
      if (String(current.revision) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '待办已在其他设备修改', { currentTask: await view(client, principal.userId, current) });
      if (current.status === 'trash') throw new ApiError(409, 'TASK_TRASHED', '待办已删除，请先恢复');
      const merged = validatePayload(payload.parse({
        title: current.title, note: current.note, dueAt: current.due_at?.toISOString() ?? null, timezone: current.timezone,
        priority: current.priority, recurrence: current.recurrence, reminderMinutesBefore: current.reminder_minutes_before,
        checklist: current.checklist, linkedEntryId: current.linked_entry_id, ...input.patch,
      }));
      await assertLinkedEntry(client, principal.userId, merged.linkedEntryId);
      const { rows: [row] } = await client.query(`UPDATE tasks SET title=$1,note=$2,due_at=$3,timezone=$4,priority=$5,recurrence=$6,
        reminder_minutes_before=$7,checklist=$8,linked_entry_id=$9,revision=revision+1,updated_at=now() WHERE id=$10 AND user_id=$11 RETURNING *`,
      [merged.title, merged.note, merged.dueAt, merged.timezone, merged.priority, merged.recurrence, merged.reminderMinutesBefore, JSON.stringify(merged.checklist), merged.linkedEntryId, id, principal.userId]);
      return { task: await view(client, principal.userId, row) };
    }));
  }

  async function transition(principal, id, raw, target) {
    const input = transitionInput.parse(raw);
    return userTransaction(pool, principal.userId, principal.sessionId, (client) => withReceipt(client, principal.userId, input.requestId, { id, target, ...input }, async () => {
      const current = await get(client, principal.userId, id, { lock: true });
      if (!current) throw notFound();
      if (String(current.revision) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '待办已在其他设备修改', { currentTask: await view(client, principal.userId, current) });
      if (current.status === 'trash') throw new ApiError(409, 'TASK_TRASHED', '待办已删除，请先恢复');
      if (current.status === target) return { task: await view(client, principal.userId, current), nextTask: null };
      const { rows: [row] } = await client.query(`UPDATE tasks SET status=$1,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END,
        revision=revision+1,updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING *`, [target, id, principal.userId]);
      let nextTask = null;
      if (target === 'completed' && current.recurrence && current.due_at) {
        const nextId = randomUUID();
        const nextDueAt = nextTaskDueAt(current.due_at.toISOString(), current.timezone, current.recurrence);
        const { rows: [next] } = await client.query(`INSERT INTO tasks(id,user_id,series_id,title,note,due_at,timezone,priority,recurrence,reminder_minutes_before,checklist,linked_entry_id)
          SELECT $1,user_id,series_id,title,note,$2,
          timezone,priority,recurrence,reminder_minutes_before,
          (SELECT coalesce(jsonb_agg(jsonb_set(item,'{completed}','false'::jsonb) ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(checklist) WITH ORDINALITY AS x(item,ordinal)),linked_entry_id
          FROM tasks WHERE id=$3 AND user_id=$4 RETURNING *`, [nextId, nextDueAt, id, principal.userId]);
        const { rows: sourceActions } = await client.query('SELECT action_type,action_key,label,config,position FROM task_actions WHERE user_id=$1 AND task_id=$2 ORDER BY position,id', [principal.userId, id]);
        for (const action of sourceActions) await client.query(`INSERT INTO task_actions(id,user_id,task_id,action_type,action_key,label,config,position)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), principal.userId, nextId, action.action_type, action.action_key, action.label, action.config, action.position]);
        nextTask = await view(client, principal.userId, next);
      }
      return { task: await view(client, principal.userId, row), nextTask };
    }));
  }

  async function setTrash(principal, id, raw, trashed) {
    const input = transitionInput.parse(raw);
    return userTransaction(pool, principal.userId, principal.sessionId, (client) => withReceipt(client, principal.userId, input.requestId, { id, trashed, ...input }, async () => {
      const current = await get(client, principal.userId, id, { lock: true });
      if (!current) throw notFound();
      if (String(current.revision) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '待办已在其他设备修改', { currentTask: await view(client, principal.userId, current) });
      if ((current.status === 'trash') === trashed) return { task: await view(client, principal.userId, current) };
      const { rows: [row] } = await client.query(`UPDATE tasks SET status=$1,deleted_at=CASE WHEN $1='trash' THEN now() ELSE NULL END,
        completed_at=CASE WHEN $1='open' THEN NULL ELSE completed_at END,revision=revision+1,updated_at=now()
        WHERE id=$2 AND user_id=$3 RETURNING *`, [trashed ? 'trash' : 'open', id, principal.userId]);
      return { task: await view(client, principal.userId, row) };
    }));
  }

  async function replaceActions(principal, id, raw) {
    const input = z.object({ requestId: z.uuid(), baseRevision: revision, actions: z.array(actionInput).max(20) }).strict().parse(raw);
    return userTransaction(pool, principal.userId, principal.sessionId, (client) => withReceipt(client, principal.userId, input.requestId, { id, ...input }, async () => {
      const current = await get(client, principal.userId, id, { lock: true });
      if (!current) throw notFound();
      if (current.status === 'trash') throw new ApiError(409, 'TASK_TRASHED', '待办已删除，请先恢复');
      if (String(current.revision) !== input.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '待办已在其他设备修改', { currentTask: await view(client, principal.userId, current) });
      if (new Set(input.actions.map((item) => item.id)).size !== input.actions.length) throw new ApiError(422, 'VALIDATION_FAILED', '待办动作编号不能重复');
      for (const action of input.actions) {
        if (action.type === 'internal' && !['/today', '/tasks', '/timeline', '/calendar'].includes(action.target)) throw new ApiError(422, 'ACTION_TARGET_INVALID', '站内动作目标不在白名单');
        if (action.type === 'https') { try { if (new URL(action.target).protocol !== 'https:') throw new Error(); } catch { throw new ApiError(422, 'ACTION_TARGET_INVALID', '网站动作必须是有效的 HTTPS 地址'); } }
        if (action.type === 'external_app' && !isConfiguredNativeAppAction(action.target)) throw new ApiError(422, 'ACTION_TARGET_INVALID', '原生 App 动作目标不在产品白名单');
      }
      await client.query('DELETE FROM task_actions WHERE user_id=$1 AND task_id=$2', [principal.userId, id]);
      for (const [position, action] of input.actions.entries()) await client.query(`INSERT INTO task_actions(id,user_id,task_id,action_type,action_key,label,config,position)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [action.id, principal.userId, id, action.type, action.type, action.label, JSON.stringify({ target: action.target }), position]);
      const { rows: [row] } = await client.query('UPDATE tasks SET revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [id, principal.userId]);
      return { task: await view(client, principal.userId, row) };
    }));
  }

  function mount(router) {
    router.get('/task-action-types', auth.requireAuth, (req, res) => data(res, {
      items: [
        { type: 'internal', targets: ['/today', '/tasks', '/timeline', '/calendar'] },
        { type: 'https', scheme: 'https' },
      ], externalApps: nativeAppActionCatalog(),
    }));
    router.post('/tasks', auth.requireAuth, async (req, res) => data(res, await create(req.auth, req.body), 201));
    router.get('/tasks/:id', auth.requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id), row = await get(pool, req.auth.userId, id);
      if (!row) throw notFound();
      data(res, await view(pool, req.auth.userId, row));
    });
    router.patch('/tasks/:id', auth.requireAuth, async (req, res) => data(res, await update(req.auth, z.uuid().parse(req.params.id), req.body)));
    router.post('/tasks/:id/complete', auth.requireAuth, async (req, res) => data(res, await transition(req.auth, z.uuid().parse(req.params.id), req.body, 'completed')));
    router.post('/tasks/:id/reopen', auth.requireAuth, async (req, res) => data(res, await transition(req.auth, z.uuid().parse(req.params.id), req.body, 'open')));
    router.delete('/tasks/:id', auth.requireAuth, async (req, res) => data(res, await setTrash(req.auth, z.uuid().parse(req.params.id), {
      requestId: req.get('Idempotency-Key'), baseRevision: req.query.baseRevision,
    }, true)));
    router.post('/tasks/:id/restore', auth.requireAuth, async (req, res) => data(res, await setTrash(req.auth, z.uuid().parse(req.params.id), req.body, false)));
    router.put('/tasks/:id/actions', auth.requireAuth, async (req, res) => data(res, await replaceActions(req.auth, z.uuid().parse(req.params.id), req.body)));
    router.get('/tasks', auth.requireAuth, async (req, res) => {
      const query = z.object({ state: z.enum(['open','completed','trash','all']).default('open'), cursor: z.string().max(2000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(req.query);
      const filterHash = auth.digest(stable({ state: query.state }), 'task-list-filter');
      const params = [req.auth.userId], clauses = ['user_id=$1'];
      const add = (value) => { params.push(value); return `$${params.length}`; };
      if (query.state !== 'all') clauses.push(`status=${add(query.state)}`);
      if (query.cursor) {
        const cursor = unpackCursor(query.cursor, req.auth.userId, filterHash);
        clauses.push(`(CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,coalesce(date_trunc('milliseconds',due_at),'infinity'::timestamptz),date_trunc('milliseconds',created_at),id) >
          (${add(cursor.nullDue)}::integer,coalesce(${add(cursor.dueAt)}::timestamptz,'infinity'::timestamptz),${add(cursor.createdAt)}::timestamptz,${add(cursor.id)}::uuid)`);
      }
      const { rows } = await pool.query(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
        ORDER BY date_trunc('milliseconds',due_at) ASC NULLS LAST,date_trunc('milliseconds',created_at) ASC,id ASC LIMIT ${add(query.limit + 1)}`, params);
      const hasMore = rows.length > query.limit, page = rows.slice(0, query.limit), last = page.at(-1);
      data(res, { items: await Promise.all(page.map((row) => view(pool, req.auth.userId, row))), hasMore,
        nextCursor: hasMore ? packCursor({ userId: req.auth.userId, filterHash, nullDue: last.due_at ? 0 : 1,
          dueAt: last.due_at?.toISOString() ?? null, createdAt: last.created_at.toISOString(), id: last.id }) : null });
    });
  }
  return { mount };
}
