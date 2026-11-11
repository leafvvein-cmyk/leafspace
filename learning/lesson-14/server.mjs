import express from 'express';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(directory, 'public');
class ApiError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
const entryColumns = 'id,entry_date AS entryDate,title,content,revision,updated_at AS updatedAt';

function createApp(db) {
  const app = express();
  const byId = db.prepare(`SELECT ${entryColumns} FROM entries WHERE id=?`);
  const allEntries = db.prepare(`SELECT ${entryColumns} FROM entries ORDER BY entry_date DESC,updated_at DESC`);
  const savedMutation = db.prepare('SELECT response_json FROM mutations WHERE client_request_id=?');
  app.disable('x-powered-by'); app.use(express.json({ limit: '32kb' })); app.use(express.static(publicDirectory, { dotfiles: 'deny' }));

  app.get('/api/snapshot', (request, response) => response.json({ data: { serverRevision: db.prepare('SELECT revision FROM sync_state WHERE id=1').get().revision, entries: allEntries.all() } }));
  app.post('/api/mutations', (request, response) => {
    const clientRequestId = String(request.body?.clientRequestId ?? '');
    const operation = request.body?.operation;
    const input = request.body?.entry;
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(clientRequestId) || operation !== 'upsert' || !input || typeof input.id !== 'string') throw new ApiError(400, 'VALIDATION_FAILED', '同步请求格式不正确');
    const cached = savedMutation.get(clientRequestId);
    if (cached) return response.json({ data: JSON.parse(cached.response_json), meta: { replayed: true } });
    const entryDate = String(input.entryDate ?? ''), title = String(input.title ?? '').trim(), content = String(input.content ?? '').trim(), baseRevision = Number(input.baseRevision ?? 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || !title || title.length > 120 || !content || content.length > 5000 || !Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new ApiError(400, 'VALIDATION_FAILED', '日记内容或基础版本不正确');
    db.exec('BEGIN IMMEDIATE');
    try {
      const inside = savedMutation.get(clientRequestId);
      if (inside) { db.exec('COMMIT'); return response.json({ data: JSON.parse(inside.response_json), meta: { replayed: true } }); }
      const current = byId.get(input.id);
      if ((current?.revision ?? 0) !== baseRevision) {
        db.exec('ROLLBACK');
        return response.status(409).json({ error: { code: 'REVISION_CONFLICT', message: '服务器已有不同版本，已停止自动覆盖', details: { current } } });
      }
      const revision = db.prepare('SELECT revision FROM sync_state WHERE id=1').get().revision + 1;
      db.prepare('UPDATE sync_state SET revision=? WHERE id=1').run(revision);
      const updatedAt = new Date().toISOString();
      if (current) db.prepare('UPDATE entries SET entry_date=?,title=?,content=?,revision=?,updated_at=? WHERE id=?').run(entryDate, title, content, revision, updatedAt, input.id);
      else db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)').run(input.id, entryDate, title, content, revision, updatedAt);
      const result = { entry: { id: input.id, entryDate, title, content, revision, updatedAt }, serverRevision: revision };
      db.prepare('INSERT INTO mutations VALUES(?,?,?)').run(clientRequestId, JSON.stringify(result), updatedAt);
      db.exec('COMMIT'); response.status(current ? 200 : 201).json({ data: result, meta: { replayed: false } });
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  });
  app.use('/api', (request, response, next) => next(new ApiError(404, 'NOT_FOUND', '找不到这个接口')));
  app.use((error, request, response, next) => { if (response.headersSent) return next(error); const status = error.status || 500; response.status(status).json({ error: { code: error.code || 'SERVER_ERROR', message: status >= 500 ? '服务暂时无法处理请求' : error.message } }); });
  return app;
}

export async function createLessonServer({ host = '127.0.0.1', port = 4190, databasePath } = {}) {
  const path = databasePath ?? join(directory, 'data', 'lesson-14.sqlite'); if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const database = openDatabase(path), app = createApp(database), server = await new Promise((resolve, reject) => { const instance = app.listen(port, host, () => resolve(instance)); instance.once('error', reject); }); let closed = false;
  return { server, database, async close() { if (closed) return; closed = true; await new Promise((resolve) => server.close(resolve)); database.close(); } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { const lesson = await createLessonServer(); console.log(`Lesson 14: http://127.0.0.1:${lesson.server.address().port}`); const stop = async () => { await lesson.close(); process.exit(0); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); }
