const PIN = /^\d{6}$/;
const DEFAULT = Object.freeze({ enabled: false, idleMinutes: 5, lockOnBackground: true, hasPin: false, systemUnlock: false });
const bytes = (value) => {
  const raw = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(raw + '='.repeat((4 - raw.length % 4) % 4)), (char) => char.charCodeAt(0));
};
const encoded = (value) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function normalizeLockSettings(value = {}) {
  const idleMinutes = [1, 5, 15, 30].includes(Number(value.idleMinutes)) ? Number(value.idleMinutes) : DEFAULT.idleMinutes;
  return { enabled: Boolean(value.enabled), idleMinutes, lockOnBackground: value.lockOnBackground !== false,
    hasPin: Boolean(value.hasPin), systemUnlock: Boolean(value.systemUnlock) };
}

export async function pinVerifier(pin, { iterations = 310000, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  if (!PIN.test(pin ?? '')) throw new Error('PIN 必须是 6 位数字');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256));
  return { version: 1, algorithm: 'PBKDF2-SHA-256', iterations, salt: encoded(salt), hash: encoded(hash) };
}

async function matches(pin, verifier) {
  if (!verifier || verifier.version !== 1 || verifier.algorithm !== 'PBKDF2-SHA-256' || !Number.isInteger(verifier.iterations) || verifier.iterations < 1) return false;
  try {
    const candidate = await pinVerifier(pin, { iterations: verifier.iterations, salt: bytes(verifier.salt) });
    const expected = bytes(verifier.hash), actual = bytes(candidate.hash);
    if (expected.length !== actual.length) return false;
    let difference = 0; for (let index = 0; index < expected.length; index++) difference |= expected[index] ^ actual[index];
    return difference === 0;
  } catch { return false; }
}

export function createDeviceLock({ metadata, secrets, native = false, iterations = 310000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} } = {}) {
  let settings = DEFAULT, locked = false, timer, failures = 0, blockedUntil = 0;
  const verifierStore = native ? secrets : {
    read: () => metadata.getSetting('web-lock-verifier', null),
    write: (value) => metadata.setSetting('web-lock-verifier', value),
    clear: () => metadata.setSetting('web-lock-verifier', null),
  };
  const emit = (reason) => onChange({ locked, settings: { ...settings }, reason, retryAfterMs: Math.max(0, blockedUntil - now()) });
  const arm = () => {
    if (timer) clearTimer(timer); timer = undefined;
    if (settings.enabled && !locked) timer = setTimer(() => lock('idle'), settings.idleMinutes * 60000);
  };
  async function initialize() {
    settings = normalizeLockSettings(await metadata.getSetting('device-lock-settings', DEFAULT));
    const verifier = settings.hasPin ? await verifierStore.read() : null;
    if (settings.enabled && !verifier) {
      settings = { ...settings, enabled: false, hasPin: false };
      await metadata.setSetting('device-lock-settings', settings);
    }
    locked = settings.enabled; emit('initialize'); arm(); return view();
  }
  function lock(reason = 'manual') { if (!settings.enabled || locked) return false; locked = true; if (timer) clearTimer(timer); timer = undefined; emit(reason); return true; }
  function activity() { if (!locked) arm(); }
  function onActive(active) { if (!active && settings.lockOnBackground) lock('background'); else if (active) activity(); }
  async function enable(pin, options = {}) {
    const verifier = await pinVerifier(pin, { iterations });
    await verifierStore.write(verifier);
    settings = { ...normalizeLockSettings({ ...settings, ...options }), enabled: true, hasPin: true };
    try { await metadata.setSetting('device-lock-settings', settings); }
    catch (error) { await verifierStore.clear(); throw error; }
    locked = false; failures = 0; blockedUntil = 0; arm(); emit('enabled'); return view();
  }
  async function verify(pin) {
    if (!locked) return true;
    if (blockedUntil > now()) throw Object.assign(new Error(`尝试次数较多，请在 ${Math.ceil((blockedUntil - now()) / 1000)} 秒后重试。`), { retryAfterMs: blockedUntil - now() });
    if (!await matches(pin, await verifierStore.read())) {
      failures++;
      if (failures >= 5) { blockedUntil = now() + 30000; failures = 0; }
      emit('failed'); throw new Error('PIN 不正确');
    }
    return unlockTrusted('pin');
  }
  function unlockTrusted(reason = 'account') { locked = false; failures = 0; blockedUntil = 0; arm(); emit(reason); return true; }
  async function update(options) {
    const next = { ...settings, ...normalizeLockSettings({ ...settings, ...options }), enabled: settings.enabled, hasPin: settings.hasPin };
    await metadata.setSetting('device-lock-settings', next); settings = next; arm(); emit('updated'); return view();
  }
  async function changePin(currentPin, nextPin) {
    if (!await matches(currentPin, await verifierStore.read())) throw new Error('当前 PIN 不正确');
    await verifierStore.write(await pinVerifier(nextPin, { iterations })); failures = 0; blockedUntil = 0; emit('pin-changed');
  }
  async function disable(pin) {
    if (!await matches(pin, await verifierStore.read())) throw new Error('PIN 不正确');
    const next = { ...settings, enabled: false, hasPin: false, systemUnlock: false }; await metadata.setSetting('device-lock-settings', next); await verifierStore.clear(); settings = next;
    locked = false; if (timer) clearTimer(timer); timer = undefined; emit('disabled'); return view();
  }
  const view = () => ({ locked, settings: { ...settings }, retryAfterMs: Math.max(0, blockedUntil - now()) });
  function destroy() { if (timer) clearTimer(timer); timer = undefined; }
  return { initialize, view, lock, activity, onActive, enable, verify, unlockTrusted, update, changePin, disable, destroy };
}
