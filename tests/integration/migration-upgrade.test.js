import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createPool, transaction } from '../../apps/api/src/db.js';
import { migrate } from '../../apps/api/src/migrate.js';
import { config as defaults } from '../../apps/api/src/config.js';

const databaseName = `diary_migration_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
const userId = randomUUID(), generation = randomUUID(), entryId = randomUUID();
let admin, pool, created = false;

async function applyThrough010(target) {
  await target.query('CREATE TABLE IF NOT EXISTS _diary_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const root = new URL('../../apps/api/migrations/', import.meta.url);
  const names = (await readdir(root)).filter((name) => /^00[1-9]_|^010_/.test(name)).sort();
  expect(names).toHaveLength(10);
  for (const name of names) {
    const sql = await readFile(new URL(name, root), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    await transaction(target, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO _diary_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
    });
  }
}

beforeAll(async () => {
  const url = new URL(defaults.databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54329' || !/^diary_migration_test_[0-9a-f_]+$/.test(databaseName)) throw new Error('Migration test requires the isolated loopback diary PostgreSQL server.');
  url.pathname = '/postgres';
  admin = createPool(url.href);
  await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
  url.pathname = `/${databaseName}`;
  pool = createPool(url.href);
  await applyThrough010(pool);
  await pool.query('INSERT INTO users(id,username_normalized,display_name,password_hash) VALUES($1,$2,$3,$4)', [userId, `migration_${randomUUID().slice(0, 12)}`, '迁移前账号', 'not-used-by-test']);
  await pool.query('INSERT INTO sync_state(user_id,generation) VALUES($1,$2)', [userId, generation]);
  await pool.query(`INSERT INTO entries(id,user_id,kind,entry_date,timezone,title,content_schema_version,content,plain_text,sort_at)
    VALUES($1,$2,'daily','2026-09-09','Asia/Shanghai','迁移前日记',1,$3,'升级后不能丢失','2026-09-09T08:00:00+08:00')`,
  [entryId, userId, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '升级后不能丢失' }] }] }]);
});

afterAll(async () => {
  await pool?.end();
  if (created && /^diary_migration_test_[0-9a-f_]+$/.test(databaseName)) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin?.end();
});

describe('PostgreSQL migration upgrade safety', { sequential: true }, () => {
  it('upgrades a populated migration-010 database to the current schema without changing account or diary data', async () => {
    expect((await pool.query('SELECT count(*)::integer AS count FROM _diary_migrations')).rows[0].count).toBe(10);
    expect((await pool.query("SELECT to_regclass('entry_purge_receipts') AS name")).rows[0].name).toBeNull();
    await migrate(pool);
    expect((await pool.query('SELECT count(*)::integer AS count FROM _diary_migrations')).rows[0].count).toBe(16);
    expect((await pool.query("SELECT to_regclass('entry_purge_receipts') AS name")).rows[0].name).toBe('entry_purge_receipts');
    expect((await pool.query("SELECT to_regclass('account_deletion_ledger') AS name")).rows[0].name).toBe('account_deletion_ledger');
    expect((await pool.query("SELECT to_regclass('tasks') AS name")).rows[0].name).toBe('tasks');
    expect((await pool.query("SELECT to_regclass('task_actions') AS name")).rows[0].name).toBe('task_actions');
    expect((await pool.query("SELECT to_regclass('task_request_receipts') AS name")).rows[0].name).toBe('task_request_receipts');
    expect((await pool.query("SELECT to_regclass('vault_configs') AS name")).rows[0].name).toBe('vault_configs');
    expect((await pool.query("SELECT to_regclass('vault_items') AS name")).rows[0].name).toBe('vault_items');
    expect((await pool.query("SELECT to_regclass('vault_request_receipts') AS name")).rows[0].name).toBe('vault_request_receipts');
    expect((await pool.query('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0].display_name).toBe('迁移前账号');
    expect((await pool.query('SELECT title,plain_text,content FROM entries WHERE id=$1', [entryId])).rows[0]).toMatchObject({
      title: '迁移前日记', plain_text: '升级后不能丢失', content: { type: 'doc' },
    });
  });

  it('rejects a changed applied migration and leaves existing diary data intact', async () => {
    const original = (await pool.query("SELECT sha256 FROM _diary_migrations WHERE name='001_core.sql'")).rows[0].sha256;
    await pool.query("UPDATE _diary_migrations SET sha256=$1 WHERE name='001_core.sql'", ['0'.repeat(64)]);
    await expect(migrate(pool)).rejects.toThrow('Applied migration changed: 001_core.sql');
    expect((await pool.query('SELECT title FROM entries WHERE id=$1', [entryId])).rows[0].title).toBe('迁移前日记');
    await pool.query("UPDATE _diary_migrations SET sha256=$1 WHERE name='001_core.sql'", [original]);
  });
});
