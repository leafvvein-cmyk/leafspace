const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASCII_TOKEN = /^[A-Za-z0-9_.-]+$/;

export class ApiError extends Error {
  constructor(code, message, { status = 0, fields, details, retryAfter, requestId } = {}) {
    super(message); Object.assign(this, { name: 'ApiError', code, status, fields, details, retryAfter, requestId });
  }
}

export function validateCredentials({ username, password, confirmation }, { register = false } = {}) {
  const fields = {};
  const normalized = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalized)) fields.username = '账号为 3–32 位字母、数字及 ._-，首位需为字母或数字';
  if (typeof password !== 'string' || !password) fields.password = '请输入密码';
  else if (register && ([...password].length < 12 || [...password].length > 128 || new TextEncoder().encode(password).length > 512)) fields.password = '密码需为 12–128 个字符';
  if (register && confirmation !== password) fields.confirmation = '两次输入的密码不一致';
  if (Object.keys(fields).length) throw new ApiError('VALIDATION_FAILED', '请检查输入内容', { fields });
  return { username: normalized, password };
}

export function apiBase({ native, configured, origin }) {
  if (native) {
    if (!configured) throw new ApiError('API_NOT_CONFIGURED', '手机 App 尚未配置 HTTPS 服务地址，本机内容仍可保留。');
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ApiError('API_NOT_CONFIGURED', '手机服务地址必须是无凭据、无查询参数的 HTTPS 地址。');
    return url.href.replace(/\/$/, '');
  }
  const url = new URL(configured || '/api/v1', origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.hash) throw new ApiError('API_NOT_CONFIGURED', '网页接口必须与当前站点同源。');
  return url.href.replace(/\/$/, '');
}

/** Tokens stay in this closure. The shared metadata contains only identity,
 * epoch and uncertainty flags; never tokens, passwords or recovery codes.
 */
export function createAuthClient({ baseUrl, native = false, platform = 'web', metadata, secrets, fetcher = globalThis.fetch, locks = globalThis.navigator?.locks, channel, onInvalidated = () => {} }) {
  let access = null;
  let state = { status: 'guest', user: null, epoch: null, sessionId: null };
  let nativeQueue = Promise.resolve();
  const view = () => structuredClone(state);
  const descriptor = () => metadata.getSetting('auth-context', null);
  const changed = () => new ApiError('AUTH_CONTEXT_CHANGED', '登录账号已在另一个窗口改变。原账号草稿已保留，请重新确认登录。');
  function invalidated(reason, status = 'expired') {
    access = null; state = { ...state, status, reason, offlineEligible: false };
    // A view callback cannot undo a committed security transition.
    try { onInvalidated({ reason, state: view() }); } catch { /* fail closed */ }
  }
  const announce = () => channel?.postMessage({ type: 'auth-changed', epoch: state.epoch });
  function locked(task) {
    if (!native) {
      if (!locks?.request) return Promise.reject(new ApiError('BROWSER_UNSUPPORTED', '此浏览器不能安全协调多窗口登录，请使用较新的 Chrome 或 Edge。'));
      return locks.request('diary-v2:authentication', task);
    }
    const result = nativeQueue.catch(() => {}).then(task); nativeQueue = result; return result;
  }
  async function raw(path, { method = 'GET', body, binary, contentType, responseType = 'json', token, csrfToken, reauthToken, deletionReceiptToken, idempotencyKey } = {}) {
    if (!baseUrl) throw new ApiError('API_NOT_CONFIGURED', '手机 App 尚未配置 HTTPS 服务地址，本机内容仍可保留。');
    if (!/^\/[a-z0-9/_-]+(?:\?[A-Za-z0-9%=&_.-]*)?$/i.test(path)) throw new ApiError('INVALID_API_PATH', '接口地址不正确');
    const headers = new Headers();
    if (body !== undefined && binary !== undefined) throw new ApiError('INVALID_REQUEST', '请求内容格式无效');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (binary !== undefined) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new ApiError('INVALID_REQUEST', '图片类型无效');
      headers.set('Content-Type', contentType);
    }
    for (const [name, value] of [['Authorization', token ? `Bearer ${token}` : null], ['X-CSRF-Token', csrfToken], ['X-Reauth-Token', reauthToken], ['X-Deletion-Receipt', deletionReceiptToken], ['Idempotency-Key', idempotencyKey]]) {
      if (value) {
        if (!/^[\x20-\x7e]+$/.test(value)) throw new ApiError('INVALID_CREDENTIAL', '登录凭据格式无效，请重新登录');
        headers.set(name, value);
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), binary === undefined ? 15000 : 60000);
    try {
      const response = await fetcher(`${baseUrl}${path}`, { method, headers, body: binary === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : binary, credentials: native ? 'omit' : 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status === 204) return null;
      if (response.ok && responseType === 'image') {
        if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/webp') throw new ApiError('INVALID_RESPONSE', '图片响应类型无效', { status: response.status });
        const declared = Number(response.headers.get('Content-Length') || 0);
        if (declared > 10 * 1024 * 1024) throw new ApiError('INVALID_RESPONSE', '云端图片超过本机安全限制', { status: response.status });
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new ApiError('INVALID_RESPONSE', '云端图片大小无效', { status: response.status });
        return bytes;
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw new ApiError('INVALID_RESPONSE', '服务响应暂时无法读取，请稍后重试', { status: response.status }); }
      if (!response.ok) throw new ApiError(payload.error?.code ?? 'REQUEST_FAILED', payload.error?.message ?? '请求没有完成', {
        status: response.status, fields: payload.error?.fields, details: payload.error?.details,
        retryAfter: Number(response.headers.get('Retry-After') || payload.error?.details?.retryAfter || 0), requestId: payload.meta?.requestId,
      });
      return payload.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('NETWORK_UNAVAILABLE', '暂时无法连接服务。请检查网络；你的本机草稿不会被清空。');
    } finally { clearTimeout(timeout); }
  }
  async function cookiePost(path, options = {}) {
    if (native) return raw(path, { ...options, method: 'POST' });
    // CSRF read + cookie mutation share the SAME cross-tab lock supplied by
    // the caller. One safe retry only if CSRF rejected before any mutation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const csrf = await raw('/auth/csrf');
      try { return await raw(path, { ...options, method: 'POST', csrfToken: csrf.csrfToken }); }
      catch (error) { if (error.code !== 'CSRF_INVALID' || attempt) throw error; }
    }
  }
  function validSession(value) {
    return value && UUID.test(value.user?.id) && UUID.test(value.session?.id)
      && ASCII_TOKEN.test(value.accessToken ?? '') && Number.isFinite(Date.parse(value.accessExpiresAt))
      && (!native || /^[A-Za-z0-9_-]{32,200}$/.test(value.refreshToken ?? ''));
  }
  async function install(value, epoch) {
    if (!validSession(value)) throw new ApiError('INVALID_RESPONSE', '服务返回的登录资料不完整，请重新登录');
    if (native) await secrets.write({ userId: value.user.id, refreshToken: value.refreshToken });
    const next = { epoch, user: value.user, sessionId: value.session.id, signedOut: false, refreshPending: false };
    await metadata.setSetting('auth-context', next);
    access = { token: value.accessToken, expiresAt: Date.parse(value.accessExpiresAt) };
    state = { status: 'online', user: value.user, epoch, sessionId: value.session.id };
    return view();
  }
  async function checkContext() {
    let persisted;
    try { persisted = await descriptor(); }
    catch (error) { invalidated('storage-unavailable'); throw error; }
    if (state.epoch && persisted?.epoch !== state.epoch) { invalidated('remote-change'); throw changed(); }
    if (persisted?.refreshPending) {
      invalidated('AUTH_UNCERTAIN');
      throw new ApiError('AUTH_UNCERTAIN', '上次登录状态更新未能确认，请重新登录；本机内容仍保留。');
    }
    if (persisted?.signedOut) {
      invalidated('SESSION_INVALID');
      throw new ApiError('SESSION_INVALID', '请重新登录后继续', { status: 401 });
    }
    return persisted;
  }
  async function refreshLocked({ initial = false } = {}) {
    let saved, epoch, attempted = false;
    try {
      saved = initial ? await descriptor() : await checkContext();
      if (saved?.refreshPending) throw new ApiError('AUTH_UNCERTAIN', '上次登录未能确认，请重新登录；本机内容仍保留。');
      if (saved?.signedOut) throw new ApiError('SESSION_INVALID', '请重新登录后继续', { status: 401 });
      const expectedUserId = saved?.user?.id ?? state.user?.id;
      epoch = saved?.epoch ?? crypto.randomUUID();
      const stored = native ? await secrets.read() : null;
      if (native && (!stored?.refreshToken || expectedUserId && stored.userId !== expectedUserId)) throw new ApiError('SESSION_INVALID', '请重新登录后继续', { status: 401 });
      await metadata.setSetting('auth-context', { ...saved, epoch, refreshPending: true });
      attempted = true;
      const result = await cookiePost(native ? '/auth/native/refresh' : '/auth/refresh', { body: native ? { refreshToken: stored.refreshToken } : undefined });
      if (expectedUserId && result.user?.id !== expectedUserId) throw changed();
      return await install(result, epoch);
    } catch (error) {
      // An ambiguous response may have consumed the refresh token. Persist this
      // condition before allowing any reload/retry; never blindly replay it.
      invalidated(error.code);
      if (attempted && (error.status === 401 || error.code === 'CSRF_INVALID')) {
        await metadata.setSetting('auth-context', { ...saved, epoch, refreshPending: false, signedOut: true });
      }
      if (attempted) announce();
      throw error;
    }
  }
  async function authorization() {
    await checkContext();
    if (!state.user || state.status !== 'online') throw new ApiError('SESSION_INVALID', '请先登录', { status: 401 });
    if (!access || access.expiresAt < Date.now() + 30000) await refreshLocked();
    return { token: access.token, userId: state.user.id, epoch: state.epoch };
  }
  channel?.addEventListener('message', ({ data }) => {
    // Read the latest descriptor under the lock, not the possibly delayed
    // message's epoch. Same-epoch revocation must invalidate sibling tabs too.
    if (data?.type === 'auth-changed') locked(async () => {
      const saved = await descriptor();
      if (saved?.epoch !== state.epoch || saved?.signedOut || saved?.refreshPending) invalidated('remote-change');
    }).catch(() => invalidated('storage-unavailable'));
  });

  return {
    view,
    async initialize() {
      return locked(async () => {
        const saved = await descriptor();
        if (saved?.user && UUID.test(saved.user.id)) state = { status: 'restoring', user: saved.user, epoch: saved.epoch, sessionId: saved.sessionId };
        if (saved?.signedOut) { state = { status: 'guest', user: null, epoch: saved.epoch, sessionId: null }; return view(); }
        if (!baseUrl && !saved?.user) return view();
        try { return await refreshLocked({ initial: true }); }
        catch (error) {
          // No prior account: a missing cookie is the normal guest state.
          if (!saved?.user && error.status === 401) state = { status: 'guest', user: null, epoch: null, sessionId: null };
          else if (saved?.user && !saved.signedOut && ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE', 'AUTH_UNCERTAIN', 'API_NOT_CONFIGURED'].includes(error.code)) {
            // This is only a candidate for locally PIN-gated access. Main must
            // still verify that this device configured a local lock before it
            // opens the account database, and cloud operations remain disabled.
            state = { ...state, status: 'expired', reason: error.code, offlineEligible: true };
          }
          return view();
        }
      });
    },
    async login(input, { register = false } = {}) {
      const credentials = validateCredentials(input, { register });
      return locked(async () => {
        let installationId = await metadata.getSetting('installation-id', null);
        if (!UUID.test(installationId ?? '')) { installationId = crypto.randomUUID(); await metadata.setSetting('installation-id', installationId); }
        const body = { ...credentials, device: { installationId, platform, name: native ? (platform === 'android' ? '我的 Android 手机' : '我的 iPhone') : '我的电脑浏览器' } };
        const epoch = crypto.randomUUID();
        // A browser can process Set-Cookie before losing the response body.
        // Mark the transition BEFORE sending any session-changing request.
        await metadata.setSetting('auth-context', { epoch, refreshPending: true, signedOut: false });
        state = { status: 'restoring', user: null, epoch, sessionId: null };
        invalidated('login-transition', 'restoring'); announce();
        try {
          const result = await cookiePost(`/auth/${native ? 'native/' : ''}${register ? 'register' : 'login'}`, { body });
          const installed = await install(result, epoch); announce(); return installed;
        } catch (error) {
          invalidated(error.code);
          if (['VALIDATION_FAILED', 'AUTH_FAILED', 'INVALID_CREDENTIALS', 'USERNAME_TAKEN', 'RATE_LIMITED', 'CSRF_INVALID'].includes(error.code)) {
            await metadata.setSetting('auth-context', { epoch, refreshPending: false, signedOut: true });
          }
          announce(); throw error;
        }
      });
    },
    async request(path, options = {}) {
      const owner = { userId: state.user?.id, epoch: state.epoch };
      const assertOwner = () => {
        if (owner.epoch !== state.epoch || owner.userId !== state.user?.id) throw changed();
      };
      let authorized = await locked(async () => { assertOwner(); return authorization(); });
      assertOwner();
      let result;
      try { result = await raw(path, { ...options, token: authorized.token }); }
      catch (error) {
        if (error.status !== 401) throw error;
        await locked(async () => { assertOwner(); await refreshLocked(); assertOwner(); });
        authorized = await locked(async () => { assertOwner(); return authorization(); });
        assertOwner();
        result = await raw(path, { ...options, token: authorized.token });
      }
      assertOwner();
      await locked(async () => { assertOwner(); await checkContext(); assertOwner(); });
      assertOwner();
      return result;
    },
    async upload(path, { mimeType, bytes }) {
      const owner = { userId: state.user?.id, epoch: state.epoch };
      const assertOwner = () => { if (owner.epoch !== state.epoch || owner.userId !== state.user?.id) throw changed(); };
      await locked(async () => { assertOwner(); await authorization(); assertOwner(); });
      const result = await raw(path, { method: 'PUT', binary: bytes, contentType: mimeType });
      assertOwner(); await locked(async () => { assertOwner(); await checkContext(); assertOwner(); });
      return result;
    },
    async download(path) {
      const owner = { userId: state.user?.id, epoch: state.epoch };
      const assertOwner = () => { if (owner.epoch !== state.epoch || owner.userId !== state.user?.id) throw changed(); };
      await locked(async () => { assertOwner(); await authorization(); assertOwner(); });
      const result = await raw(path, { responseType: 'image' });
      assertOwner(); await locked(async () => { assertOwner(); await checkContext(); assertOwner(); });
      return result;
    },
    deletionStatus(id, receiptToken) {
      if (!UUID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(receiptToken ?? '')) return Promise.reject(new ApiError('INVALID_DELETION_RECEIPT', '注销回执无效'));
      return raw(`/account-deletions/${id}`, { deletionReceiptToken: receiptToken });
    },
    async resetPassword(input) {
      const credentials = validateCredentials(input, { register: true });
      if (!input.recoveryCode?.trim()) throw new ApiError('VALIDATION_FAILED', '请输入恢复码', { fields: { recoveryCode: '请输入恢复码' } });
      return raw('/auth/password-reset', { method: 'POST', body: { username: credentials.username, recoveryCode: input.recoveryCode, newPassword: credentials.password } });
    },
    async logout() {
      return locked(async () => {
        const authorized = await authorization();
        await metadata.setSetting('auth-context', { ...await descriptor(), refreshPending: true });
        try {
          await cookiePost('/auth/logout', { token: authorized.token });
          return await clearLocalSession();
        } catch (error) { invalidated(error.code); announce(); throw error; }
      });
    },
    async forgetRevokedSession({ expectedEpoch = state.epoch, expectedUserId = state.user?.id } = {}) {
      // Use after a confirmed password change/reset or revocation. This does
      // not claim a server logout and never deletes any diary database.
      return locked(async () => {
        const saved = await descriptor();
        if (state.epoch !== expectedEpoch || state.user?.id !== expectedUserId || saved?.epoch !== expectedEpoch || saved?.user?.id !== expectedUserId) {
          invalidated('remote-change'); throw changed();
        }
        return clearLocalSession();
      });
    },
    async updateProfile(body) {
      const owner = { userId: state.user?.id, epoch: state.epoch };
      const profile = await this.request('/me', { method: 'PATCH', body });
      await locked(async () => {
        if (owner.epoch !== state.epoch || owner.userId !== state.user?.id || profile.id !== owner.userId) throw changed();
        await checkContext(); state = { ...state, user: profile };
        await metadata.setSetting('auth-context', { ...await descriptor(), user: profile });
      });
      return profile;
    },
  };

  async function clearLocalSession() {
    const epoch = crypto.randomUUID();
    invalidated('local-signout');
    await metadata.setSetting('auth-context', { epoch, signedOut: true, refreshPending: false });
    state = { status: 'guest', user: null, epoch, sessionId: null };
    announce();
    if (native) await secrets.clear();
    return view();
  }
}
