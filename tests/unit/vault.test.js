import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeVaultHealth, changeVaultPassword, createVaultConfig, createVaultController, decryptVaultItem, encryptVaultItem, generateTotp, generateVaultPassword, parseVaultBackup, recoverVault, rotateVaultDataKey, rotateVaultRecoveryKey, totpRemainingSeconds, unlockVault, validateVaultItem } from '../../apps/client/src/services/vault-crypto.js';
import { createLocalStore } from '../../apps/client/src/services/local-store.js';
import { createSqliteStore, SQLITE_SCHEMA_VERSION } from '../../apps/client/src/services/sqlite-store.js';

const cleanup = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });

function sqliteBridge() {
  const db = new DatabaseSync(':memory:'); let active = false;
  const connection = {
    raw: db,
    query: async (sql, values = []) => ({ values: db.prepare(sql).all(...values) }),
    execute: async (sql) => { db.exec(sql); return { changes: { changes: 0 } }; },
    run: async (sql, values = []) => ({ changes: { changes: Number(db.prepare(sql).run(...values).changes) } }),
    beginTransaction: async () => { db.exec('BEGIN IMMEDIATE'); active = true; },
    commitTransaction: async () => { db.exec('COMMIT'); active = false; },
    rollbackTransaction: async () => { db.exec('ROLLBACK'); active = false; },
    isTransactionActive: async () => ({ result: active }), close: async () => db.close(),
  };
  cleanup.push(() => connection.close()); return connection;
}

const secretItem = { type: 'website', serviceName: '示例银行', username: 'private@example.com', password: '绝不写入数据库的密码!',
  loginUrl: 'https://example.com/login', appIdentifier: '', note: '私人备注', tags: ['金融', '重要'], favorite: true };

describe('password vault cryptography', () => {
  it('rotates the data key for every encrypted item and issues a new recovery key without changing record identity', async () => {
    const password = 'data-key-rotation-password!', created = await createVaultConfig(password);
    const records = await Promise.all([secretItem, { ...secretItem, serviceName: '第二个网站', username: 'second-user' }].map(async (item, index) => {
      const id = crypto.randomUUID(), encrypted = await encryptVaultItem(created.dataKey, id, item);
      return { id, ...encrypted, revision: String(index + 4), localRevision: index + 2, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), deletedAt: index ? new Date().toISOString() : null };
    }));
    const rotated = await rotateVaultDataKey({ ...created.config, revision: '9', localRevision: 3 }, password, records);
    expect(rotated.config).toMatchObject({ revision: '9', localRevision: 3, recoveryVersion: 1 });
    expect(rotated.recoveryKey).not.toBe(created.recoveryKey);
    expect(rotated.items.map((item) => [item.id, item.revision, item.localRevision, item.deletedAt])).toEqual(
      records.map((item) => [item.id, item.revision, item.localRevision, item.deletedAt]));
    const newKey = await unlockVault(rotated.config, password);
    await expect(decryptVaultItem(created.dataKey, rotated.items[0])).rejects.toThrow('无法解密');
    expect(await decryptVaultItem(newKey, rotated.items[0])).toEqual(secretItem);
    const recovered = await recoverVault(rotated.config, rotated.recoveryKey, 'post-rotation-password!');
    expect(await decryptVaultItem(recovered.dataKey, rotated.items[1])).toMatchObject({ serviceName: '第二个网站' });
    await expect(recoverVault(rotated.config, created.recoveryKey, 'post-rotation-password!')).rejects.toThrow('恢复密钥错误');
  });

  it('refuses data-key rotation before returning any replacement when one ciphertext is damaged', async () => {
    const password = 'damaged-rotation-password!', created = await createVaultConfig(password), id = crypto.randomUUID();
    const encrypted = await encryptVaultItem(created.dataKey, id, secretItem);
    await expect(rotateVaultDataKey(created.config, password, [{ id, ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -1)}A` }]))
      .rejects.toThrow('未轮换任何密钥');
  });
  it('generates strong account passwords locally with every required character group', () => {
    const generated = Array.from({ length: 20 }, () => generateVaultPassword());
    expect(new Set(generated).size).toBe(generated.length);
    for (const password of generated) {
      expect(password).toHaveLength(24);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%^&*()\-_+=\[\]{}:,.?]/);
      expect(validateVaultItem({ ...secretItem, password }).password).toBe(password);
    }
    expect(generateVaultPassword(64)).toHaveLength(64);
    expect(() => generateVaultPassword(15)).toThrow('16–128');
  });

  it('generates standards-compatible TOTP codes locally and validates encrypted OTP settings', async () => {
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(await generateTotp(rfcSecret, { now: 59_000, digits: 8, period: 30 })).toBe('94287082');
    expect(await generateTotp(rfcSecret, { now: 1_111_111_109_000, digits: 8, period: 30 })).toBe('07081804');
    expect(totpRemainingSeconds(59_000, 30)).toBe(1);
    expect(validateVaultItem({ ...secretItem, otpSecret: 'gez dgnbv-gy3tqojq', otpDigits: 6, otpPeriod: 30 })).toMatchObject({
      otpSecret: 'GEZDGNBVGY3TQOJQ', otpDigits: 6, otpPeriod: 30,
    });
    expect(() => validateVaultItem({ ...secretItem, otpSecret: 'not-base32!' })).toThrow('Base32');
    await expect(generateTotp('GEZDGNBVGY3TQOJQ', { digits: 7 })).rejects.toThrow('参数无效');
  });

  it('reports weak and reused credentials using opaque record ids only', () => {
    const bundles = [
      { record: { id: 'one' }, item: { password: 'short' } },
      { record: { id: 'two' }, item: { password: 'shared-password-value!' } },
      { record: { id: 'three' }, item: { password: 'shared-password-value!' } },
      { record: { id: 'four' }, item: { password: 'this is a sufficiently long passphrase' } },
    ];
    const result = analyzeVaultHealth(bundles);
    expect([...result.weakIds]).toEqual(['one']);
    expect([...result.reusedIds]).toEqual(['two', 'three']);
    expect([...result.issueIds]).toEqual(['one', 'two', 'three']);
    expect([...result.damagedIds]).toEqual([]);
    expect(JSON.stringify({ weak: [...result.weakIds], reused: [...result.reusedIds] })).not.toContain('shared-password-value');
  });

  it('isolates a damaged encrypted record while keeping other accounts readable', async () => {
    const store = createLocalStore(`vault-damage-${crypto.randomUUID()}`); cleanup.push(() => store.db.delete());
    const password = 'damaged-record-isolation-password!', created = await createVaultConfig(password);
    const goodId = crypto.randomUUID(), badId = crypto.randomUUID();
    const good = await encryptVaultItem(created.dataKey, goodId, secretItem), bad = await encryptVaultItem(created.dataKey, badId, { ...secretItem, serviceName: '损坏前名称' });
    bad.ciphertext = `${bad.ciphertext.slice(0, -1)}${bad.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await store.importVaultBackup(created.config, [{ id: goodId, ...good }, { id: badId, ...bad }]);
    const controller = createVaultController(store); cleanup.push(() => controller.destroy()); await controller.unlock(password);
    const listed = await controller.list();
    expect(listed.find(({ record }) => record.id === goodId)).toMatchObject({ item: secretItem, error: null });
    expect(listed.find(({ record }) => record.id === badId)).toMatchObject({ item: null, error: expect.stringContaining('无法解密') });
    const health = analyzeVaultHealth(listed);
    expect([...health.damagedIds]).toEqual([badId]);
    expect(health.issueIds.has(badId)).toBe(true);
    const conceal = vi.fn(); controller.protectSensitive(conceal); controller.lock();
    expect(conceal).toHaveBeenCalledOnce();
  });

  it('wraps a random data key with Argon2id and detects wrong passwords and ciphertext changes', async () => {
    const password = '独立保险库密码-very-strong';
    const created = await createVaultConfig(password);
    expect(created.config).toMatchObject({ cryptoVersion: 1, kdf: { algorithm: 'argon2id', memoryKiB: 19456, iterations: 2 } });
    expect(JSON.stringify(created.config)).not.toContain(password);
    await expect(unlockVault(created.config, '这是错误的保险库密码')).rejects.toThrow('密码错误');
    const key = await unlockVault(created.config, password), id = crypto.randomUUID();
    const encrypted = await encryptVaultItem(key, id, secretItem);
    expect(JSON.stringify(encrypted)).not.toContain('示例银行');
    expect(await decryptVaultItem(key, { id, ...encrypted })).toEqual(secretItem);
    const changed = `${encrypted.ciphertext.slice(0, -1)}${encrypted.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptVaultItem(key, { id, ...encrypted, ciphertext: changed })).rejects.toThrow('无法解密');
    const rotated = await changeVaultPassword(created.config, password, '更换后的保险库密码-strong!');
    await expect(unlockVault(rotated, password)).rejects.toThrow('密码错误');
    const rotatedKey = await unlockVault(rotated, '更换后的保险库密码-strong!');
    expect(await decryptVaultItem(rotatedKey, { id, ...encrypted })).toEqual(secretItem);
  });

  it('recovers with a one-time displayed key and invalidates old recovery keys after rotation', async () => {
    const password = 'original-vault-password!', created = await createVaultConfig(password), id = crypto.randomUUID();
    expect(created.recoveryKey).toMatch(/^DVK1-(?:[0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    expect(JSON.stringify(created.config)).not.toContain(created.recoveryKey);
    const encrypted = await encryptVaultItem(created.dataKey, id, secretItem);
    await expect(recoverVault(created.config, created.recoveryKey.replace(/[0-9A-F]/, 'Z'), 'new-vault-password!')).rejects.toThrow('格式无效');
    const recovered = await recoverVault(created.config, created.recoveryKey.toLowerCase(), 'new-vault-password!');
    await expect(unlockVault(recovered.config, password)).rejects.toThrow('密码错误');
    expect(await decryptVaultItem(await unlockVault(recovered.config, 'new-vault-password!'), { id, ...encrypted })).toEqual(secretItem);
    await expect(recoverVault(recovered.config, created.recoveryKey, 'another-vault-password!')).rejects.toThrow('恢复密钥错误');
    const rotated = await rotateVaultRecoveryKey(recovered.config, 'new-vault-password!');
    await expect(recoverVault(rotated.config, recovered.recoveryKey, 'another-vault-password!')).rejects.toThrow('恢复密钥错误');
    const final = await recoverVault(rotated.config, rotated.recoveryKey, 'another-vault-password!');
    expect(await decryptVaultItem(final.dataKey, { id, ...encrypted })).toEqual(secretItem);
  });

  it('validates complete app and website account records without trimming passwords', () => {
    expect(validateVaultItem({ ...secretItem, password: ' password with spaces ' }).password).toBe(' password with spaces ');
    expect(validateVaultItem({ ...secretItem, tags: [' 工作 ', '工作', 'WORK', 'work'] }).tags).toEqual(['工作', 'WORK']);
    expect(() => validateVaultItem({ ...secretItem, tags: Array.from({ length: 21 }, (_, index) => `标签${index}`) })).toThrow('20');
    expect(() => validateVaultItem({ ...secretItem, loginUrl: 'javascript:alert(1)' })).toThrow('HTTP');
    expect(() => validateVaultItem({ ...secretItem, username: '' })).toThrow('登录账号');
  });

  it('strictly validates encrypted backup envelopes without exposing plaintext', async () => {
    const created = await createVaultConfig('encrypted-backup-password!'), id = crypto.randomUUID();
    const encrypted = await encryptVaultItem(created.dataKey, id, secretItem);
    const source = JSON.stringify({ format: 'diary-encrypted-vault', version: 1, config: created.config, items: [{ id, ...encrypted }] });
    const parsed = parseVaultBackup(source);
    expect(parsed.items).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain(secretItem.serviceName);
    expect(() => parseVaultBackup(source.slice(0, -1))).toThrow('无法读取');
    expect(() => parseVaultBackup(JSON.stringify({ ...JSON.parse(source), items: [{ id, ...encrypted }, { id, ...encrypted }] }))).toThrow('重复');
  });
});

async function verifyEncryptedStore(store, rawDatabase) {
  const created = await createVaultConfig('vault-storage-password!');
  const config = await store.saveVaultConfig(created.config, '0');
  const id = crypto.randomUUID(), encrypted = await encryptVaultItem(created.dataKey, id, secretItem);
  const record = await store.saveVaultItem({ id, ...encrypted }, 0);
  expect(await store.getVaultConfig()).toMatchObject({ revision: '0', localRevision: 1, cryptoVersion: 1 });
  expect((await store.listVaultItems())[0]).toMatchObject({ id, localRevision: 1, deletedAt: null });
  expect(await decryptVaultItem(created.dataKey, record)).toEqual(secretItem);
  const raw = await rawDatabase();
  expect(raw).not.toContain(secretItem.serviceName);
  expect(raw).not.toContain(secretItem.username);
  expect(raw).not.toContain(secretItem.password);
  expect(JSON.stringify(await store.exportLocal())).not.toContain('vault-storage-password');
  expect(JSON.stringify(await store.exportLocal())).not.toContain(secretItem.serviceName);
  await store.deleteVaultItem(id, record.localRevision);
  expect(await store.listVaultItems()).toEqual([]);
  expect(config).toMatchObject({ revision: '0', localRevision: 1 });
}

async function verifyImmutableVaultQueue(store) {
  const created = await createVaultConfig('immutable-vault-queue-password!');
  await store.saveVaultConfig(created.config, '0');
  const configJob = await store.nextVaultSyncJob();
  expect(configJob).toMatchObject({ id: 'pending:config', itemId: 'config', status: 'pending', payload: { revision: '0', localRevision: 1 } });
  expect(configJob.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  await store.completeVaultSyncJob(configJob.id, { revision: '1', updatedAt: new Date().toISOString() });

  const id = crypto.randomUUID(), firstEncrypted = await encryptVaultItem(created.dataKey, id, secretItem);
  const first = await store.saveVaultItem({ id, ...firstEncrypted }, 0);
  const pending = await store.nextVaultSyncJob();
  expect(pending).toMatchObject({ id: `pending:${id}`, localRevision: 1, payload: { revision: '0', ciphertext: first.ciphertext } });
  const newerEncrypted = await encryptVaultItem(created.dataKey, id, { ...secretItem, note: '请求进行中产生的新修改' });
  const newer = await store.saveVaultItem({ id, ...newerEncrypted }, first.localRevision);
  expect((await store.nextVaultSyncJob()).payload.ciphertext).toBe(first.ciphertext);
  await store.completeVaultSyncJob(pending.id, { revision: '1', updatedAt: new Date().toISOString(), deletedAt: null });
  const next = await store.nextVaultSyncJob();
  expect(next).toMatchObject({ localRevision: newer.localRevision, payload: { revision: '1', ciphertext: newer.ciphertext } });
  expect(next.requestId).not.toBe(pending.requestId);
  await store.completeVaultSyncJob(next.id, { revision: '2', updatedAt: new Date().toISOString(), deletedAt: null });
  expect(await store.vaultSyncSummary()).toEqual({ waiting: 0, conflicts: 0 });

  let current = await store.getVaultItem(id);
  const localThird = await encryptVaultItem(created.dataKey, id, { ...secretItem, note: '本机冲突版本' });
  await store.saveVaultItem({ id, ...localThird }, current.localRevision);
  const cloudThird = { id, ...await encryptVaultItem(created.dataKey, id, { ...secretItem, note: '云端冲突版本' }), revision: '3',
    createdAt: current.createdAt, updatedAt: new Date().toISOString(), deletedAt: null };
  await store.applyVaultCloudItems([cloudThird]);
  expect(await store.vaultSyncSummary()).toMatchObject({ conflicts: 1 });
  const conflict = (await store.listVaultConflicts())[0];
  expect(conflict).toMatchObject({ itemId: id, remote: { revision: '3' } });
  await store.resolveVaultConflict(conflict.id, 'cloud');
  expect((await store.getVaultItem(id)).ciphertext).toBe(cloudThird.ciphertext);

  current = await store.getVaultItem(id);
  const localFourth = await encryptVaultItem(created.dataKey, id, { ...secretItem, note: '明确保留本机' });
  const localRecord = await store.saveVaultItem({ id, ...localFourth }, current.localRevision);
  const cloudFourth = { id, ...await encryptVaultItem(created.dataKey, id, { ...secretItem, note: '另一云端版本' }), revision: '4',
    createdAt: current.createdAt, updatedAt: new Date().toISOString(), deletedAt: null };
  await store.applyVaultCloudItems([cloudFourth]);
  const secondConflict = (await store.listVaultConflicts())[0];
  await store.resolveVaultConflict(secondConflict.id, 'local');
  const retry = await store.nextVaultSyncJob();
  expect(retry).toMatchObject({ itemId: id, payload: { revision: '4', ciphertext: localRecord.ciphertext } });
}

async function verifyEncryptedBackupImport(store) {
  const password = 'portable-encrypted-backup-password!', created = await createVaultConfig(password), id = crypto.randomUUID();
  const encrypted = await encryptVaultItem(created.dataKey, id, secretItem);
  await store.importVaultBackup(created.config, [{ id, ...encrypted }]);
  const config = await store.getVaultConfig(), record = await store.getVaultItem(id);
  expect(await decryptVaultItem(await unlockVault(config, password), record)).toEqual(secretItem);
  expect(await store.vaultSyncSummary()).toEqual({ waiting: 2, conflicts: 0 });
  await expect(store.importVaultBackup(created.config, [])).rejects.toThrow('已经有密码本');
}

async function verifyVaultRotationJournal(store) {
  const password = 'persistent-rotation-password!', created = await createVaultConfig(password);
  await store.saveVaultConfig(created.config, '0');
  let job = await store.nextVaultSyncJob(); await store.completeVaultSyncJob(job.id, { revision: '1', updatedAt: new Date().toISOString() });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (let index = 0; index < ids.length; index += 1) {
    const encrypted = await encryptVaultItem(created.dataKey, ids[index], { ...secretItem, serviceName: `轮换账号${index + 1}` });
    await store.saveVaultItem({ id: ids[index], ...encrypted }, 0); job = await store.nextVaultSyncJob();
    await store.completeVaultSyncJob(job.id, { revision: '1', updatedAt: new Date().toISOString(), deletedAt: null });
  }
  const removed = await store.getVaultItem(ids[1]); await store.deleteVaultItem(ids[1], removed.localRevision); job = await store.nextVaultSyncJob();
  await store.completeVaultSyncJob(job.id, { revision: '2', updatedAt: new Date().toISOString(), deletedAt: new Date().toISOString() });

  const config = await store.getVaultConfig(), records = await store.listAllVaultItems(), rotated = await rotateVaultDataKey(config, password, records);
  await store.prepareVaultKeyRotation(rotated.config, rotated.items);
  expect(await store.vaultSyncSummary()).toEqual({ waiting: 0, conflicts: 0, rotationPrepared: true });
  await expect(store.saveVaultItem(rotated.items[0], records[0].localRevision)).rejects.toThrow('正在轮换');
  await store.cancelPreparedVaultKeyRotation(); expect(await store.getVaultKeyRotationJob()).toBeNull();

  await store.prepareVaultKeyRotation(rotated.config, rotated.items); const ready = await store.activateVaultKeyRotation();
  expect(ready).toMatchObject({ status: 'rotation-ready', baseConfigRevision: '1', rotationId: null });
  expect(ready.startRequestId).toMatch(/^[0-9a-f-]{36}$/i); expect(ready.commitRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(ready.batchRequestIds).toHaveLength(1); expect(await store.vaultSyncSummary()).toEqual({ waiting: 1, conflicts: 0 });
  const rotationId = crypto.randomUUID(); await store.bindVaultKeyRotation(rotationId);
  const updatedAt = new Date().toISOString(), remoteItems = rotated.items.map((item) => ({ ...item,
    revision: String(BigInt(item.revision) + 1n), updatedAt, deletedAt: item.deletedAt }));
  await store.completeVaultKeyRotation({ rotation: { id: rotationId }, config: { revision: '2', updatedAt }, items: remoteItems });
  expect(await store.getVaultKeyRotationJob()).toBeNull(); expect(await store.vaultSyncSummary()).toEqual({ waiting: 0, conflicts: 0 });
  expect(await store.getVaultConfig()).toMatchObject({ revision: '2', localRevision: config.localRevision + 1 });
  const saved = await store.listAllVaultItems(); expect(saved).toHaveLength(2); expect(saved.filter((item) => item.deletedAt)).toHaveLength(1);
  expect(await decryptVaultItem(await unlockVault(await store.getVaultConfig(), password), saved.find((item) => item.id === ids[0])))
    .toMatchObject({ serviceName: '轮换账号1' });
}

describe('encrypted vault repositories', () => {
  it('stores only ciphertext in IndexedDB and excludes the vault from ordinary backup', async () => {
    const store = createLocalStore(`vault-test-${crypto.randomUUID()}`); cleanup.push(() => store.db.delete());
    await verifyEncryptedStore(store, async () => JSON.stringify({ config: await store.db.vaultConfig.toArray(), items: await store.db.vaultItems.toArray() }));
    const rows = await store.db.vaultItems.toArray(); expect(JSON.stringify(rows)).not.toContain(secretItem.password);
  });

  it('freezes IndexedDB uploads so an edit cannot replace an in-flight ciphertext request', async () => {
    const store = createLocalStore(`vault-queue-${crypto.randomUUID()}`); cleanup.push(() => store.db.delete());
    await verifyImmutableVaultQueue(store);
  });

  it('atomically imports an encrypted backup into an empty IndexedDB vault', async () => {
    const store = createLocalStore(`vault-import-${crypto.randomUUID()}`); cleanup.push(() => store.db.delete());
    await verifyEncryptedBackupImport(store);
  });

  it('persists and atomically commits an acknowledged IndexedDB data-key rotation journal', async () => {
    const store = createLocalStore(`vault-rotation-${crypto.randomUUID()}`); cleanup.push(() => store.db.delete());
    await verifyVaultRotationJournal(store);
  });

  it('stores only ciphertext in the SQLite v4 schema', async () => {
    const connection = sqliteBridge(), store = await createSqliteStore(connection, `vault-test-${crypto.randomUUID()}`);
    await verifyEncryptedStore(store, () => connection.raw.prepare('SELECT group_concat(payload) AS payload FROM vault_items').get().payload ?? '');
    expect(SQLITE_SCHEMA_VERSION).toBe(4);
    expect(connection.raw.prepare('PRAGMA user_version').get().user_version).toBe(4);
  });

  it('freezes SQLite uploads so an edit cannot replace an in-flight ciphertext request', async () => {
    const connection = sqliteBridge(), store = await createSqliteStore(connection, `vault-queue-${crypto.randomUUID()}`);
    await verifyImmutableVaultQueue(store);
  });

  it('atomically imports an encrypted backup into an empty SQLite vault', async () => {
    const connection = sqliteBridge(), store = await createSqliteStore(connection, `vault-import-${crypto.randomUUID()}`);
    await verifyEncryptedBackupImport(store);
  });

  it('persists and atomically commits an acknowledged SQLite data-key rotation journal', async () => {
    const connection = sqliteBridge(), store = await createSqliteStore(connection, `vault-rotation-${crypto.randomUUID()}`);
    await verifyVaultRotationJournal(store);
  });
});
