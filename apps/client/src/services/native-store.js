import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { requireNativePlugin } from './platform.js';
import { createSqliteStore, SQLITE_SCHEMA_VERSION } from './sqlite-store.js';
import { ensureNativeDatabaseSecret } from './native-encryption.js';

const manager = new SQLiteConnection(CapacitorSQLite);
const openings = new Map();
let initialization;

async function initialize() {
  requireNativePlugin('CapacitorSQLite');
  await manager.checkConnectionsConsistency();
  await ensureNativeDatabaseSecret(manager);
}

export async function nativeDatabaseName(namespace) {
  if (typeof namespace !== 'string' || !namespace.length || namespace.length > 200) throw new Error('无效的本机数据空间');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(namespace));
  return `diary_v2_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function openNativeStore(namespace = 'learning') {
  requireNativePlugin('CapacitorSQLite');
  if (openings.has(namespace)) return openings.get(namespace);
  const opening = (async () => {
    await (initialization ??= initialize().catch((error) => { initialization = undefined; throw error; }));
    const name = await nativeDatabaseName(namespace);
    let connection;
    try {
      connection = (await manager.isConnection(name, false)).result
        ? await manager.retrieveConnection(name, false)
        : await manager.createConnection(name, true, 'secret', SQLITE_SCHEMA_VERSION, false);
      await connection.open();
      return await createSqliteStore(connection, namespace, {
        closeConnection: async () => { await manager.closeConnection(name, false); openings.delete(namespace); },
      });
    } catch (error) {
      if (connection) {
        try { await manager.closeConnection(name, false); }
        catch { throw Object.assign(new Error('手机数据库连接未能安全关闭，请重新打开 App 后重试；不会删除数据库。'), { unsafeConnection: true }); }
      }
      throw error;
    }
  })().catch((error) => {
    // Retry transient initialization failures, but never reuse a connection
    // whose close/rollback state is unknown. Keep the on-disk data untouched.
    if (!error.unsafeConnection) openings.delete(namespace);
    throw error;
  });
  openings.set(namespace, opening);
  return opening;
}
