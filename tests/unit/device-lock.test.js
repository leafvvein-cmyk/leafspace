import { describe, expect, it, vi } from 'vitest';
import { createDeviceLock, normalizeLockSettings, pinVerifier } from '../../apps/client/src/services/device-lock.js';

function metadata() {
  const values = new Map();
  return { values, getSetting: vi.fn(async (key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback)),
    setSetting: vi.fn(async (key, value) => values.set(key, structuredClone(value))) };
}

describe('device diary lock', () => {
  it('accepts only bounded idle choices and safe booleans', () => {
    expect(normalizeLockSettings({ enabled: 1, idleMinutes: 999, lockOnBackground: false, hasPin: 1 }))
      .toEqual({ enabled: true, idleMinutes: 5, lockOnBackground: false, hasPin: true, systemUnlock: false });
  });
  it('stores a salted verifier rather than the PIN and arms the idle lock', async () => {
    const store = metadata(), changes = [], timers = [];
    const service = createDeviceLock({ metadata: store, iterations: 100, onChange: (value) => changes.push(value),
      setTimer: vi.fn((task, delay) => { timers.push({ task, delay }); return timers.length; }), clearTimer: vi.fn() });
    await service.initialize(); await service.enable('123456', { idleMinutes: 15, lockOnBackground: true });
    expect(JSON.stringify([...store.values])).not.toContain('123456');
    expect(store.values.get('web-lock-verifier')).toMatchObject({ algorithm: 'PBKDF2-SHA-256', iterations: 100 });
    expect(timers.at(-1).delay).toBe(15 * 60000); expect(service.view().locked).toBe(false);
    timers.at(-1).task(); expect(service.view().locked).toBe(true); expect(changes.at(-1).reason).toBe('idle');
    await service.verify('123456'); expect(service.view().locked).toBe(false);
  });
  it('starts locked after restart and never disables itself when the PIN is wrong', async () => {
    const store = metadata();
    store.values.set('device-lock-settings', { enabled: true, idleMinutes: 5, lockOnBackground: true, hasPin: true });
    store.values.set('web-lock-verifier', await pinVerifier('654321', { iterations: 100 }));
    const service = createDeviceLock({ metadata: store, iterations: 100, setTimer: vi.fn(() => 1), clearTimer: vi.fn() });
    await service.initialize(); expect(service.view().locked).toBe(true);
    await expect(service.verify('000000')).rejects.toThrow('PIN 不正确');
    await expect(service.disable('000000')).rejects.toThrow('PIN 不正确');
    expect(service.view()).toMatchObject({ locked: true, settings: { enabled: true } });
  });
  it('locks immediately in the background and account trust can unlock without changing its PIN', async () => {
    const store = metadata(), service = createDeviceLock({ metadata: store, iterations: 100, setTimer: vi.fn(() => 1), clearTimer: vi.fn() });
    await service.initialize(); await service.enable('123456', { lockOnBackground: true });
    service.onActive(false); expect(service.view().locked).toBe(true);
    service.unlockTrusted(); expect(service.view().locked).toBe(false);
    service.onActive(false); await service.verify('123456');
    service.onActive(true); expect(service.view().locked).toBe(false);
  });
  it('rate limits repeated local guesses while keeping the content locked', async () => {
    let clock = 1000; const store = metadata();
    const service = createDeviceLock({ metadata: store, iterations: 10, now: () => clock, setTimer: vi.fn(() => 1), clearTimer: vi.fn() });
    await service.initialize(); await service.enable('123456'); service.lock();
    for (let count = 0; count < 5; count++) await expect(service.verify('000000')).rejects.toThrow();
    await expect(service.verify('123456')).rejects.toThrow('30 秒');
    clock += 30001; await expect(service.verify('123456')).resolves.toBe(true);
  });
  it('uses the native secret adapter and fails closed when an enabled verifier is missing', async () => {
    const store = metadata(), secrets = { read: vi.fn(async () => null), write: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const service = createDeviceLock({ metadata: store, secrets, native: true, iterations: 10, setTimer: vi.fn(() => 1), clearTimer: vi.fn() });
    await service.initialize(); await service.enable('123456');
    expect(secrets.write).toHaveBeenCalled(); expect(store.values.has('web-lock-verifier')).toBe(false);
    const restartStore = metadata(); restartStore.values.set('device-lock-settings', { enabled: true, idleMinutes: 5, lockOnBackground: true, hasPin: true });
    const restart = createDeviceLock({ metadata: restartStore, secrets, native: true, iterations: 10, setTimer: vi.fn(() => 1), clearTimer: vi.fn() });
    await restart.initialize(); expect(restart.view().settings.enabled).toBe(false); expect(restart.view().locked).toBe(false);
  });
  it('stores system unlock as a device-local preference and clears it when the lock is disabled', async () => {
    const store = metadata(), service = createDeviceLock({ metadata: store, iterations: 10, setTimer: vi.fn(() => 1), clearTimer: vi.fn() });
    await service.initialize(); await service.enable('123456'); await service.update({ systemUnlock: true });
    expect(service.view().settings.systemUnlock).toBe(true);
    await service.disable('123456'); expect(service.view().settings.systemUnlock).toBe(false);
  });
});
