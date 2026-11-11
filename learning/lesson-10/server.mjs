import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = join(dirname(fileURLToPath(import.meta.url)), 'public');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function input(value, { partial = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'VALIDATION_FAILED', '请求正文必须是对象');
  const result = {};
  if (!partial || Object.hasOwn(value, 'title')) {
    if (typeof value.title !== 'string' || value.title.trim().length < 2 || value.title.trim().length > 80) throw new ApiError(400, 'VALIDATION_FAILED', '标题需 2–80 个字符');
    result.title = value.title.trim();
  }
  if (!partial || Object.hasOwn(value, 'content')) {
    if (typeof value.content !== 'string' || value.content.trim().length < 5 || value.content.trim().length > 5000) throw new ApiError(400, 'VALIDATION_FAILED', '正文需 5–5000 个字符');
    result.content = value.content.trim();
  }
  if (partial && Object.keys(result).length === 0) throw new ApiError(400, 'VALIDATION_FAILED', '至少提供一个可修改字段');
  return result;
}

export function createLessonApp() {
  const app = express();
  const entries = [{ id: randomUUID(), title: 'Express 的第一篇', content: '这条记录由 Router 返回。', entryDate: '2026-09-10', revision: 1 }];
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.locals.requestId = randomUUID();
    response.set('X-Request-ID', response.locals.requestId);
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '32kb', type: 'application/json' }));
  app.use(express.static(publicDirectory, { index: 'index.html', dotfiles: 'deny' }));

  const router = express.Router();
  const send = (response, data, status = 200) => response.status(status).json({ data, meta: { requestId: response.locals.requestId } });

  router.get('/entries', (request, response) => send(response, { entries }));
  router.post('/entries', (request, response) => {
    const value = input(request.body);
    const entry = { id: randomUUID(), ...value, entryDate: new Date().toLocaleDateString('en-CA'), revision: 1 };
    entries.unshift(entry);
    send(response, { entry }, 201);
  });
  router.get('/entries/:id', (request, response) => {
    const entry = entries.find((item) => item.id === request.params.id);
    if (!entry) throw new ApiError(404, 'ENTRY_NOT_FOUND', '找不到这篇练习日记');
    send(response, { entry });
  });
  router.patch('/entries/:id', (request, response) => {
    const entry = entries.find((item) => item.id === request.params.id);
    if (!entry) throw new ApiError(404, 'ENTRY_NOT_FOUND', '找不到这篇练习日记');
    Object.assign(entry, input(request.body, { partial: true }), { revision: entry.revision + 1 });
    send(response, { entry });
  });
  router.delete('/entries/:id', (request, response) => {
    const index = entries.findIndex((item) => item.id === request.params.id);
    if (index < 0) throw new ApiError(404, 'ENTRY_NOT_FOUND', '找不到这篇练习日记');
    entries.splice(index, 1);
    response.status(204).end();
  });
  app.use('/api', router);
  app.use((request, response, next) => next(new ApiError(404, 'NOT_FOUND', '找不到这个地址')));
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && error.status === 400 ? 400 : error.status || 500;
    const code = error.type === 'entity.too.large' ? 'BODY_TOO_LARGE' : error instanceof SyntaxError && error.status === 400 ? 'INVALID_JSON' : error.code || 'SERVER_ERROR';
    const message = status >= 500 ? '服务器暂时无法处理请求' : error.message;
    response.status(status).json({ error: { code, message }, meta: { requestId: response.locals.requestId } });
  });
  return app;
}

export async function createLessonServer({ host = '127.0.0.1', port = 4186 } = {}) {
  const app = createLessonApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await createLessonServer();
  console.log(`Lesson 10: http://127.0.0.1:${server.address().port}`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
