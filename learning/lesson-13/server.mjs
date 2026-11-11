import express from 'express';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, serialize } from 'cookie';
import { openDatabase } from './database.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(directory, 'public');
const cookieName = 'lesson13_session';
const demoUser = { id: 'lesson-13-demo', username: 'diary_student', password: 'learn-fetch-2026!' };
const digest = (value) => createHash('sha256').update(value).digest('hex');
class ApiError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }

async function seed(db) {
  if (db.prepare('SELECT 1 FROM users WHERE id=?').get(demoUser.id)) return;
  const passwordHash = await argon2.hash(demoUser.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(demoUser.id, demoUser.username, passwordHash, now);
    const insert = db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)');
    insert.run(randomUUID(), demoUser.id, '2026-09-07', '第一次连接 API', '这篇日记来自服务端 SQLite，不在 HTML 文件里。', now);
    insert.run(randomUUID(), demoUser.id, '2026-09-08', '观察请求过程', '打开开发者工具的 Network 面板，找到 GET /api/entries。', now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function createApp(db) {
  const app = express();
  const userByName = db.prepare('SELECT * FROM users WHERE username=?');
  const userBySession = db.prepare('SELECT u.id,u.username,s.id session_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_digest=? AND s.expires_at>?');
  const entriesByUser = db.prepare('SELECT id,entry_date AS entryDate,title,content,created_at AS createdAt FROM entries WHERE user_id=? ORDER BY entry_date DESC,created_at DESC');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(publicDirectory, { dotfiles: 'deny' }));

  function principal(request) {
    const token = parse(request.headers.cookie || '')[cookieName];
    return token ? userBySession.get(digest(token), new Date().toISOString()) ?? null : null;
  }
  function requireUser(request) {
    const user = principal(request);
    if (!user) throw new ApiError(401, 'SESSION_INVALID', '请先使用练习账号登录');
    return user;
  }

  app.post('/api/login', async (request, response) => {
    const username = String(request.body?.username ?? '').trim().toLowerCase();
    const password = request.body?.password;
    if (!username || typeof password !== 'string') throw new ApiError(400, 'VALIDATION_FAILED', '请填写账号和密码');
    const user = userByName.get(username);
    const valid = user ? await argon2.verify(user.password_hash, password).catch(() => false) : false;
    if (!valid) throw new ApiError(401, 'AUTH_FAILED', '账号或密码不正确');
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(randomUUID(), user.id, digest(token), new Date(Date.now() + 86400000).toISOString());
    response.append('Set-Cookie', serialize(cookieName, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400 }));
    response.json({ data: { user: { id: user.id, username: user.username } } });
  });
  app.get('/api/me', (request, response) => {
    const user = requireUser(request);
    response.json({ data: { user: { id: user.id, username: user.username } } });
  });
  app.get('/api/entries', (request, response) => {
    const user = requireUser(request);
    response.json({ data: { entries: entriesByUser.all(user.id) } });
  });
  app.post('/api/entries', (request, response) => {
    const user = requireUser(request);
    const entryDate = String(request.body?.entryDate ?? '');
    const title = String(request.body?.title ?? '').trim();
    const content = String(request.body?.content ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || !title || title.length > 120 || !content || content.length > 5000) throw new ApiError(400, 'VALIDATION_FAILED', '请填写有效日期、标题和正文');
    const entry = { id: randomUUID(), userId: user.id, entryDate, title, content, createdAt: new Date().toISOString() };
    db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)').run(entry.id, entry.userId, entry.entryDate, entry.title, entry.content, entry.createdAt);
    response.status(201).json({ data: { entry: { id: entry.id, entryDate, title, content, createdAt: entry.createdAt } } });
  });
  app.post('/api/logout', (request, response) => {
    const user = principal(request);
    if (user) db.prepare('DELETE FROM sessions WHERE id=?').run(user.session_id);
    response.append('Set-Cookie', serialize(cookieName, '', { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0 }));
    response.status(204).end();
  });
  app.use('/api', (request, response, next) => next(new ApiError(404, 'NOT_FOUND', '找不到这个接口')));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : error.status || 500;
    response.status(status).json({ error: { code: error.code || 'SERVER_ERROR', message: status >= 500 ? '服务暂时无法处理请求' : error.message } });
  });
  return app;
}

export async function createLessonServer({ host = '127.0.0.1', port = 4189, databasePath } = {}) {
  const path = databasePath ?? join(directory, 'data', 'lesson-13.sqlite');
  if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
  const database = openDatabase(path);
  await seed(database);
  const app = createApp(database);
  const server = await new Promise((resolve, reject) => { const instance = app.listen(port, host, () => resolve(instance)); instance.once('error', reject); });
  let closed = false;
  return { server, database, async close() { if (closed) return; closed = true; await new Promise((resolve) => server.close(resolve)); database.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lesson = await createLessonServer();
  console.log(`Lesson 13: http://127.0.0.1:${lesson.server.address().port}`);
  const stop = async () => { await lesson.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
