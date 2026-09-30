import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  let v = db.pragma('user_version', { simple: true });
  files.forEach((f, i) => {
    if (i < v) return;
    db.transaction(() => {
      db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
      db.pragma(`user_version = ${i + 1}`);
    })();
  });
}
