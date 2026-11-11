import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const directory = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 32 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request) {
  if (request.headers['content-type'] !== 'application/json') {
    const error = new Error('请求必须使用 application/json');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体不能超过 32 KiB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON 格式无效');
    error.status = 400;
    throw error;
  }
}

function validInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (title.length < 2 || title.length > 80 || content.length < 5 || content.length > 5000) return null;
  return { title, content };
}

export async function createLessonServer({ host = '127.0.0.1', port = 4185 } = {}) {
  const entries = [{ id: randomUUID(), title: '服务器里的第一篇', content: '这条记录来自 GET /api/entries。', entryDate: '2026-09-10' }];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
      if (url.pathname === '/api/entries') {
        if (request.method === 'GET') return sendJson(response, 200, { data: { entries } });
        if (request.method === 'POST') {
          const input = validInput(await readJson(request));
          if (!input) return sendJson(response, 400, { error: { code: 'VALIDATION_FAILED', message: '标题需 2–80 字符，正文需 5–5000 字符' } });
          const entry = { id: randomUUID(), ...input, entryDate: new Date().toLocaleDateString('en-CA') };
          entries.unshift(entry);
          return sendJson(response, 201, { data: { entry } });
        }
        response.setHeader('Allow', 'GET, POST');
        return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '这个接口只允许 GET 或 POST' } });
      }

      const file = staticFiles.get(url.pathname);
      if (file && request.method === 'GET') {
        const body = await readFile(join(directory, file[0]));
        response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
        return response.end(body);
      }
      return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: '找不到这个地址' } });
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status || 500, { error: { code: error.status ? 'INVALID_REQUEST' : 'SERVER_ERROR', message: error.status ? error.message : '服务器暂时无法处理请求' } });
      else response.destroy();
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await createLessonServer();
  console.log(`Lesson 09: http://127.0.0.1:${server.address().port}`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
