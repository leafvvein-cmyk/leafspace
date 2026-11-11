import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const migrated = database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(1);
  if (!migrated) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 2 AND 80),
        content TEXT NOT NULL CHECK(length(content) BETWEEN 5 AND 5000),
        entry_date TEXT NOT NULL CHECK(entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`);
      database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(1, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return database;
}
