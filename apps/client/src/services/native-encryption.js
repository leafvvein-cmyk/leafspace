export async function ensureNativeDatabaseSecret(manager) {
  if ((await manager.isSecretStored()).result) return;
  let existing;
  try { existing = (await manager.getDatabaseList()).values ?? []; }
  catch (error) {
    // sqlite 8.1.1 Android rejects for a clean install; iOS returns []. Match
    // this exact native error only, never turn a permission/I/O error into []:
    // CapacitorSQLitePlugin.java getDatabaseList -> retValues(..., message).
    if (String(error?.message ?? error).trim() !== 'getDatabaseList: No databases available') throw error;
    existing = [];
  }
  if (existing.length) throw new Error('发现已有手机数据库，但无法取得其加密密钥。请保留数据并恢复设备密钥，不要重建数据库。');
  // Plugin persists the random secret in Keychain / Keystore-protected storage.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let passphrase = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  try { await manager.setEncryptionSecret(passphrase); }
  finally { bytes.fill(0); passphrase = ''; }
}
