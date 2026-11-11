import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createPool, transaction } from './db.js';

export async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS _diary_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const root = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(root)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    const sql = await readFile(new URL(name, root), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(7451029)');
      const { rows: [existing] } = await client.query('SELECT sha256 FROM _diary_migrations WHERE name=$1', [name]);
      if (existing) {
        if (existing.sha256 !== hash) throw new Error(`Applied migration changed: ${name}. Add a new migration instead.`);
        return;
      }
      await client.query(sql);
      await client.query('INSERT INTO _diary_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(config.databaseUrl);
  try { await migrate(pool); console.log('Diary database migrations applied.'); }
  finally { await pool.end(); }
}
