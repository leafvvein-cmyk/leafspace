import { describe, it, expect, vi } from 'vitest';
import { nativeSessionStore } from '../../apps/client/src/services/secure-session-store.js';
import { requireNativePlugin } from '../../apps/client/src/services/platform.js';
import { nativeDatabaseName } from '../../apps/client/src/services/native-store.js';
import { ensureNativeDatabaseSecret } from '../../apps/client/src/services/native-encryption.js';

describe('native platform boundaries', () => {
  it('never stores credentials through the plaintext Web secure-storage shim', async () => {
    await expect(nativeSessionStore.read()).rejects.toThrow('仅在安装');
    await expect(nativeSessionStore.write({ userId: 'a', refreshToken: 'test' })).rejects.toThrow('仅在安装');
    await expect(nativeSessionStore.clear()).rejects.toThrow('仅在安装');
    expect(() => requireNativePlugin('CapacitorSQLite')).toThrow('仅在安装');
  });
  it('maps namespaces deterministically to safe distinct SQLite filenames', async () => {
    const learning = await nativeDatabaseName('learning');
    expect(learning).toMatch(/^diary_v2_[a-f0-9]{64}$/);
    expect(await nativeDatabaseName('learning')).toBe(learning);
    expect(await nativeDatabaseName('../学习🙂')).not.toBe(learning);
    await expect(nativeDatabaseName('')).rejects.toThrow('无效');
  });
});

describe('native encryption first-install and missing-key boundaries', () => {
  function manager() { return { isSecretStored: vi.fn(async () => ({ result: false })), getDatabaseList: vi.fn(async () => ({ values: [] })), setEncryptionSecret: vi.fn(async () => {}) }; }
  it('handles the actual Android empty-database error and generates a fresh secret', async () => {
    const first = manager(), second = manager();
    first.getDatabaseList.mockRejectedValue(new Error('getDatabaseList: No databases available '));
    await ensureNativeDatabaseSecret(first); await ensureNativeDatabaseSecret(second);
    const a = first.setEncryptionSecret.mock.calls[0][0], b = second.setEncryptionSecret.mock.calls[0][0];
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(a).not.toBe(b);
  });
  it('does not replace a stored secret', async () => {
    const target = manager(); target.isSecretStored.mockResolvedValue({ result: true });
    await ensureNativeDatabaseSecret(target);
    expect(target.getDatabaseList).not.toHaveBeenCalled(); expect(target.setEncryptionSecret).not.toHaveBeenCalled();
  });
  it('refuses to manufacture a key for an existing database', async () => {
    const target = manager(); target.getDatabaseList.mockResolvedValue({ values: ['diarySQLite.db'] });
    await expect(ensureNativeDatabaseSecret(target)).rejects.toThrow('已有手机数据库');
    expect(target.setEncryptionSecret).not.toHaveBeenCalled();
  });
  it('propagates unknown native storage errors without creating a replacement key', async () => {
    const target = manager(); target.getDatabaseList.mockRejectedValue(new Error('getDatabaseList: permission denied'));
    await expect(ensureNativeDatabaseSecret(target)).rejects.toThrow('permission denied');
    expect(target.setEncryptionSecret).not.toHaveBeenCalled();
  });
});
