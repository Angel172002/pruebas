import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { crearApp } from '../src/app.js';
import { sembrarAdmin } from '../src/users.js';
import { diasHasta, escalamiento, sumarMes } from '../src/domain.js';

const COM = 'Dirección Comercial', JUR = 'Dirección Jurídica';
const INICIAL = 'admin-inicial-123', ADMIN_PASS = 'Admin-clave-nueva-1', USER_PASS = 'Usuario-clave-1';
let server, base, db, ghCalls, dir;
const cookies = {}; // admin, com, jur, lec
const fakeFetch = async (url, init = {}) => {
  ghCalls.push({ url, init });
  const json = b => ({ ok: true, status: 200, json: async () => b });
  if (init.method === 'POST') return json({ number: 7, title: 'T', html_url: 'https://github.com/o/r/issues/7', state: 'open' });
  if (/issues\/7$/.test(url)) return json({ number: 7, title: 'T', html_url: 'https://github.com/o/r/issues/7', state: 'closed' });
  return json([{ number: 9, title: 'Bug', html_url: 'https://github.com/o/r/issues/9', state: 'open' }]);
};
const H = { 'content-type': 'application/json', 'x-requested-with': 'liva' };
const llamar = (cookie, method, path, body) => fetch(base + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const req = (rol, method, path, body) => llamar(cookies[rol], method, path, body);
const login = (email, password) => llamar(null, 'POST', '/api/login', { email, password });
const ck = r => r.headers.get('set-cookie').split(';')[0];
/** Login con la clave temporal + cambio obligatorio → cookie de sesión normal. */
async function activar(email, temporal, nueva) {
  const r = await login(email, temporal);
  const c = ck(r);
  const cambio = await llamar(c, 'POST', '/api/me/password', { actual: temporal, nueva });
  assert.equal(cambio.status, 200);
  return ck(cambio);
}
const fecha = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const act = (extra = {}) => ({ tipo: 'actividad', titulo: 'Tarea', categoria: 'urgente', area: COM, ...extra });
const pago = (extra = {}) => ({ tipo: 'pago', titulo: 'Luz', categoria: 'importante', area: 'Todos', fecha_limite: fecha(3), ...extra });

before(async () => {
  ghCalls = [];
  const cfg = loadConfig({ OWNER_TOKEN: INICIAL, ADMIN_EMAIL: 'Admin@Liva.co', SESSION_SECRET: 'test-session-secret-123', GITHUB_TOKEN: 'ghp_x', GITHUB_REPOS: 'o/r' });
  dir = mkdtempSync(join(tmpdir(), 'liva-'));
  db = await openDb({ url: process.env.TEST_DATABASE_URL || `pglite:${join(dir, 'pg')}` });
  if (process.env.TEST_DATABASE_URL) await db.run('TRUNCATE tasks, series, task_events, github_links, users, login_attempts RESTART IDENTITY CASCADE');
  await sembrarAdmin(db, cfg);
  server = crearApp({ cfg, db, fetchImpl: fakeFetch }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  cookies.admin = await activar('admin@liva.co', INICIAL, ADMIN_PASS);
  for (const [rol, email, area, nombre, rolUsuario] of [['com', 'com@liva.co', COM, 'Ana Comercial', 'miembro'], ['jur', 'jur@liva.co', JUR, 'Juan Jurídico', 'miembro'], ['lec', 'lec@liva.co', COM, 'Lía Lectora', 'lector']]) {
    const r = await req('admin', 'POST', '/api/users', { email, nombre, rol: rolUsuario, area });
    assert.equal(r.status, 201);
    cookies[rol] = await activar(email, (await r.json()).temporal, USER_PASS);
  }
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('sin sesión no hay acceso, cabeceras de seguridad y CSRF', async () => {
  const r = await llamar(null, 'GET', '/api/tasks');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  const csrf = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookies.admin }, body: JSON.stringify(act()) });
  assert.equal(csrf.status, 403);
});

test('login: errores genéricos, no revela si el correo existe y se bloquea tras varios intentos', async () => {
  const a = await login('nadie@liva.co', 'x'.repeat(12)), b = await login('com@liva.co', 'incorrecta-123');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal((await a.json()).error, (await b.json()).error);
  for (let i = 0; i < 8; i++) await login('bloqueo@liva.co', 'mala-clave-' + i);
  assert.equal((await login('bloqueo@liva.co', 'otra-clave-99')).status, 429);
  assert.equal((await login('com@liva.co', USER_PASS)).status, 200); // otro correo no se ve afectado
});

test('primer ingreso: clave temporal obliga a cambiarla y bloquea el resto de la API', async () => {
  const { temporal } = await (await req('admin', 'POST', '/api/users', { email: 'nuevo@liva.co', nombre: 'Nuevo', rol: 'miembro', area: COM })).json();
  const r = await login('nuevo@liva.co', temporal);
  const c = ck(r);
  assert.equal((await r.json()).user.must_change, true);
  const bloqueada = await llamar(c, 'GET', '/api/tasks');
  assert.equal(bloqueada.status, 403); assert.equal((await bloqueada.json()).code, 'must_change');
  assert.equal((await llamar(c, 'POST', '/api/me/password', { actual: 'incorrecta', nueva: 'Una-clave-larga-1' })).status, 401);
  assert.equal((await llamar(c, 'POST', '/api/me/password', { actual: temporal, nueva: 'corta' })).status, 422);
  assert.equal((await llamar(c, 'POST', '/api/me/password', { actual: temporal, nueva: temporal })).status, 422);
  const ok = await llamar(c, 'POST', '/api/me/password', { actual: temporal, nueva: 'Una-clave-larga-1' });
  assert.equal(ok.status, 200);
  assert.equal((await llamar(ck(ok), 'GET', '/api/tasks')).status, 200);
  assert.equal((await llamar(c, 'GET', '/api/tasks')).status, 401); // la sesión anterior quedó invalidada
  assert.equal((await login('nuevo@liva.co', temporal)).status, 401);
});

test('aislamiento por dirección: cada equipo solo ve y edita su panel', async () => {
  const c1 = (await (await req('admin', 'POST', '/api/tasks', act({ titulo: 'Solo comercial' }))).json()).task;
  const j1 = (await (await req('admin', 'POST', '/api/tasks', act({ titulo: 'Solo jurídico', area: JUR }))).json()).task;
  const t1 = (await (await req('admin', 'POST', '/api/tasks', act({ titulo: 'Para todos', area: 'Todos' }))).json()).task;
  const titulos = async rol => (await (await req(rol, 'GET', '/api/tasks')).json()).tasks.map(t => t.titulo);
  assert.deepEqual((await titulos('com')).sort(), ['Para todos', 'Solo comercial']);
  assert.deepEqual((await titulos('jur')).sort(), ['Para todos', 'Solo jurídico']);
  assert.deepEqual((await titulos('lec')).sort(), ['Para todos', 'Solo comercial']);
  // acceso directo a lo ajeno: como si no existiera
  assert.equal((await req('jur', 'GET', `/api/tasks/${c1.id}/events`)).status, 404);
  assert.equal((await req('jur', 'PATCH', `/api/tasks/${c1.id}`, { titulo: 'hack' })).status, 404);
  assert.equal((await req('jur', 'POST', `/api/tasks/${c1.id}/transition`, { accion: 'cerrar' })).status, 404);
  assert.equal((await req('jur', 'POST', `/api/tasks/${c1.id}/issue`, { repo: 'o/r' })).status, 404);
  assert.equal((await req('com', 'PATCH', `/api/tasks/${j1.id}`, { titulo: 'hack' })).status, 404);
  // lo de "Todos" se ve pero no se modifica
  assert.equal((await req('com', 'PATCH', `/api/tasks/${t1.id}`, { titulo: 'x' })).status, 403);
  // crear: el área se fuerza a la del usuario aunque pida otra
  const propia = await (await req('com', 'POST', '/api/tasks', act({ titulo: 'Intento ajeno', area: JUR }))).json();
  assert.equal(propia.task.area, COM);
  // mover una tarea a otra dirección tampoco es posible
  const mov = await (await req('com', 'PATCH', `/api/tasks/${c1.id}`, { area: JUR })).json();
  assert.equal(mov.task.area, COM);
  // lector: ve pero no escribe
  assert.equal((await req('lec', 'POST', '/api/tasks', act())).status, 403);
  assert.equal((await req('lec', 'PATCH', `/api/tasks/${c1.id}`, { titulo: 'x' })).status, 403);
  assert.equal((await req('lec', 'POST', `/api/tasks/${c1.id}/transition`, { accion: 'cerrar' })).status, 403);
  // el resumen de un miembro solo cuenta su panel
  const resumen = await (await req('jur', 'GET', '/api/summary')).json();
  assert.equal(resumen.actividades.abiertas, 2);
});

test('pagos, propuestas, usuarios y exportación: solo administrador', async () => {
  const p = (await (await req('admin', 'POST', '/api/tasks', pago({ titulo: 'Arriendo', monto: 1500000 }))).json()).task;
  for (const rol of ['com', 'lec']) {
    assert.ok(!(await (await req(rol, 'GET', '/api/tasks')).json()).tasks.some(t => t.tipo === 'pago'));
    assert.equal((await req(rol, 'GET', `/api/tasks/${p.id}/events`)).status, 404);
    assert.equal((await req(rol, 'DELETE', `/api/tasks/${p.id}`)).status, 403);
    assert.equal((await req(rol, 'GET', '/api/users')).status, 403);
    assert.equal((await req(rol, 'GET', '/api/export')).status, 403);
    assert.equal((await req(rol, 'GET', '/api/proposals')).status, 403);
    assert.equal((await req(rol, 'POST', '/api/import', {})).status, 403);
    assert.equal((await req(rol, 'GET', '/api/github/issues?repo=o/r')).status, 403);
  }
  assert.equal((await req('com', 'POST', '/api/tasks', pago())).status, 403);
  assert.equal((await (await req('com', 'GET', '/api/summary')).json()).pagos, undefined);
});

test('gestión de usuarios: duplicados, desactivar, restablecer y protecciones del admin', async () => {
  const dup = await req('admin', 'POST', '/api/users', { email: 'COM@liva.co', nombre: 'Dup', rol: 'miembro', area: COM });
  assert.equal(dup.status, 409);
  assert.equal((await req('admin', 'POST', '/api/users', { email: 'x@liva.co', nombre: 'X', rol: 'miembro', area: 'Todos' })).status, 422);
  assert.equal((await req('admin', 'POST', '/api/users', { email: 'x@liva.co', nombre: 'X', rol: 'miembro' })).status, 422);
  assert.equal((await req('admin', 'POST', '/api/users', { email: 'malcorreo', nombre: 'X', rol: 'lector', area: COM })).status, 422);
  const lista = (await (await req('admin', 'GET', '/api/users')).json()).users;
  assert.ok(lista.every(u => !('pass_hash' in u)));
  const yo = lista.find(u => u.email === 'admin@liva.co');
  assert.equal((await req('admin', 'PATCH', `/api/users/${yo.id}`, { activo: false })).status, 422);
  assert.equal((await req('admin', 'PATCH', `/api/users/${yo.id}`, { rol: 'miembro', area: COM })).status, 422);
  // restablecer cierra las sesiones del usuario y fuerza nuevo cambio
  const { id } = (await (await req('admin', 'POST', '/api/users', { email: 'temp@liva.co', nombre: 'Temp', rol: 'lector', area: JUR })).json()).usuario;
  // desactivar: sesión vigente y login dejan de servir
  const { temporal } = await (await req('admin', 'POST', `/api/users/${id}/reset`)).json();
  const cookieViva = await activar('temp@liva.co', temporal, USER_PASS);
  assert.equal((await llamar(cookieViva, 'GET', '/api/tasks')).status, 200);
  assert.equal((await req('admin', 'PATCH', `/api/users/${id}`, { activo: false })).status, 200);
  assert.equal((await llamar(cookieViva, 'GET', '/api/tasks')).status, 401);
  assert.equal((await login('temp@liva.co', USER_PASS)).status, 401);
  // cambiar de dirección invalida la sesión y limita el acceso a la nueva
  assert.equal((await req('admin', 'PATCH', `/api/users/${id}`, { activo: true, area: COM })).status, 200);
});

test('validación del servidor: categoría, dirección, fecha y reglas de negocio', async () => {
  assert.equal((await req('admin', 'POST', '/api/tasks', act({ categoria: 'x" onmouseover="' }))).status, 422);
  assert.equal((await req('admin', 'POST', '/api/tasks', act({ area: 'Inventada' }))).status, 422);
  assert.equal((await req('admin', 'POST', '/api/tasks', act({ fecha_limite: '2026-02-31' }))).status, 422);
  assert.equal((await req('admin', 'POST', '/api/tasks', act({ categoria: 'prioritario', area: 'Dirección General' }))).status, 422);
  assert.equal((await req('admin', 'POST', '/api/tasks', act({ categoria: 'importante', area: 'Dirección General' }))).status, 422);
  assert.equal((await req('admin', 'POST', '/api/tasks', pago({ fecha_limite: undefined }))).status, 422);
  assert.equal((await req('admin', 'POST', '/api/tasks', pago({ monto: 1.5 }))).status, 422);
});

test('ciclo de vida, versión optimista y auditoría', async () => {
  const { task } = await (await req('com', 'POST', '/api/tasks', act({ titulo: 'Ciclo' }))).json();
  assert.equal((await req('com', 'PATCH', `/api/tasks/${task.id}`, { titulo: 'Ciclo 2', version: task.version })).status, 200);
  assert.equal((await req('com', 'PATCH', `/api/tasks/${task.id}`, { titulo: 'Viejo', version: task.version })).status, 409);
  assert.equal((await req('com', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).status, 200);
  assert.equal((await req('com', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).status, 409);
  assert.equal((await req('com', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'descartar' })).status, 403);
  const ev = await (await req('lec', 'GET', `/api/tasks/${task.id}/events`)).json();
  assert.deepEqual(ev.events.map(e => e.accion).reverse(), ['crear', 'editar', 'cerrar']);
  assert.equal(ev.events[0].actor, 'com@liva.co'); // auditoría con el usuario real
});

test('pago recurrente: día ancla e idempotencia', async () => {
  const { task } = await (await req('admin', 'POST', '/api/tasks', pago({ titulo: 'Nómina', fecha_limite: '2027-01-31', monto: 100, recurrente: 'mensual' }))).json();
  const r1 = await (await req('admin', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).json();
  assert.equal(r1.siguiente.fecha_limite, '2027-02-28');
  await req('admin', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'reabrir' });
  const r2 = await (await req('admin', 'POST', `/api/tasks/${task.id}/transition`, { accion: 'cerrar' })).json();
  assert.equal(r2.siguiente, null);
  const r3 = await (await req('admin', 'POST', `/api/tasks/${r1.siguiente.id}/transition`, { accion: 'cerrar' })).json();
  assert.equal(r3.siguiente.fecha_limite, '2027-03-31');
});

test('escalamiento derivado: no persiste y distingue vencida', () => {
  assert.deepEqual(escalamiento({ estado: 'pendiente', categoria: 'importante', fecha_limite: '2027-05-09' }, '2027-05-10'), { categoria_efectiva: 'urgente', escalada: 'vencida' });
  assert.deepEqual(escalamiento({ estado: 'pendiente', categoria: 'importante', fecha_limite: '2027-05-12' }, '2027-05-10'), { categoria_efectiva: 'urgente', escalada: 'proxima' });
  assert.equal(escalamiento({ estado: 'pendiente', categoria: 'importante', fecha_limite: '2027-05-20' }, '2027-05-10').escalada, null);
  assert.equal(diasHasta('2027-03-15', '2027-03-14'), 1);
  assert.equal(sumarMes('2027-12-31', 31), '2028-01-31');
});

test('propuestas: invisibles para el equipo, confirmación atómica por reunión', async () => {
  const items = [{ titulo: 'Del comité 1', categoria: 'prioritario', area: COM, origen: 'Comité 5' },
    { titulo: 'Del comité 2', categoria: 'urgente', area: 'Dirección General', origen: 'Comité 5' },
    { tipo: 'pago', titulo: 'Pago sin fecha', categoria: 'importante', area: 'Todos', origen: 'Comité 5' }];
  assert.equal((await req('admin', 'POST', '/api/proposals', { items })).status, 201);
  assert.ok(!(await (await req('com', 'GET', '/api/tasks')).json()).tasks.some(t => t.origen === 'Comité 5'));
  const r = await (await req('admin', 'POST', '/api/meetings/confirm', { origen: 'Comité 5' })).json();
  assert.equal(r.confirmadas, 2); assert.equal(r.requierenRevision.length, 1);
});

test('importar el formato del artifact: idempotente y rechaza montos ambiguos', async () => {
  const datos = {
    tareas: [{ id: 'a1', titulo: 'Legacy', categoria: 'prioritario', direccion: 'Legal', fecha: '2027-06-01', estado: 'hecha', completada: '2027-05-01T10:00:00Z', propuesta: false }],
    pagos: [{ id: 'p1', titulo: 'Pago legacy', categoria: 'importante', direccion: 'SEMAFORA', fecha: '2027-06-05', monto: '1500000', recurrente: 'mensual' },
      { id: 'p2', titulo: 'Ambiguo', fecha: '2027-06-05', monto: '1.500,50' }]
  };
  const r1 = await (await req('admin', 'POST', '/api/import', datos)).json();
  assert.equal(r1.nuevas, 2); assert.equal(r1.rechazos.length, 1);
  assert.equal((await (await req('admin', 'POST', '/api/import', datos)).json()).nuevas, 0);
  const t = (await (await req('admin', 'GET', '/api/tasks')).json()).tasks.find(x => x.id === 'a1');
  assert.equal(t.area, JUR); assert.equal(t.estado, 'cerrada');
  assert.match(await (await req('admin', 'GET', '/api/export.csv?tipo=pago')).text(), /Pago legacy/);
});

test('CSV neutraliza fórmulas', async () => {
  await req('admin', 'POST', '/api/tasks', pago({ titulo: '=HYPERLINK("x")', fecha_limite: fecha(40), monto: 1 }));
  assert.match(await (await req('admin', 'GET', '/api/export.csv?tipo=pago')).text(), /'=HYPERLINK/);
});

test('GitHub: lista permitida, solo sobre tareas propias, token nunca al cliente', async () => {
  const { task } = await (await req('com', 'POST', '/api/tasks', act({ titulo: 'Con issue' }))).json();
  assert.equal((await req('com', 'POST', `/api/tasks/${task.id}/issue`, { repo: 'otro/repo' })).status, 403);
  assert.equal((await req('com', 'POST', `/api/tasks/${task.id}/issue`, { repo: '../../x' })).status, 400);
  assert.equal((await req('jur', 'POST', `/api/tasks/${task.id}/issue`, { repo: 'o/r' })).status, 404);
  assert.equal((await req('com', 'POST', `/api/tasks/${task.id}/issue`, { repo: 'o/r' })).status, 201);
  assert.equal(ghCalls.at(-1).init.headers.Authorization, 'Bearer ghp_x');
  const ref = await (await req('com', 'POST', `/api/tasks/${task.id}/links/refresh`)).json();
  assert.equal(ref.links[0].estado, 'closed');
  assert.equal((await req('jur', 'DELETE', `/api/links/${ref.links[0].id}`)).status, 404);
  assert.ok(!(await (await req('lec', 'GET', '/api/session')).text()).includes('ghp_x'));
  assert.equal((await (await req('admin', 'POST', '/api/github/import', { repo: 'o/r' })).json()).creadas, 1);
  assert.equal((await (await req('admin', 'POST', '/api/github/import', { repo: 'o/r' })).json()).creadas, 0);
});

test('eliminar deja rastro en la auditoría', async () => {
  const { task } = await (await req('admin', 'POST', '/api/tasks', act({ titulo: 'Borrable' }))).json();
  assert.equal((await req('admin', 'DELETE', `/api/tasks/${task.id}`)).status, 204);
  const fila = await db.get('SELECT accion, actor FROM task_events WHERE task_id = ? ORDER BY id DESC', [task.id]);
  assert.equal(fila.accion, 'eliminar'); assert.equal(fila.actor, 'admin@liva.co');
});

test('configuración de producción y recuperación del admin', async () => {
  const base = { NODE_ENV: 'production', OWNER_TOKEN: 'x'.repeat(12), SESSION_SECRET: 'y'.repeat(16), ADMIN_EMAIL: 'a@b.co', DATABASE_URL: 'postgresql://u:p@host/db' };
  assert.equal(loadConfig(base).prod, true);
  for (const [falta, re] of [['OWNER_TOKEN', /OWNER_TOKEN/], ['SESSION_SECRET', /SESSION_SECRET/], ['ADMIN_EMAIL', /ADMIN_EMAIL/], ['DATABASE_URL', /DATABASE_URL/]]) {
    assert.throws(() => loadConfig({ ...base, [falta]: '' }), re);
  }
  // recuperación: ADMIN_RECOVERY=true restablece la clave del admin a OWNER_TOKEN y fuerza cambio
  const cfg = loadConfig({ ...base, ADMIN_EMAIL: 'admin@liva.co', OWNER_TOKEN: 'recuperada-12345', DATABASE_URL: undefined, NODE_ENV: undefined, ADMIN_RECOVERY: 'true' });
  await sembrarAdmin(db, cfg);
  assert.equal((await login('admin@liva.co', ADMIN_PASS)).status, 401);
  const r = await login('admin@liva.co', 'recuperada-12345');
  assert.equal((await r.json()).user.must_change, true);
});
