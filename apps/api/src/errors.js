export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
export const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到这条记录');
export const unauthorized = () => new ApiError(401, 'SESSION_INVALID', '登录状态已失效，请重新登录');
export function data(res, value, status = 200) {
  return res.status(status).json({ data: value, meta: { requestId: res.locals.requestId } });
}
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') error = new ApiError(400, 'INVALID_JSON', '请求不是有效的 JSON');
  if (error.type === 'entity.too.large') error = new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
  const validation = error.name === 'ZodError' || error.name === 'ValidationError';
  const status = error.status ?? (validation ? 422 : 500);
  const code = error.code?.startsWith?.('23') ? 'DATABASE_CONFLICT' : error.code;
  const body = { code: status >= 500 ? 'INTERNAL_ERROR' : (code ?? (validation ? 'VALIDATION_FAILED' : 'REQUEST_FAILED')), message: status >= 500 ? '服务暂时不可用，请稍后重试' : error.message };
  if (validation && error.issues) body.message = '请检查输入内容';
  if (error.details && status < 500) body.details = error.details;
  if (error.field) body.fields = { [error.field]: error.message };
  if (error.issues) body.fields = Object.fromEntries(error.issues.map((issue) => [issue.path.join('.'), issue.message]));
  if (status >= 500) console.error(JSON.stringify({ event: 'request_error', requestId: res.locals.requestId, name: error.name, code: error.code ?? 'UNKNOWN' }));
  res.status(status).json({ error: body, meta: { requestId: res.locals.requestId } });
}
