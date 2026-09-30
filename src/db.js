import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const toNumber = v => (v === null ? null : Number(v));

/** Traduce `?` y `@nombre` a `$n`. El código de negocio escribe SQL con esos marcadores; aquí se adaptan a Postgres. */
export function aPg(sql, args = []) {
  const valores = [], por = {};
  const out = sql.replace(/\?|@([a-z_]\w*)/gi, (_m, nombre) => {
    if (nombre) { if (!(nombre in por)) { valores.push(args[nombre]); por[nombre] = valores.length; } return `$${por[nombre]}`; }
    valores.push(args[valores.length]); return `$${valores.length}`;
  });
  return { text: out, values: valores };
}

const ops = (q, e) => ({
  exec: e,
  async all(sql, args) { const { text, values } = aPg(sql, args); return (await q(text, values)).rows; },
  async get(sql, args) { return (await this.all(sql, args))[0]; },
  async run(sql, args) { const { text, values } = aPg(sql, args); const r = await q(text, values); return { changes: r.rowCount ?? r.affectedRows ?? 0 }; }
});

/**
 * Abre la base. `url` postgres://… (Neon, producción) o `pglite:./ruta` / `pglite:memory` (Postgres embebido para desarrollo y pruebas).
 */
export async function openDb({ url }) {
  let db;
  if (/^pglite:/.test(url)) {
    const ruta = url.slice(7);
    if (ruta !== 'memory') mkdirSync(resolve(ruta), { recursive: true });
    const lite = new PGlite(ruta === 'memory' ? undefined : resolve(ruta), { parsers: { 20: toNumber } });
    await lite.waitReady;
    db = { ...ops((t, v) => lite.query(t, v), s => lite.exec(s)),
      tx: fn => lite.transaction(tx => fn(ops((t, v) => tx.query(t, v), s => tx.exec(s)))), close: () => lite.close(), embebida: true };
  } else {
    pg.types.setTypeParser(20, toNumber); // BIGINT/count(*) → number
    const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
    db = { ...ops((t, v) => pool.query(t, v), s => pool.query(s)),
      async tx(fn) {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn(ops((t, v) => c.query(t, v), s => c.query(s))); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      }, close: () => pool.end(), embebida: false };
  }
  await migrar(db);
  return db;
}

// Varias instancias serverless pueden arrancar a la vez: el lock asesor serializa las migraciones.
async function migrar(db) {
  await db.tx(async x => {
    await x.run('SELECT pg_advisory_xact_lock(7412001)');
    await x.run('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const hechas = new Set((await x.all('SELECT name FROM schema_migrations')).map(r => r.name));
    for (const f of readdirSync(MIGRATIONS).filter(n => n.endsWith('.sql')).sort()) {
      if (hechas.has(f)) continue;
      await x.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
      await x.run('INSERT INTO schema_migrations(name, applied_at) VALUES (?,?)', [f, new Date().toISOString()]);
    }
  });
}
