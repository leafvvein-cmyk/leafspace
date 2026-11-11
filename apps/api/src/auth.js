import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { parse, serialize } from 'cookie';
import { z } from 'zod';
import { transaction, userTransaction, appendEvent } from './db.js';
import { ApiError, data, notFound, unauthorized } from './errors.js';

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,31}$/, '账号需为 3–32 位字母、数字及 ._-，首位需为字母或数字');
const passwordSchema = z.string().refine((value) => [...value].length >= 12 && [...value].length <= 128 && Buffer.byteLength(value, 'utf8') <= 512, '密码需为 12–128 个字符');
const deviceSchema = z.object({ installationId: z.uuid(), platform: z.enum(['web', 'android', 'ios']), name: z.string().min(1).max(80) }).strict();
const credentialsSchema = z.object({ username: usernameSchema, password: z.string().max(512), device: deviceSchema }).strict();
const scopes = z.enum(['change_password', 'rotate_recovery_code', 'revoke_session', 'revoke_others', 'purge_entry', 'purge_entries', 'delete_account', 'unlock_device']);

export function publicUser(user, configured = user.recovery_configured ?? false) {
  return { id: user.id, username: user.username_normalized, displayName: user.display_name, timezone: user.timezone, revision: String(user.profile_revision), recoveryCodeConfigured: configured };
}

export function createAuth(pool, config) {
  const key = new TextEncoder().encode(config.secret);
  const refreshCookie = config.production ? '__Host-diary-refresh' : 'diary_refresh';
  const csrfCookie = config.production ? '__Host-diary-csrf' : 'diary_csrf';
  const digest = (value, domain = 'token') => createHmac('sha256', key).update(`${domain}:${value}`).digest('hex');
  const randomToken = () => randomBytes(32).toString('base64url');
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/' };
  const safeEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left), b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // A fixed dummy hash makes an unknown username perform password verification too.
  const dummyHash = argon2.hash(randomToken(), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const hashPassword = (value) => argon2.hash(value, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  function issueCsrf(res) {
    const nonce = randomToken();
    const token = `${nonce}.${digest(nonce, 'csrf')}`;
    res.append('Set-Cookie', serialize(csrfCookie, token, { ...cookieOptions, maxAge: 86400 }));
    return token;
  }

  function validCsrf(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) return false;
    const [nonce, signature] = token.split('.');
    return safeEqual(signature, digest(nonce, 'csrf'));
  }

  function csrf(req, res, next) {
    const token = req.get('X-CSRF-Token');
    const cookie = parse(req.headers.cookie ?? '')[csrfCookie];
    const [nonce, signature] = String(token ?? '').split('.');
    if (req.get('Origin') !== config.webOrigin || !safeEqual(token, cookie) || !safeEqual(signature, digest(nonce, 'csrf'))) {
      throw new ApiError(403, 'CSRF_INVALID', '安全验证已失效，请刷新登录页面');
    }
    next();
  }

  async function accessToken(userId, sessionId) {
    return new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
      .setIssuer('diary-api').setAudience('diary-client').setIssuedAt().setExpirationTime(`${config.accessSeconds}s`).sign(key);
  }

  async function requireAuth(req, res, next) {
    const token = req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if (!token) throw unauthorized();
    let payload;
    try { ({ payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: 'diary-api', audience: 'diary-client' })); }
    catch { throw unauthorized(); }
    if (!z.uuid().safeParse(payload.sub).success || !z.uuid().safeParse(payload.sid).success) throw unauthorized();
    const { rows: [principal] } = await pool.query(`SELECT u.*, s.id AS session_id, s.created_at AS session_created_at,
      s.platform AS session_platform, s.recovery_onboarding
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND u.id=$2 AND u.status='active' AND s.revoked_at IS NULL AND s.expires_at > now()`, [payload.sid, payload.sub]);
    if (!principal) throw unauthorized();
    req.auth = { userId: principal.id, sessionId: principal.session_id, platform: principal.session_platform, user: principal };
    await pool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval \'1 minute\'', [principal.session_id]);
    next();
  }

  async function rateLimit(req, res, next) {
    const buckets = [{ key: digest(req.ip, 'auth-ip'), limit: config.authIpLimit ?? 60 }];
    if (typeof req.body?.username === 'string') buckets.push({ key: digest(req.body.username.trim().toLowerCase(), 'auth-account'), limit: 12 });
    for (const bucket of buckets) {
      const { rows: [row] } = await pool.query(`INSERT INTO auth_rate_limits(bucket) VALUES($1)
        ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN auth_rate_limits.window_started_at < now()-interval '15 minutes' THEN 1 ELSE auth_rate_limits.attempts+1 END,
        window_started_at=CASE WHEN auth_rate_limits.window_started_at < now()-interval '15 minutes' THEN now() ELSE auth_rate_limits.window_started_at END
        RETURNING attempts, greatest(1,ceil(extract(epoch FROM (window_started_at+interval '15 minutes'-now()))))::int AS retry_after`, [bucket.key]);
      if (row.attempts > bucket.limit) {
        res.set('Retry-After', String(row.retry_after));
        throw new ApiError(429, 'RATE_LIMITED', '尝试次数较多，请稍后再试', { retryAfter: row.retry_after });
      }
    }
    next();
  }

  async function createSession(client, userId, device, onboarding = false) {
    const refresh = randomToken();
    const { rows: [session] } = await client.query(`INSERT INTO sessions(id,user_id,installation_id,platform,name,refresh_hash,refresh_family,expires_at,recovery_onboarding)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::int*interval '1 day',$9) RETURNING *`,
    [randomUUID(), userId, device.installationId, device.platform, device.name, digest(refresh), randomUUID(), config.sessionDays, onboarding]);
    return { session, refresh };
  }

  async function sessionResponse(res, user, session, refresh, native, status = 200) {
    const { rows: [recovery] } = await pool.query('SELECT EXISTS(SELECT 1 FROM recovery_codes WHERE user_id=$1 AND consumed_at IS NULL) AS configured', [user.id]);
    const output = { user: publicUser(user, recovery.configured), session: { id: session.id, platform: session.platform, name: session.name }, accessToken: await accessToken(user.id, session.id), accessExpiresAt: new Date(Date.now() + config.accessSeconds * 1000).toISOString() };
    if (native) { output.refreshToken = refresh; output.refreshExpiresAt = session.expires_at.toISOString(); }
    else {
      res.append('Set-Cookie', serialize(refreshCookie, refresh, { ...cookieOptions, expires: session.expires_at }));
      output.csrfToken = issueCsrf(res);
    }
    return data(res, output, status);
  }

  function register(native) {
    return async (req, res) => {
      const body = credentialsSchema.extend({ password: passwordSchema }).parse(req.body);
      if (!native && body.device.platform !== 'web') throw new ApiError(422, 'VALIDATION_FAILED', '网页设备类型应为 web');
      if (native && body.device.platform === 'web') throw new ApiError(422, 'VALIDATION_FAILED', 'App 设备类型应为 android 或 ios');
      const passwordHash = await hashPassword(body.password);
      let result;
      try {
        result = await transaction(pool, async (client) => {
          const { rows: [user] } = await client.query('INSERT INTO users(id,username_normalized,password_hash) VALUES($1,$2,$3) RETURNING *', [randomUUID(), body.username, passwordHash]);
          await client.query('INSERT INTO sync_state(user_id,generation) VALUES($1,$2)', [user.id, randomUUID()]);
          await client.query('INSERT INTO user_settings(user_id) VALUES($1)', [user.id]);
          return { user, ...await createSession(client, user.id, body.device, true) };
        });
      } catch (error) {
        if (error.code === '23505') throw new ApiError(409, 'USERNAME_TAKEN', '这个账号已被使用，请换一个');
        throw error;
      }
      await sessionResponse(res, result.user, result.session, result.refresh, native, 201);
    };
  }

  function login(native) {
    return async (req, res) => {
      const body = credentialsSchema.parse(req.body);
      if ((!native && body.device.platform !== 'web') || (native && body.device.platform === 'web')) throw new ApiError(422, 'VALIDATION_FAILED', '设备类型与登录方式不匹配');
      const { rows: [candidate] } = await pool.query('SELECT * FROM users WHERE username_normalized=$1', [body.username]);
      const valid = await argon2.verify(candidate?.password_hash ?? await dummyHash, body.password);
      if (!valid || !candidate || candidate.status !== 'active') throw new ApiError(401, 'AUTH_FAILED', '账号或密码错误');
      const result = await userTransaction(pool, candidate.id, null, async (client, user) => {
        if (user.password_hash !== candidate.password_hash) throw new ApiError(401, 'AUTH_FAILED', '账号或密码错误');
        return { user, ...await createSession(client, user.id, body.device) };
      });
      await sessionResponse(res, result.user, result.session, result.refresh, native);
    };
  }

  function refresh(native) {
    return async (req, res) => {
      const old = native ? z.object({ refreshToken: z.string().min(32).max(200) }).strict().parse(req.body).refreshToken : parse(req.headers.cookie ?? '')[refreshCookie];
      if (!old) throw unauthorized();
      const oldHash = digest(old);
      const { rows: [known] } = await pool.query(`SELECT user_id,id FROM sessions WHERE refresh_hash=$1
        UNION ALL SELECT s.user_id,s.id FROM used_refresh_tokens t JOIN sessions s ON s.id=t.session_id WHERE t.token_hash=$1 LIMIT 1`, [oldHash]);
      if (!known) throw unauthorized();
      const result = await userTransaction(pool, known.user_id, null, async (client, user) => {
        const { rows: [session] } = await client.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [known.id]);
        if (!session || session.revoked_at || session.expires_at <= new Date()) return { denied: true };
        if ((session.platform === 'web') === native) return { denied: true };
        if (session.refresh_hash !== oldHash) {
          await client.query('UPDATE sessions SET revoked_at=now() WHERE refresh_family=$1', [session.refresh_family]);
          return { denied: true }; // Commit revocation before returning 401.
        }
        const next = randomToken();
        await client.query('INSERT INTO used_refresh_tokens(token_hash,session_id) VALUES($1,$2)', [oldHash, session.id]);
        await client.query('UPDATE sessions SET refresh_hash=$1,last_seen_at=now() WHERE id=$2', [digest(next), session.id]);
        return { user, session, refresh: next };
      });
      if (result.denied) throw unauthorized();
      await sessionResponse(res, result.user, result.session, result.refresh, native);
    };
  }

  const targetKey = (targetId, targetIds) => targetIds ? digest([...new Set(targetIds)].sort().join(','), 'reauth-targets') : targetId ?? '';

  async function consumeReauth(client, auth, token, scope, target = '') {
    if (typeof token !== 'string') throw new ApiError(403, 'REAUTH_REQUIRED', '请再次验证密码');
    const { rowCount } = await client.query(`UPDATE reauth_tokens SET consumed_at=now()
      WHERE token_digest=$1 AND user_id=$2 AND session_id=$3 AND scope=$4 AND target_key=$5 AND expires_at>now() AND consumed_at IS NULL RETURNING token_digest`, [digest(token, 'reauth'), auth.userId, auth.sessionId, scope, target]);
    if (!rowCount) throw new ApiError(403, 'REAUTH_REQUIRED', '再次验证已过期或不适用于此操作');
  }

  function mount(router) {
    router.get('/auth/csrf', (req, res) => {
      const previous = parse(req.headers.cookie ?? '')[csrfCookie];
      data(res, { csrfToken: validCsrf(previous) ? previous : issueCsrf(res) });
    });
    router.post('/auth/register', csrf, rateLimit, register(false));
    router.post('/auth/login', csrf, rateLimit, login(false));
    router.post('/auth/refresh', csrf, refresh(false));
    router.post('/auth/native/register', rateLimit, register(true));
    router.post('/auth/native/login', rateLimit, login(true));
    router.post('/auth/native/refresh', refresh(true));
    router.post('/auth/logout', requireAuth, async (req, res) => {
      if (req.auth.platform === 'web') csrf(req, res, () => {});
      await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        if (req.auth.platform === 'web') {
          const cookie = parse(req.headers.cookie ?? '')[refreshCookie];
          const hash = cookie ? digest(cookie) : '';
          const { rowCount } = await client.query(`SELECT id FROM sessions WHERE id=$1 AND (
            refresh_hash=$2 OR EXISTS(SELECT 1 FROM used_refresh_tokens WHERE session_id=$1 AND token_hash=$2))`, [req.auth.sessionId, hash]);
          if (!rowCount) throw new ApiError(409, 'BROWSER_SESSION_CHANGED', '另一窗口已切换登录状态，请刷新后确认当前账号');
        }
        await client.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [req.auth.sessionId]);
      });
      if (req.auth.platform === 'web') res.append('Set-Cookie', serialize(refreshCookie, '', { ...cookieOptions, maxAge: 0 }));
      res.status(204).end();
    });
    router.get('/me', requireAuth, async (req, res) => {
      const { rows: [row] } = await pool.query('SELECT EXISTS(SELECT 1 FROM recovery_codes WHERE user_id=$1 AND consumed_at IS NULL) AS configured', [req.auth.userId]);
      data(res, publicUser(req.auth.user, row.configured));
    });
    router.patch('/me', requireAuth, async (req, res) => {
      const body = z.object({ displayName: z.string().max(80).optional(), timezone: z.string().max(100).optional(), baseRevision: z.string().regex(/^\d+$/) }).strict().parse(req.body);
      if (body.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { throw new ApiError(422, 'VALIDATION_FAILED', '时区无效'); } }
      const updated = await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client, user) => {
        if (String(user.profile_revision) !== body.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '账号资料已更新，请刷新后重试');
        const { rows: [next] } = await client.query('UPDATE users SET display_name=$1,timezone=$2,profile_revision=profile_revision+1 WHERE id=$3 RETURNING *', [body.displayName ?? user.display_name, body.timezone ?? user.timezone, user.id]);
        const { rows: [recovery] } = await client.query('SELECT EXISTS(SELECT 1 FROM recovery_codes WHERE user_id=$1 AND consumed_at IS NULL) AS configured', [user.id]);
        const profile = publicUser(next, recovery.configured);
        await appendEvent(client, user.id, [{ entity: 'profile', id: user.id, action: 'upsert', value: profile }]);
        return profile;
      });
      data(res, updated);
    });
    router.get('/sessions', requireAuth, async (req, res) => {
      const { rows } = await pool.query('SELECT id,name,platform,created_at,last_seen_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC', [req.auth.userId]);
      data(res, { items: rows.map((session) => ({ id: session.id, name: session.name, platform: session.platform, createdAt: session.created_at, lastSeenAt: session.last_seen_at, isCurrent: session.id === req.auth.sessionId })) });
    });
    router.post('/auth/reauth', requireAuth, rateLimit, async (req, res) => {
      const body = z.object({ password: z.string().max(512), scope: scopes, targetId: z.uuid().optional(), targetIds: z.array(z.uuid()).min(1).max(20).optional() }).strict().parse(req.body);
      if (body.targetId && body.targetIds || body.scope === 'purge_entries' && !body.targetIds || ['purge_entry', 'revoke_session'].includes(body.scope) && !body.targetId) throw new ApiError(422, 'VALIDATION_FAILED', '再次验证的目标不完整');
      const token = randomToken();
      await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client, user) => {
        if (!await argon2.verify(user.password_hash, body.password)) throw new ApiError(403, 'REAUTH_FAILED', '密码验证未通过');
        await client.query('INSERT INTO reauth_tokens(token_digest,user_id,session_id,scope,target_key,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'5 minutes\')', [digest(token, 'reauth'), user.id, req.auth.sessionId, body.scope, targetKey(body.targetId, body.targetIds)]);
      });
      data(res, { reauthToken: token, expiresAt: new Date(Date.now() + 300000).toISOString() });
    });
    router.post('/security/password', requireAuth, async (req, res) => {
      const body = z.object({ newPassword: passwordSchema, reauthToken: z.string(), requestId: z.uuid() }).strict().parse(req.body);
      const passwordHash = await hashPassword(body.newPassword);
      await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client, user) => {
        await consumeReauth(client, req.auth, body.reauthToken, 'change_password');
        await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, user.id]);
        await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id]);
      });
      data(res, { changed: true, loginRequired: true });
    });
    router.post('/security/recovery-code', requireAuth, async (req, res) => {
      const body = z.object({ reauthToken: z.string().optional(), requestId: z.uuid() }).strict().parse(req.body);
      const code = randomBytes(24).toString('hex').toUpperCase();
      await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client, user) => {
        const { rowCount } = await client.query('SELECT user_id FROM recovery_codes WHERE user_id=$1', [user.id]);
        if (rowCount || !req.auth.user.recovery_onboarding || Date.now() - req.auth.user.session_created_at.getTime() > 300000) await consumeReauth(client, req.auth, body.reauthToken, 'rotate_recovery_code');
        await client.query(`INSERT INTO recovery_codes(user_id,code_digest) VALUES($1,$2)
          ON CONFLICT(user_id) DO UPDATE SET code_digest=EXCLUDED.code_digest,created_at=now(),consumed_at=NULL`, [user.id, digest(code, 'recovery')]);
      });
      data(res, { recoveryCode: code.match(/.{8}/g).join('-'), displayedOnce: true });
    });
    router.post('/auth/password-reset', rateLimit, async (req, res) => {
      const body = z.object({ username: usernameSchema, recoveryCode: z.string().min(1).max(128), newPassword: passwordSchema }).strict().parse(req.body);
      const { rows: [candidate] } = await pool.query(`SELECT u.id,u.status,r.code_digest,r.consumed_at FROM users u
        LEFT JOIN recovery_codes r ON r.user_id=u.id WHERE u.username_normalized=$1`, [body.username]);
      const failure = new ApiError(400, 'RECOVERY_FAILED', '账号或恢复码无效');
      const supplied = digest(body.recoveryCode.replace(/[\s-]/g, '').toUpperCase(), 'recovery');
      const valid = safeEqual(candidate?.code_digest ?? digest('missing-code', 'recovery'), supplied);
      if (!valid || !candidate || candidate.status !== 'active' || candidate.consumed_at) throw failure;
      const passwordHash = await hashPassword(body.newPassword);
      try { await userTransaction(pool, candidate.id, null, async (client, user) => {
        const { rows: [record] } = await client.query('SELECT * FROM recovery_codes WHERE user_id=$1 FOR UPDATE', [user.id]);
        if (!record || record.consumed_at || !safeEqual(record.code_digest, digest(body.recoveryCode.replace(/[\s-]/g, '').toUpperCase(), 'recovery'))) throw failure;
        await client.query('UPDATE recovery_codes SET consumed_at=now() WHERE user_id=$1', [user.id]);
        await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, user.id]);
        await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [user.id]);
      }); } catch (error) { if (error.code === 'SESSION_INVALID') throw failure; throw error; }
      data(res, { changed: true, loginRequired: true });
    });
    router.delete('/sessions/:id', requireAuth, async (req, res) => {
      const id = z.uuid().parse(req.params.id);
      await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const { rowCount } = await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2', [id, req.auth.userId]);
        if (!rowCount) throw notFound();
        await consumeReauth(client, req.auth, req.get('X-Reauth-Token'), 'revoke_session', id);
        await client.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1', [id]);
      });
      res.status(204).end();
    });
    router.post('/sessions/revoke-others', requireAuth, async (req, res) => {
      const body = z.object({ reauthToken: z.string(), requestId: z.uuid() }).strict().parse(req.body);
      await userTransaction(pool, req.auth.userId, req.auth.sessionId, async (client) => {
        const requestHash = digest('revoke_others', 'auth-operation');
        const { rows: [receipt] } = await client.query('SELECT operation,request_hash FROM auth_operation_receipts WHERE user_id=$1 AND session_id=$2 AND request_id=$3', [req.auth.userId, req.auth.sessionId, body.requestId]);
        if (receipt) {
          if (receipt.operation !== 'revoke_others' || receipt.request_hash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '此操作编号已用于不同请求');
          return;
        }
        await consumeReauth(client, req.auth, body.reauthToken, 'revoke_others');
        await client.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [req.auth.userId, req.auth.sessionId]);
        await client.query('INSERT INTO auth_operation_receipts(user_id,session_id,request_id,operation,request_hash) VALUES($1,$2,$3,$4,$5)', [req.auth.userId, req.auth.sessionId, body.requestId, 'revoke_others', requestHash]);
      });
      res.status(204).end();
    });
  }
  return { mount, requireAuth, csrf, consumeReauth, targetKey, digest };
}
