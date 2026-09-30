import { createClient } from '@libsql/client';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const fila = (r, i) => Object.fromEntries(r.columns.map((c, k) => [c, r.rows[i][k]]));
function ops(x) {
  return {
    async all(sql, args = []) { const r = await x.execute({ sql, args }); return r.rows.map((_, i) => fila(r, i)); },
    async get(sql, args = []) { const r = await x.execute({ sql, args }); return r.rows.length ? fila(r, 0) : undefined; },
    async run(sql, args = []) { const r = await x.execute({ sql, args }); return { changes: r.rowsAffected }; }
  };
}

/**
 * Abre la base. `url` puede ser `file:./data/app.db` (local) o `libsql://…` (Turso, necesario en Vercel).
 * Las transacciones usan una conexión dedicada, por eso las bases en memoria no sirven para probar: usa un archivo temporal.
 */
export async function openDb({ url, authToken }) {
  if (url.startsWith('file:') && !url.startsWith('file::memory')) mkdirSync(dirname(resolve(url.slice(5))), { recursive: true });
  const client = createClient({ url, authToken: authToken || undefined });
  const db = {
    ...ops(client),
    async tx(fn) {
      const t = await client.transaction('write');
      try { const r = await fn(ops(t)); await t.commit(); return r; }
      catch (e) { await t.rollback().catch(() => {}); throw e; }
      finally { t.close(); }
    },
    close: () => client.close(),
    local: url.startsWith('file:'),
    path: url.startsWith('file:') ? resolve(url.slice(5)) : null
  };
  await migrate(client);
  return db;
}

async function migrate(client) {
  await client.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const hechas = new Set((await client.execute('SELECT name FROM schema_migrations')).rows.map(r => r[0]));
  for (const f of readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort()) {
    if (hechas.has(f)) continue;
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    await client.executeMultiple(sql);
    await client.execute({ sql: 'INSERT INTO schema_migrations(name, applied_at) VALUES (?,?)', args: [f, new Date().toISOString()] });
  }
}
