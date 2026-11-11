import pg from 'pg';
import { unauthorized } from './errors.js';

pg.types.setTypeParser(1082, (value) => value); // SQL DATE is a diary date, never a JS timezone conversion.

export function createPool(connectionString) {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
}

export async function transaction(pool, operation, { repeatableRead = false, statementTimeoutMs } = {}) {
  const client = await pool.connect();
  try {
    await client.query(repeatableRead ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    if (statementTimeoutMs !== undefined) await client.query("SELECT set_config('statement_timeout',$1,true)", [String(statementTimeoutMs)]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** All account writes use one lock order: user -> sync state -> session/object. */
export async function userTransaction(pool, userId, sessionId, operation, options) {
  return transaction(pool, async (client) => {
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!user || user.status !== 'active') throw unauthorized();
    await client.query('SELECT user_id FROM sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
    if (sessionId) {
      const { rowCount } = await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > now()', [sessionId, userId]);
      if (!rowCount) throw unauthorized();
    }
    return operation(client, user);
  }, options);
}

export async function appendEvent(client, userId, changes) {
  const { rows: [state] } = await client.query('UPDATE sync_state SET last_seq=last_seq+1 WHERE user_id=$1 RETURNING last_seq', [userId]);
  await client.query('INSERT INTO sync_events(user_id,seq,changes) VALUES($1,$2,$3)', [userId, state.last_seq, JSON.stringify(changes)]);
  return state.last_seq;
}
