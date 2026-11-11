import { describe, expect, it, vi } from 'vitest';
import { configuredNativeAppActions, createNativeAppActionLauncher, validateNativeAppActionRegistry } from '../../apps/client/src/services/native-app-actions.js';

const registry = {
  'approved.open': { label: '打开已批准应用', android: 'com.example.approved', ios: 'approved-app://open/fixed' },
  'android.only': { label: '仅 Android', android: 'com.example.android' },
};

describe('native app action allowlist', () => {
  it('publishes stable ids without exposing arbitrary user-entered targets', () => {
    expect(configuredNativeAppActions(registry)).toEqual([
      { id: 'approved.open', label: '打开已批准应用', platforms: ['android', 'ios'] },
      { id: 'android.only', label: '仅 Android', platforms: ['android'] },
    ]);
    expect(() => validateNativeAppActionRegistry({ unsafe: { label: '危险', ios: 'javascript:alert(1)' } })).toThrow('安全 URL scheme');
    expect(() => validateNativeAppActionRegistry({ unsafe: { label: '危险', android: 'not a package' } })).toThrow('配置无效');
  });

  it('checks installation before launching a fixed platform target and reports failures', async () => {
    const plugin = { canOpenUrl: vi.fn().mockResolvedValue({ value: true }), openUrl: vi.fn().mockResolvedValue({ completed: true }) };
    const launch = createNativeAppActionLauncher({ native: true, currentPlatform: 'android', registry, plugin, ensurePlugin: vi.fn() });
    await expect(launch('approved.open')).resolves.toMatchObject({ completed: true });
    expect(plugin.canOpenUrl).toHaveBeenCalledWith({ url: 'com.example.approved' });
    expect(plugin.openUrl).toHaveBeenCalledWith({ url: 'com.example.approved' });
  });

  it('rejects web, unknown, unavailable and unsupported-platform actions', async () => {
    const plugin = { canOpenUrl: vi.fn().mockResolvedValue({ value: false }), openUrl: vi.fn() };
    await expect(createNativeAppActionLauncher({ native: false, currentPlatform: 'web', registry, plugin })('approved.open')).rejects.toThrow('手机 App');
    await expect(createNativeAppActionLauncher({ native: true, currentPlatform: 'ios', registry, plugin, ensurePlugin: vi.fn() })('android.only')).rejects.toThrow('当前平台');
  });
});
