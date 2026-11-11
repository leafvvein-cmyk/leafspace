import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT');
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get()) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE sync_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        CREATE TABLE entries(id TEXT PRIMARY KEY, entry_date TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL) STRICT;
        CREATE TABLE mutations(client_request_id TEXT PRIMARY KEY, response_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
        INSERT INTO sync_state VALUES(1,1);
      `);
      db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?)').run('welcome-entry', '2026-09-08', '离线同步从这里开始', '先保存到本机，再等待服务器明确确认。', 1, now);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(1, now);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return db;
}
