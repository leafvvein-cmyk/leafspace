import { argon2id } from 'hash-wasm';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const VAULT_CRYPTO_VERSION = 1;
export const VAULT_BACKUP_VERSION = 1;
export const VAULT_RECOVERY_VERSION = 1;
export const VAULT_KDF = Object.freeze({ algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, hashLength: 32 });
const PASSWORD_CHARACTER_GROUPS = Object.freeze([
  'abcdefghijkmnopqrstuvwxyz',
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  '23456789',
  '!@#$%^&*()-_=+[]{}:,.?',
]);

function secureIndex(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('密码字符集无效');
  const ceiling = 256 - (256 % limit), value = new Uint8Array(1);
  do { crypto.getRandomValues(value); } while (value[0] >= ceiling);
  return value[0] % limit;
}

export function generateVaultPassword(length = 24) {
  if (!Number.isInteger(length) || length < 16 || length > 128) throw new Error('生成密码长度需为 16–128 位');
  const alphabet = PASSWORD_CHARACTER_GROUPS.join(''), characters = PASSWORD_CHARACTER_GROUPS.map((group) => group[secureIndex(group.length)]);
  while (characters.length < length) characters.push(alphabet[secureIndex(alphabet.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const other = secureIndex(index + 1);
    [characters[index], characters[other]] = [characters[other], characters[index]];
  }
  return characters.join('');
}

function decodeBase32(value) {
  if (typeof value !== 'string') throw new Error('动态验证码密钥格式无效');
  const normalized = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!normalized || normalized.length > 256 || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('动态验证码密钥必须是 Base32 格式');
  let bits = 0, bitCount = 0; const bytes = [];
  for (const character of normalized) {
    bits = (bits << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character); bitCount += 5;
    if (bitCount >= 8) { bitCount -= 8; bytes.push((bits >>> bitCount) & 255); bits &= (1 << bitCount) - 1; }
  }
  if (bytes.length < 10 || (bitCount && bits !== 0)) throw new Error('动态验证码密钥长度或填充无效');
  return { normalized, bytes: Uint8Array.from(bytes) };
}

export async function generateTotp(secret, { now = Date.now(), digits = 6, period = 30 } = {}) {
  if (![6, 8].includes(digits) || ![30, 60].includes(period) || !Number.isFinite(now) || now < 0) throw new Error('动态验证码参数无效');
  const decodedSecret = decodeBase32(secret), counter = Math.floor(now / 1000 / period), message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) { message[index] = remaining & 255; remaining = Math.floor(remaining / 256); }
  try {
    const key = await crypto.subtle.importKey('raw', decodedSecret.bytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message)), offset = digest[digest.length - 1] & 15;
    const binary = ((digest[offset] & 127) * 0x1000000) + (digest[offset + 1] * 0x10000) + (digest[offset + 2] * 0x100) + digest[offset + 3];
    return String(binary % (10 ** digits)).padStart(digits, '0');
  } finally { decodedSecret.bytes.fill(0); message.fill(0); }
}

export function totpRemainingSeconds(now = Date.now(), period = 30) {
  if (![30, 60].includes(period) || !Number.isFinite(now) || now < 0) throw new Error('动态验证码参数无效');
  return period - (Math.floor(now / 1000) % period);
}

export function analyzeVaultHealth(bundles) {
  const weakIds = new Set(), reusedIds = new Set(), damagedIds = new Set(), passwords = new Map();
  for (const bundle of bundles ?? []) {
    const id = bundle?.record?.id, password = bundle?.item?.password;
    if (typeof id !== 'string') continue;
    if (typeof password !== 'string') { damagedIds.add(id); continue; }
    const groups = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
    if ([...password].length < 12 || ([...password].length < 16 && groups < 3)) weakIds.add(id);
    const matching = passwords.get(password) ?? [];
    matching.push(id); passwords.set(password, matching);
  }
  for (const matching of passwords.values()) if (matching.length > 1) for (const id of matching) reusedIds.add(id);
  passwords.clear();
  return { weakIds, reusedIds, damagedIds, issueIds: new Set([...weakIds, ...reusedIds, ...damagedIds]) };
}

function encoded(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decoded(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('保险库加密数据无效');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }

function formatRecoveryKey(bytes) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `DVK1-${hex.match(/.{1,4}/g).join('-')}`;
}

function parseRecoveryKey(value) {
  if (typeof value !== 'string') throw new Error('恢复密钥格式无效');
  const normalized = value.trim().toUpperCase().replace(/^DVK1-/, '').replace(/-/g, '');
  if (!/^[0-9A-F]{64}$/.test(normalized)) throw new Error('恢复密钥格式无效');
  return Uint8Array.from(normalized.match(/../g), (pair) => Number.parseInt(pair, 16));
}

async function recoveryWrap(raw) {
  const secret = randomBytes(32), nonce = randomBytes(12);
  try {
    const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: encoder.encode('diary-vault-recovery:v1') }, key, raw);
    return { recoveryKey: formatRecoveryKey(secret), recoveryWrappedKey: encoded(new Uint8Array(wrapped)),
      recoveryNonce: encoded(nonce), recoveryVersion: VAULT_RECOVERY_VERSION };
  } finally { secret.fill(0); }
}

function validateEncryptedConfig(raw) {
  if (!raw || raw.cryptoVersion !== VAULT_CRYPTO_VERSION || raw.kdf?.algorithm !== 'argon2id'
    || !Number.isInteger(raw.kdf.memoryKiB) || raw.kdf.memoryKiB < 19456 || raw.kdf.memoryKiB > 1048576
    || !Number.isInteger(raw.kdf.iterations) || raw.kdf.iterations < 2 || raw.kdf.iterations > 10
    || !Number.isInteger(raw.kdf.parallelism) || raw.kdf.parallelism < 1 || raw.kdf.parallelism > 4 || raw.kdf.hashLength !== 32) {
    throw new Error('加密备份的保险库设置无效');
  }
  for (const [name, value, max] of [['salt', raw.salt, 256], ['wrappedKey', raw.wrappedKey, 1024], ['wrapNonce', raw.wrapNonce, 256]]) {
    if (typeof value !== 'string' || value.length < 16 || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`加密备份的 ${name} 无效`);
  }
  const recoveryValues = [raw.recoveryWrappedKey, raw.recoveryNonce, raw.recoveryVersion];
  if (recoveryValues.some((value) => value != null)) {
    if (raw.recoveryVersion !== VAULT_RECOVERY_VERSION) throw new Error('加密备份的恢复密钥版本无效');
    for (const [name, value] of [['recoveryWrappedKey', raw.recoveryWrappedKey], ['recoveryNonce', raw.recoveryNonce]]) {
      if (typeof value !== 'string' || value.length < 16 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`加密备份的 ${name} 无效`);
    }
  }
  return { cryptoVersion: VAULT_CRYPTO_VERSION, kdf: { algorithm: 'argon2id', memoryKiB: raw.kdf.memoryKiB, iterations: raw.kdf.iterations,
    parallelism: raw.kdf.parallelism, hashLength: 32 }, salt: raw.salt, wrappedKey: raw.wrappedKey, wrapNonce: raw.wrapNonce,
    ...(raw.recoveryVersion ? { recoveryWrappedKey: raw.recoveryWrappedKey, recoveryNonce: raw.recoveryNonce, recoveryVersion: raw.recoveryVersion } : {}),
    revision: '0', localRevision: 0 };
}

function validateEncryptedRecord(raw) {
  if (!raw || typeof raw.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.id)
    || raw.cryptoVersion !== VAULT_CRYPTO_VERSION) throw new Error('加密备份中存在无效账号记录');
  for (const [value, max] of [[raw.ciphertext, 350000], [raw.nonce, 256]]) {
    if (typeof value !== 'string' || value.length < 16 || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('加密备份中存在无效密文');
  }
  return { id: raw.id, ciphertext: raw.ciphertext, nonce: raw.nonce, cryptoVersion: VAULT_CRYPTO_VERSION };
}

export function parseVaultBackup(source) {
  let raw;
  try { raw = typeof source === 'string' ? JSON.parse(source) : source; } catch { throw new Error('无法读取加密备份文件'); }
  if (!raw || raw.format !== 'diary-encrypted-vault' || raw.version !== VAULT_BACKUP_VERSION || !Array.isArray(raw.items) || raw.items.length > 10000) {
    throw new Error('这不是受支持的密码本加密备份');
  }
  const config = validateEncryptedConfig(raw.config), items = raw.items.map(validateEncryptedRecord);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('加密备份包含重复的账号记录');
  return { config, items };
}

export function validateVaultPassword(password) {
  if (typeof password !== 'string' || [...password].length < 12 || [...password].length > 128 || encoder.encode(password).length > 512) {
    throw new Error('保险库密码需为 12–128 个字符');
  }
  return password;
}

export function validateVaultItem(raw) {
  if (!raw || !['app', 'website'].includes(raw.type)) throw new Error('请选择 App 账号或网站账号');
  const text = (value, name, max, { required = false, trim = true } = {}) => {
    if (typeof value !== 'string') throw new Error(`${name}格式无效`);
    const normalized = trim ? value.trim() : value;
    if (required && !normalized) throw new Error(`请填写${name}`);
    if ([...normalized].length > max) throw new Error(`${name}内容过长`);
    return normalized;
  };
  if (raw.tags != null && !Array.isArray(raw.tags)) throw new Error('账号标签格式无效');
  const tags = [], seenTags = new Set();
  for (const value of raw.tags ?? []) {
    const tag = text(value, '账号标签', 30).normalize('NFKC');
    if (!tag) continue;
    const normalized = tag.toLocaleLowerCase();
    if (!seenTags.has(normalized)) { seenTags.add(normalized); tags.push(tag); }
    if (tags.length > 20) throw new Error('每条账号最多保存 20 个标签');
  }
  const item = {
    type: raw.type,
    serviceName: text(raw.serviceName, '应用或网站名称', 120, { required: true }),
    username: text(raw.username, '登录账号', 300, { required: true, trim: false }),
    password: text(raw.password, '密码', 2000, { required: true, trim: false }),
    loginUrl: text(raw.loginUrl ?? '', '登录地址', 2048),
    appIdentifier: text(raw.appIdentifier ?? '', 'App 标识', 300),
    note: text(raw.note ?? '', '备注', 5000, { trim: false }),
    tags,
    favorite: Boolean(raw.favorite),
  };
  if (raw.otpSecret) {
    item.otpSecret = decodeBase32(text(raw.otpSecret, '动态验证码密钥', 256, { trim: false })).normalized;
    item.otpDigits = Number(raw.otpDigits ?? 6); item.otpPeriod = Number(raw.otpPeriod ?? 30);
    if (![6, 8].includes(item.otpDigits)) throw new Error('动态验证码位数无效');
    if (![30, 60].includes(item.otpPeriod)) throw new Error('动态验证码周期无效');
  }
  if (item.type === 'website' && item.loginUrl) {
    try { if (!['https:', 'http:'].includes(new URL(item.loginUrl).protocol)) throw new Error(); }
    catch { throw new Error('登录地址必须是有效的 HTTP 或 HTTPS 地址'); }
  }
  return item;
}

async function wrappingKey(password, salt, kdf = VAULT_KDF) {
  validateVaultPassword(password);
  if (kdf?.algorithm !== 'argon2id' || kdf.memoryKiB < 19456 || kdf.iterations < 2 || kdf.parallelism < 1 || kdf.hashLength !== 32) throw new Error('保险库密钥参数不受支持');
  const bytes = await argon2id({ password, salt, parallelism: kdf.parallelism, iterations: kdf.iterations,
    memorySize: kdf.memoryKiB, hashLength: kdf.hashLength, outputType: 'binary' });
  try { return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { bytes.fill(0); }
}

export async function createVaultConfig(password) {
  const salt = randomBytes(16), wrapNonce = randomBytes(12), dataKeyBytes = randomBytes(32);
  try {
    const wrapKey = await wrappingKey(password, salt);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce, additionalData: encoder.encode('diary-vault-config:v1') }, wrapKey, dataKeyBytes);
    const recovery = await recoveryWrap(dataKeyBytes);
    const dataKey = await crypto.subtle.importKey('raw', dataKeyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { dataKey, config: { cryptoVersion: VAULT_CRYPTO_VERSION, kdf: { ...VAULT_KDF }, salt: encoded(salt),
      wrappedKey: encoded(new Uint8Array(wrapped)), wrapNonce: encoded(wrapNonce), recoveryWrappedKey: recovery.recoveryWrappedKey,
      recoveryNonce: recovery.recoveryNonce, recoveryVersion: recovery.recoveryVersion, revision: '0', localRevision: 0,
      createdAt: new Date().toISOString() }, recoveryKey: recovery.recoveryKey };
  } finally { dataKeyBytes.fill(0); }
}

export async function unlockVault(config, password) {
  try {
    const raw = await unwrapVaultKey(config, password);
    try {
      return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    } finally { raw.fill(0); }
  } catch { throw new Error('保险库密码错误或加密数据已损坏'); }
}

async function unwrapVaultKey(config, password) {
  if (config?.cryptoVersion !== VAULT_CRYPTO_VERSION) throw new Error();
  const wrapKey = await wrappingKey(password, decoded(config.salt), config.kdf);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decoded(config.wrapNonce),
    additionalData: encoder.encode('diary-vault-config:v1') }, wrapKey, decoded(config.wrappedKey)));
  if (raw.byteLength !== 32) { raw.fill(0); throw new Error(); }
  return raw;
}

export async function changeVaultPassword(config, currentPassword, newPassword) {
  validateVaultPassword(newPassword);
  let raw;
  try {
    raw = await unwrapVaultKey(config, currentPassword);
    const salt = randomBytes(16), wrapNonce = randomBytes(12), wrapKey = await wrappingKey(newPassword, salt);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce, additionalData: encoder.encode('diary-vault-config:v1') }, wrapKey, raw);
    return { ...config, kdf: { ...VAULT_KDF }, salt: encoded(salt), wrappedKey: encoded(new Uint8Array(wrapped)), wrapNonce: encoded(wrapNonce),
      cryptoVersion: VAULT_CRYPTO_VERSION, updatedAt: new Date().toISOString() };
  } catch { throw new Error('当前保险库密码错误或加密数据已损坏'); }
  finally { raw?.fill(0); }
}

export async function rotateVaultRecoveryKey(config, currentPassword) {
  let raw;
  try {
    raw = await unwrapVaultKey(config, currentPassword);
    const recovery = await recoveryWrap(raw);
    return { config: { ...config, recoveryWrappedKey: recovery.recoveryWrappedKey, recoveryNonce: recovery.recoveryNonce,
      recoveryVersion: recovery.recoveryVersion, updatedAt: new Date().toISOString() }, recoveryKey: recovery.recoveryKey };
  } catch { throw new Error('保险库密码错误或加密数据已损坏'); }
  finally { raw?.fill(0); }
}

export async function recoverVault(config, recoveryKey, newPassword) {
  validateVaultPassword(newPassword);
  if (config?.recoveryVersion !== VAULT_RECOVERY_VERSION) throw new Error('这个密码本还没有可用的恢复密钥');
  let secret, raw;
  try {
    secret = parseRecoveryKey(recoveryKey);
    const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt']);
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decoded(config.recoveryNonce),
      additionalData: encoder.encode('diary-vault-recovery:v1') }, key, decoded(config.recoveryWrappedKey)));
    if (raw.byteLength !== 32) throw new Error();
    const salt = randomBytes(16), wrapNonce = randomBytes(12), wrapKey = await wrappingKey(newPassword, salt);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce,
      additionalData: encoder.encode('diary-vault-config:v1') }, wrapKey, raw);
    const recovery = await recoveryWrap(raw);
    const dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { dataKey, recoveryKey: recovery.recoveryKey, config: { ...config, kdf: { ...VAULT_KDF }, salt: encoded(salt),
      wrappedKey: encoded(new Uint8Array(wrapped)), wrapNonce: encoded(wrapNonce), recoveryWrappedKey: recovery.recoveryWrappedKey,
      recoveryNonce: recovery.recoveryNonce, recoveryVersion: recovery.recoveryVersion, cryptoVersion: VAULT_CRYPTO_VERSION,
      updatedAt: new Date().toISOString() } };
  } catch (error) {
    if (['保险库密码需为 12–128 个字符', '恢复密钥格式无效'].includes(error?.message)) throw error;
    throw new Error('恢复密钥错误或加密数据已损坏');
  } finally { secret?.fill(0); raw?.fill(0); }
}

export async function rotateVaultDataKey(config, currentPassword, records) {
  if (!Array.isArray(records) || records.length > 10000) throw new Error('密码本账号记录数量无效');
  const ids = records.map((record) => record?.id);
  if (new Set(ids).size !== records.length) throw new Error('密码本包含重复账号记录，不能轮换密钥');
  const oldKey = await unlockVault(config, currentPassword);
  const plaintextItems = [];
  try {
    for (const record of records) plaintextItems.push(await decryptVaultItem(oldKey, validateEncryptedRecord(record)));
    const created = await createVaultConfig(currentPassword), encryptedItems = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index], encrypted = await encryptVaultItem(created.dataKey, record.id, plaintextItems[index]);
      encryptedItems.push({ ...structuredClone(record), ...encrypted });
    }
    return { dataKey: created.dataKey, recoveryKey: created.recoveryKey,
      config: { ...structuredClone(config), ...created.config, revision: config.revision, localRevision: config.localRevision,
        createdAt: config.createdAt, updatedAt: new Date().toISOString() }, items: encryptedItems };
  } catch (error) {
    if (error?.message === '这条账号记录无法解密，可能已损坏') throw new Error('存在无法解密的账号记录，未轮换任何密钥');
    throw error;
  } finally {
    for (const item of plaintextItems) {
      if (item && typeof item === 'object') for (const key of Object.keys(item)) if (typeof item[key] === 'string') item[key] = '';
    }
  }
}

export async function encryptVaultItem(dataKey, id, raw) {
  const item = validateVaultItem(raw), nonce = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify(item));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`diary-vault-item:v1:${id}`) }, dataKey, plaintext);
    return { ciphertext: encoded(new Uint8Array(ciphertext)), nonce: encoded(nonce), cryptoVersion: VAULT_CRYPTO_VERSION };
  } finally { plaintext.fill(0); }
}

export async function decryptVaultItem(dataKey, record) {
  try {
    if (record?.cryptoVersion !== VAULT_CRYPTO_VERSION) throw new Error();
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decoded(record.nonce),
      additionalData: encoder.encode(`diary-vault-item:v1:${record.id}`) }, dataKey, decoded(record.ciphertext)));
    try { return validateVaultItem(JSON.parse(decoder.decode(plaintext))); }
    finally { plaintext.fill(0); }
  } catch { throw new Error('这条账号记录无法解密，可能已损坏'); }
}

export function createVaultController(store, { lockAfterMs = 5 * 60 * 1000, sync = null } = {}) {
  let dataKey = null, timer = null, destroyed = false;
  let pendingDataKeyRotation = null;
  const documentTarget = globalThis.document;
  const listeners = new Set(), sensitiveViews = new Set();
  const lock = ({ preserveDataKeyRotation = false } = {}) => {
    const changed = Boolean(dataKey); dataKey = null; clearTimeout(timer); timer = null;
    if (!preserveDataKeyRotation) pendingDataKeyRotation = null;
    for (const view of sensitiveViews) { clearTimeout(view.timer); try { view.hide(); } catch { /* Concealment must not prevent locking. */ } }
    sensitiveViews.clear();
    if (changed) for (const listener of listeners) listener();
  };
  const touch = () => {
    if (!dataKey || destroyed) return;
    clearTimeout(timer); timer = setTimeout(lock, lockAfterMs);
  };
  const visibility = () => { if (documentTarget?.visibilityState === 'hidden') lock(); };
  documentTarget?.addEventListener('visibilitychange', visibility);
  const requireKey = () => { if (!dataKey) throw new Error('请先解锁密码本'); touch(); return dataKey; };
  return {
    get unlocked() { return Boolean(dataKey); },
    get dataKeyRotationAvailable() { return Boolean(sync); },
    async config() {
      const rotation = await store.getVaultKeyRotationJob?.();
      if (rotation?.status === 'rotation-prepared' && !pendingDataKeyRotation) await store.cancelPreparedVaultKeyRotation();
      return store.getVaultConfig();
    },
    async initialize(password) {
      if (await store.getVaultConfig()) throw new Error('密码本已经创建');
      const created = await createVaultConfig(password); await store.saveVaultConfig(created.config, '0');
      dataKey = created.dataKey; touch(); return created.recoveryKey;
    },
    async unlock(password) { dataKey = await unlockVault(await store.getVaultConfig(), password); touch(); },
    lock,
    async list() {
      const key = requireKey(), records = await store.listVaultItems();
      return Promise.all(records.map(async (record) => {
        try { return { record, item: await decryptVaultItem(key, record), error: null }; }
        catch (error) { return { record, item: null, error: error.message }; }
      }));
    },
    async get(id) { const key = requireKey(), record = await store.getVaultItem(id); return record ? { record, item: await decryptVaultItem(key, record) } : undefined; },
    async save(raw, existing = null) {
      const key = requireKey(), id = existing?.id ?? crypto.randomUUID(), encrypted = await encryptVaultItem(key, id, raw);
      return store.saveVaultItem({ id, ...encrypted }, existing?.localRevision ?? 0);
    },
    async remove(record) { requireKey(); await store.deleteVaultItem(record.id, record.localRevision); },
    async changePassword(currentPassword, newPassword) {
      requireKey(); const config = await store.getVaultConfig();
      await store.saveVaultConfig(await changeVaultPassword(config, currentPassword, newPassword), String(config.localRevision ?? 0));
      touch();
    },
    async rotateRecoveryKey(currentPassword) {
      requireKey(); const config = await store.getVaultConfig(), rotated = await rotateVaultRecoveryKey(config, currentPassword);
      await store.saveVaultConfig(rotated.config, String(config.localRevision ?? 0)); touch(); return rotated.recoveryKey;
    },
    async prepareDataKeyRotation(currentPassword) {
      requireKey();
      if (pendingDataKeyRotation) throw new Error('已经有一项数据密钥轮换等待确认');
      if (sync) await sync.run();
      const summary = await (sync?.summary() ?? store.vaultSyncSummary());
      if (summary.waiting || summary.conflicts || summary.rotationPrepared) throw new Error('请先完成密码本同步并处理冲突，再轮换数据密钥');
      const config = await store.getVaultConfig(), records = await store.listAllVaultItems();
      const rotated = await rotateVaultDataKey(config, currentPassword, records);
      await store.prepareVaultKeyRotation(rotated.config, rotated.items);
      pendingDataKeyRotation = { dataKey: rotated.dataKey, recoveryKey: rotated.recoveryKey };
      touch(); return rotated.recoveryKey;
    },
    async cancelDataKeyRotation() {
      if (!pendingDataKeyRotation) throw new Error('没有等待确认的数据密钥轮换');
      await store.cancelPreparedVaultKeyRotation(); pendingDataKeyRotation = null; touch();
    },
    async confirmDataKeyRotation() {
      requireKey();
      if (!pendingDataKeyRotation) throw new Error('新的恢复密钥不在当前运行内存中，不能开始轮换');
      const nextKey = pendingDataKeyRotation.dataKey;
      await store.activateVaultKeyRotation(); lock({ preserveDataKeyRotation: true });
      try {
        if (!sync) throw new Error('当前空间没有可用的密码本云同步，不能原子轮换数据密钥');
        await sync.run(); dataKey = nextKey; pendingDataKeyRotation = null; touch();
      } catch (error) {
        pendingDataKeyRotation = null;
        throw new Error(`数据密钥轮换已进入安全重试队列：${error.message}`);
      }
    },
    async recover(recoveryKey, newPassword) {
      const config = await store.getVaultConfig(), recovered = await recoverVault(config, recoveryKey, newPassword);
      await store.saveVaultConfig(recovered.config, String(config.localRevision ?? 0)); dataKey = recovered.dataKey; touch();
      return recovered.recoveryKey;
    },
    async exportEncrypted(password) {
      const key = requireKey(), config = validateEncryptedConfig(await store.getVaultConfig());
      await unlockVault(config, password);
      const records = await store.listVaultItems();
      for (const record of records) await decryptVaultItem(key, validateEncryptedRecord(record));
      touch();
      return JSON.stringify({ format: 'diary-encrypted-vault', version: VAULT_BACKUP_VERSION, exportedAt: new Date().toISOString(), config,
        items: records.map(validateEncryptedRecord) }, null, 2);
    },
    async importEncrypted(source, password) {
      if (await store.getVaultConfig()) throw new Error('当前空间已经有密码本，不能用备份覆盖');
      const backup = parseVaultBackup(source), key = await unlockVault(backup.config, password);
      for (const record of backup.items) await decryptVaultItem(key, record);
      await store.importVaultBackup(backup.config, backup.items);
      dataKey = key; touch();
      return backup.items.length;
    },
    async conflicts() {
      const key = requireKey(), jobs = await store.listVaultConflicts();
      return Promise.all(jobs.map(async (job) => ({ ...job,
        localItem: job.local?.ciphertext ? await decryptVaultItem(key, job.local) : null,
        remoteItem: job.remote?.ciphertext && !job.remote.deletedAt ? await decryptVaultItem(key, job.remote) : null })));
    },
    async resolveConflict(jobId, choice) { requireKey(); await store.resolveVaultConflict(jobId, choice); return sync?.run() ?? store.vaultSyncSummary(); },
    protectSensitive(hide, afterMs = 30000) {
      requireKey();
      if (typeof hide !== 'function' || !Number.isFinite(afterMs) || afterMs < 1 || afterMs > 60000) throw new Error('敏感内容遮挡设置无效');
      const view = { hide, timer: null };
      view.timer = setTimeout(() => { sensitiveViews.delete(view); hide(); }, afterMs);
      sensitiveViews.add(view);
      return () => { clearTimeout(view.timer); sensitiveViews.delete(view); };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    sync: () => sync?.run() ?? store.vaultSyncSummary(),
    syncSummary: () => sync?.summary() ?? store.vaultSyncSummary(),
    destroy() { destroyed = true; lock(); listeners.clear(); documentTarget?.removeEventListener('visibilitychange', visibility); },
  };
}
