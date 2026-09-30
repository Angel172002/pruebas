import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { crearApp } from '../src/app.js';
import { diasHasta, escalamiento, sumarMes } from '../src/domain.js';

let server, base, db, ghCalls, dir;
const cookies = {};
const fakeFetch = async (url, init = {}) => {
  ghCalls.push({ url, init });
  const json = b => ({ ok: true, status: 200, json: async () => b });
  if (init.method === 'POST') return json({ number: 7, title: 'T', html_url: 'https://github.com/o/r/issues/7', state: 'open' });
  if (/issues\/7$/.test(url)) return json({ number: 7, title: 'T', html_url: 'https://github.com/o/r/issues/7', state: 'closed' });
  return json([{ number: 9, title: 'Bug', html_url: 'https://github.com/o/r/issues/9', state: 'open' }]);
};

before(async () => {
  ghCalls = [];
  const cfg = loadConfig({ OWNER_TOKEN: 'owner-secret-123', SESSION_SECRET: 'test-session-secret-123', EDITOR_TOKEN: 'editor-secret-123', VIEWER_TOKEN: 'viewer-secret-1', GITHUB_TOKEN: 'ghp_x', GITHUB_REPOS: 'o/r' });
  dir = mkdtempSync(join(tmpdir(), 'liva-'));
  db = await openDb({ url: process.env.TEST_DATABASE_URL || `pglite:${join(dir, 'pg')}` });
  server = crearApp({ cfg, db, fetchImpl: fakeFetch }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [rol, token] of [['owner', 'owner-secret-123'], ['editor', 'editor-secret-123'], ['viewer', 'viewer-secret-1']]) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'liva' }, body: JSON.stringify({ token }) });
    cookies[rol] = r.headers.get('set-cookie').split(';')[0];
  }
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const req = (rol, method, path, body) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', 'x-requested-with': 'liva', ...(rol ? { cookie: cookies[rol] } : {}) },
  body: body ? JSON.stringify(body) : undefined
});
const fecha = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const act = (extra = {}) => ({ tipo: 'actividad', titulo: 'Tarea', categoria: 'urgente', area: 'Dirección General', ...extra });

test('sin sesión no hay acceso y hay cabeceras de seguridad', async () => {
  const r = await req(null, 'GET', '/api/tasks');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('CSRF: escrituras sin cabecera son rechazadas', async () => {
  const r = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies.owner }, body: JSON.stringify(act()) });
  assert.equal(r.status, 403);
});

test('login incorrecto devuelve 401', async () => {
  assert.equal((await req(null, 'POST', '/api/login', { token: 'nope' })).status, 401);
});

test('validación del servidor: categoría, dirección, fecha y reglas de negocio', async () => {
  assert.equal((await req('owner', 'POST', '/api/tasks', act({ categoria: 'x" onmouseover="' }))).status, 422);
  assert.equal((await req('owner', 'POST', '/api/tasks', act({ area: 'Inventada' }))).status, 422);
  assert.equal((await req('owner', 'POST', '/api/tasks', act({ fecha_limite: '2026-02-31' }))).status, 422);
  assert.equal((await req('owner', 'POST', '/api/tasks', act({ categoria: 'prioritario' }))).status, 422); // prioritario + General
  assert.equal((await req('owner', 'POST', '/api/tasks', act({ categoria: 'importante' }))).status, 422);
  assert.equal((await req('owner', 'POST', '/api/tasks', { tipo: 'pago', titulo: 'Luz', categoria: 'importante', area: 'Todos' })).status, 422); // sin fecha
  assert.equal((await req('owner', 'POST', '/api/tasks', { tipo: 'pago', titulo: 'Luz', categoria: 'importante', area: 'Todos', fecha_limite: fecha(3), monto: 1.5 })).status, 422);
});

test('roles: viewer solo lee, editor no ve ni crea pagos, pagos son del owner', async () => {
  assert.equal((await req('viewer', 'POST', '/api/tasks', act())).status, 403);
  assert.equal((await req('editor', 'POST', '/api/tasks', { tipo: 'pago', titulo: 'P', categoria: 'importante', area: 'Todos', fecha_limite: fecha(3) })).status, 403);
  const p = await (await req('owner', 'POST', '/api/tasks', { tipo: 'pago', titulo: 'Arriendo', categoria: 'importante', area: 'Todos', fecha_limite: fecha(3), monto: 1500000 })).json();
  const lista = await (await req('editor', 'GET', '/api/tasks')).json();
  assert.ok(!lista.tasks.some(t => t.tipo === 'pago'));
  assert.equal((await req('editor', 'PATCH', `/api/tasks/${p.task.id}`, { titulo: 'x' })).status, 404);
  assert.equal((await req('editor', 'DELETE', `/api/tasks/${p.task.id}`)).status, 403);
  const resumen = await (await req('editor', 'GET', '/api/summary')).json();
  assert.equal(resumen.pagos, undefined);
});

test('ciclo de vida, versión optimista y auditoría', async () => {
  const { task } = await (await req('editor', 'POST', '/api/tasks', act({ titulo: 'Ciclo' }))).json();
  const a = await req('editor', 'PATCH', `/api/tasks/${task.id}`, { titulo: 'Ciclo 2', version: task.version });
  assert.equal(a.status, 200);
  assert.equal((await req('editor', 'PATCH', `/api/tasks/${task.id}`, { titulo: 'Viejo', version: task.version })).status, 409);
  assert.equal((await req('editor', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).status, 200);
  assert.equal((await req('editor', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).status, 409);
  assert.equal((await req('editor', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'descartar' })).status, 403);
  const ev = await (await req('viewer', 'GET', `/api/tasks/${task.id}/events`)).json();
  assert.deepEqual(ev.events.map(e => e.accion).reverse(), ['crear', 'editar', 'cerrar']);
});

test('pago recurrente: día ancla e idempotencia', async () => {
  const { task } = await (await req('owner', 'POST', '/api/tasks', { tipo: 'pago', titulo: 'Nómina', categoria: 'importante', area: 'Todos', fecha_limite: '2027-01-31', monto: 100, recurrente: 'mensual' })).json();
  const r1 = await (await req('owner', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).json();
  assert.equal(r1.siguiente.fecha_limite, '2027-02-28');
  await req('owner', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'reabrir' });
  const r2 = await (await req('owner', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).json();
  assert.equal(r2.siguiente, null); // no duplica
  const r3 = await (await req('owner', 'POST', `/api/tasks/${r1.siguiente.id}/transition`, { accion: 'cerrar' })).json();
  assert.equal(r3.siguiente.fecha_limite, '2027-03-31'); // sin deriva
});

test('escalamiento derivado: no persiste y distingue vencida', () => {
  assert.deepEqual(escalamiento({ estado: 'pendiente', categoria: 'importante', fecha_limite: '2027-05-09' }, '2027-05-10'), { categoria_efectiva: 'urgente', escalada: 'vencida' });
  assert.deepEqual(escalamiento({ estado: 'pendiente', categoria: 'importante', fecha_limite: '2027-05-12' }, '2027-05-10'), { categoria_efectiva: 'urgente', escalada: 'proxima' });
  assert.equal(escalamiento({ estado: 'pendiente', categoria: 'importante', fecha_limite: '2027-05-20' }, '2027-05-10').escalada, null);
  assert.equal(diasHasta('2027-03-15', '2027-03-14'), 1);
  assert.equal(sumarMes('2027-12-31', 31), '2028-01-31');
});

test('propuestas: invisibles para no-owner, confirmación atómica por reunión', async () => {
  const items = [{ titulo: 'Del comité 1', categoria: 'prioritario', area: 'Dirección Comercial', origen: 'Comité 5' },
    { titulo: 'Del comité 2', categoria: 'urgente', area: 'Dirección General', origen: 'Comité 5' },
    { tipo: 'pago', titulo: 'Pago sin fecha', categoria: 'importante', area: 'Todos', origen: 'Comité 5' }];
  assert.equal((await req('owner', 'POST', '/api/proposals', { items })).status, 201);
  assert.equal((await req('editor', 'GET', '/api/proposals')).status, 403);
  assert.ok(!(await (await req('editor', 'GET', '/api/tasks')).json()).tasks.some(t => t.origen === 'Comité 5'));
  const r = await (await req('owner', 'POST', '/api/meetings/confirm', { origen: 'Comité 5' })).json();
  assert.equal(r.confirmadas, 2);
  assert.equal(r.requierenRevision.length, 1);
});

test('importar el formato del artifact: idempotente y rechaza montos ambiguos', async () => {
  const datos = {
    tareas: [{ id: 'a1', titulo: 'Legacy', categoria: 'prioritario', direccion: 'Legal', fecha: '2027-06-01', estado: 'hecha', completada: '2027-05-01T10:00:00Z', propuesta: false }],
    pagos: [{ id: 'p1', titulo: 'Pago legacy', categoria: 'importante', direccion: 'SEMAFORA', fecha: '2027-06-05', monto: '1500000', recurrente: 'mensual' },
      { id: 'p2', titulo: 'Ambiguo', fecha: '2027-06-05', monto: '1.500,50' }]
  };
  const r1 = await (await req('owner', 'POST', '/api/import', datos)).json();
  assert.equal(r1.nuevas, 2); assert.equal(r1.rechazos.length, 1);
  const r2 = await (await req('owner', 'POST', '/api/import', datos)).json();
  assert.equal(r2.nuevas, 0);
  const t = (await (await req('owner', 'GET', '/api/tasks')).json()).tasks.find(x => x.id === 'a1');
  assert.equal(t.area, 'Dirección Jurídica'); assert.equal(t.estado, 'cerrada');
  const csv = await (await req('owner', 'GET', '/api/export.csv?tipo=pago')).text();
  assert.match(csv, /Pago legacy/);
});

test('CSV neutraliza fórmulas', async () => {
  await req('owner', 'POST', '/api/tasks', { tipo: 'pago', titulo: '=HYPERLINK("x")', categoria: 'importante', area: 'Todos', fecha_limite: fecha(40), monto: 1 });
  const csv = await (await req('owner', 'GET', '/api/export.csv?tipo=pago')).text();
  assert.match(csv, /'=HYPERLINK/);
});

test('GitHub: lista permitida, crear issue, vincular, refrescar y token nunca al cliente', async () => {
  const { task } = await (await req('editor', 'POST', '/api/tasks', act({ titulo: 'Con issue' }))).json();
  assert.equal((await req('editor', 'POST', `/api/tasks/${task.id}/issue`, { repo: 'otro/repo' })).status, 403);
  assert.equal((await req('editor', 'POST', `/api/tasks/${task.id}/issue`, { repo: '../../x' })).status, 400);
  const r = await req('editor', 'POST', `/api/tasks/${task.id}/issue`, { repo: 'o/r' });
  assert.equal(r.status, 201);
  assert.equal(ghCalls.at(-1).init.headers.Authorization, 'Bearer ghp_x');
  const ref = await (await req('editor', 'POST', `/api/tasks/${task.id}/links/refresh`)).json();
  assert.equal(ref.links[0].estado, 'closed');
  const sesion = await (await req('viewer', 'GET', '/api/session')).text();
  assert.ok(!sesion.includes('ghp_x'));
  const imp = await (await req('owner', 'POST', '/api/github/import', { repo: 'o/r' })).json();
  assert.equal(imp.creadas, 1);
  assert.equal((await (await req('owner', 'POST', '/api/github/import', { repo: 'o/r' })).json()).creadas, 0);
});

test('eliminar deja rastro en la auditoría', async () => {
  const { task } = await (await req('owner', 'POST', '/api/tasks', act({ titulo: 'Borrable' }))).json();
  assert.equal((await req('owner', 'DELETE', `/api/tasks/${task.id}`)).status, 204);
  const fila = await db.get('SELECT accion, detalle FROM task_events WHERE task_id = ? ORDER BY id DESC', [task.id]);
  assert.equal(fila.accion, 'eliminar');
});

test('migraciones idempotentes y producción exige secretos', async () => {
  const { openDb: abrir } = await import('../src/db.js');
  assert.equal((await db.all('SELECT name FROM schema_migrations')).length, 1);
  await assert.rejects(abrir({ url: 'postgres://invalido:1/x' }).then(() => {}), Error); // no se traga errores de conexión
  assert.throws(() => loadConfig({ NODE_ENV: 'production', OWNER_TOKEN: 'x'.repeat(12) }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(16) }), /OWNER_TOKEN/);
});

test('producción exige DATABASE_URL de Postgres', () => {
  const base = { NODE_ENV: 'production', OWNER_TOKEN: 'x'.repeat(12), SESSION_SECRET: 'y'.repeat(16) };
  assert.throws(() => loadConfig(base), /DATABASE_URL/);
  assert.equal(loadConfig({ ...base, DATABASE_URL: 'postgresql://u:p@host/db?sslmode=require' }).prod, true);
});
