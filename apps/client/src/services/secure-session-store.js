import { requireNativePlugin } from './platform.js';

let ready;
async function storage() {
  requireNativePlugin('SecureStorage');
  return ready ??= (async () => {
    const { SecureStorage, KeychainAccess } = await import('@aparajita/capacitor-secure-storage');
    await SecureStorage.setKeyPrefix('diary_v2_session_');
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
    return SecureStorage;
  })().catch((error) => { ready = undefined; throw error; });
}

// This adapter deliberately has NO Web fallback: that plugin's Web shim uses
// unencrypted localStorage. Web authentication must use the HttpOnly cookie.
export const nativeSessionStore = {
  async read() { return (await storage()).get('session', false, false); },
  async write(session) {
    if (!session || typeof session.refreshToken !== 'string' || !session.refreshToken || typeof session.userId !== 'string') throw new Error('无效的手机会话');
    await (await storage()).set('session', { userId: session.userId, refreshToken: session.refreshToken }, false, false);
  },
  async clear() { await (await storage()).remove('session', false); },
};

// The verifier is device-only and never uses the plugin's plaintext Web shim.
export const nativeLockSecretStore = {
  async read() { return (await storage()).get('device_lock', false, false); },
  async write(verifier) { await (await storage()).set('device_lock', verifier, false, false); },
  async clear() { await (await storage()).remove('device_lock', false); },
};
