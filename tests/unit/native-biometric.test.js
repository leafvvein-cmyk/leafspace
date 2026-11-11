import { describe, expect, it, vi } from 'vitest';
import { createNativeBiometric } from '../../apps/client/src/services/native-biometric.js';

const available = { isAvailable: true, strongBiometryIsAvailable: true, biometryType: 2, biometryTypes: [2], deviceIsSecure: true, reason: '', code: '' };

describe('native biometric unlock', () => {
  it('checks the native plugin and describes Face ID with device credential fallback', async () => {
    const plugin = { checkBiometry: vi.fn(async () => available), authenticate: vi.fn(async () => {}) };
    const requirePlugin = vi.fn(), service = await createNativeBiometric({ plugin, requirePlugin });
    expect(requirePlugin).toHaveBeenCalledWith('BiometricAuthNative');
    await expect(service.status()).resolves.toMatchObject({ available: true, biometryAvailable: true, label: 'Face ID 或设备凭据' });
  });
  it('uses a private diary reason and allows the operating-system credential fallback', async () => {
    const plugin = { checkBiometry: vi.fn(async () => available), authenticate: vi.fn(async () => {}) };
    const service = await createNativeBiometric({ plugin, requirePlugin: () => {} });
    await expect(service.authenticate()).resolves.toBe(true);
    expect(plugin.authenticate).toHaveBeenCalledWith(expect.objectContaining({ reason: '解锁你的日记', allowDeviceCredential: true }));
  });
  it('treats user cancellation as no unlock and surfaces real failures', async () => {
    const cancelled = { checkBiometry: vi.fn(async () => available), authenticate: vi.fn(async () => { throw Object.assign(new Error('cancel'), { code: 'userCancel' }); }) };
    await expect((await createNativeBiometric({ plugin: cancelled, requirePlugin: () => {} })).authenticate()).resolves.toBe(false);
    const failed = { checkBiometry: vi.fn(async () => available), authenticate: vi.fn(async () => { throw Object.assign(new Error('locked'), { code: 'biometryLockout' }); }) };
    await expect((await createNativeBiometric({ plugin: failed, requirePlugin: () => {} })).authenticate()).rejects.toMatchObject({ code: 'biometryLockout' });
  });
  it('allows a secure device credential even when no biometry is enrolled', async () => {
    const plugin = { checkBiometry: vi.fn(async () => ({ ...available, isAvailable: false, biometryType: 0, deviceIsSecure: true, reason: 'not enrolled' })), authenticate: vi.fn() };
    await expect((await createNativeBiometric({ plugin, requirePlugin: () => {} })).status()).resolves.toMatchObject({ available: true, label: '设备锁屏凭据' });
  });
});
