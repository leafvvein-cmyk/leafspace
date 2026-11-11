import { beforeEach, describe, it, expect, vi } from 'vitest';

const fake = vi.hoisted(() => ({ manager: {}, repository: vi.fn(), secret: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true } }));
vi.mock('@capacitor-community/sqlite', () => ({ CapacitorSQLite: {}, SQLiteConnection: class { constructor() { return fake.manager; } } }));
vi.mock('../../apps/client/src/services/sqlite-store.js', () => ({ SQLITE_SCHEMA_VERSION: 1, createSqliteStore: fake.repository }));
vi.mock('../../apps/client/src/services/native-encryption.js', () => ({ ensureNativeDatabaseSecret: fake.secret }));

beforeEach(() => {
  vi.resetModules();
  fake.secret.mockReset().mockResolvedValue(undefined);
  fake.repository.mockReset().mockImplementation(async (connection, namespace, options) => ({ namespace, close: options.closeConnection }));
  const connections = new Map();
  fake.manager = {
    checkConnectionsConsistency: vi.fn(async () => ({ result: true })),
    isConnection: vi.fn(async (name) => ({ result: connections.has(name) })),
    createConnection: vi.fn(async (name) => { const connection = { open: vi.fn(async () => {}) }; connections.set(name, connection); return connection; }),
    retrieveConnection: vi.fn(async (name) => connections.get(name)),
    closeConnection: vi.fn(async (name) => connections.delete(name)),
  };
});

describe('native connection lifecycle orchestration (mock plugin contract)', () => {
  it('reuses one opening per namespace and asks the real adapter for encryption', async () => {
    const { openNativeStore } = await import('../../apps/client/src/services/native-store.js');
    const first = openNativeStore('learning'), second = openNativeStore('learning');
    expect(first).toBe(second);
    expect(await first).toBe(await second);
    expect(fake.manager.createConnection).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^diary_v2_/), true, 'secret', 1, false);
  });
  it('retries after a transient secret initialization error', async () => {
    fake.secret.mockRejectedValueOnce(new Error('keychain locked'));
    const { openNativeStore } = await import('../../apps/client/src/services/native-store.js');
    await expect(openNativeStore('learning')).rejects.toThrow('keychain locked');
    expect((await openNativeStore('learning')).namespace).toBe('learning');
    expect(fake.secret).toHaveBeenCalledTimes(2);
  });
  it('closes only the failed connection and retries without deleting disk data', async () => {
    fake.repository.mockRejectedValueOnce(new Error('temporarily busy'));
    const { openNativeStore } = await import('../../apps/client/src/services/native-store.js');
    await expect(openNativeStore('learning')).rejects.toThrow('temporarily busy');
    expect(fake.manager.closeConnection).toHaveBeenCalledTimes(1);
    expect((await openNativeStore('learning')).namespace).toBe('learning');
    expect(fake.manager.createConnection).toHaveBeenCalledTimes(2);
  });
  it('does not blindly reuse a connection when closing it failed', async () => {
    fake.repository.mockRejectedValueOnce(new Error('transaction error'));
    fake.manager.closeConnection.mockRejectedValueOnce(new Error('close error'));
    const { openNativeStore } = await import('../../apps/client/src/services/native-store.js');
    await expect(openNativeStore('learning')).rejects.toThrow('重新打开 App');
    await expect(openNativeStore('learning')).rejects.toThrow('重新打开 App');
    expect(fake.manager.createConnection).toHaveBeenCalledTimes(1);
  });
  it('can reopen an intentionally closed namespace', async () => {
    const { openNativeStore } = await import('../../apps/client/src/services/native-store.js');
    const first = await openNativeStore('learning');
    await first.close();
    expect(await openNativeStore('learning')).not.toBe(first);
    expect(fake.manager.createConnection).toHaveBeenCalledTimes(2);
  });
});
