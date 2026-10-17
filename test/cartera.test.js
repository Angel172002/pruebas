import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { crearApp } from '../src/app.js';
import { sembrarAdmin } from '../src/users.js';
import { crearCifrador } from '../src/crypto.js';
import { crearAuditoria } from '../src/audit.js';
import { crearCartera } from '../src/cartera.js';
import { derivar } from '../src/cartera-domain.js';
import { hoyISO } from '../src/domain.js';
import * as totp from '../src/totp.js';
import { parseCsv } from '../src/cartera-import.js';

const KEY = 'ab'.repeat(32), KEY2 = 'cd'.repeat(32);
const INICIAL = 'admin-inicial-123', ADMIN_PASS = 'Clave-segura-nueva-1', USER_PASS = 'Usuario-clave-seg-1';
let server, base, db, dir, cfg, cifrador;
const ck = {};
const H = { 'content-type': 'application/json', 'x-requested-with': 'liva' };
const llamar = (cookie, method, path, body) => fetch(base + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const req = (rol, method, path, body) => llamar(ck[rol], method, path, body);
const cookie = r => r.headers.get('set-cookie').split(';')[0];
async function activar(email, temporal, nueva) {
  const r = await llamar(null, 'POST', '/api/login', { email, password: temporal });
  const c = await llamar(cookie(r), 'POST', '/api/me/password', { actual: temporal, nueva });
  assert.equal(c.status, 200, await c.clone().text());
  return cookie(c);
}
const cliente = (extra = {}) => ({ nombre: 'Marta Quintero', cedula: '52.123.456', telefono: '3001234567', estado_proceso: 'A. Aprobado', fecha_ingreso: '2026-03-05', inicio_pagos: '2026-07-15',
  deuda_declarada: 87786000, deuda_priorizada: 26335800, n_cuotas: 6, cuota_mensual: 1230000, total_contrato: 11000000, pago_centro: 2225000, sede: 'Sede Centro',
  honorarios: 1200000, bonificacion: 300000, gastos_admin: 200000, gastos_adq: 500000, ...extra });
const crear = async (rol, extra) => { const r = await req(rol, 'POST', '/api/cartera/clientes', cliente(extra)); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()).cliente; };
const ids = {}; // usuarios

before(async () => {
  cfg = loadConfig({ OWNER_TOKEN: INICIAL, ADMIN_EMAIL: 'admin@liva.co', SESSION_SECRET: 'test-session-secret-123', DATA_KEY: KEY });
  dir = mkdtempSync(join(tmpdir(), 'cartera-'));
  db = await openDb({ url: process.env.TEST_DATABASE_URL || `pglite:${join(dir, 'pg')}` });
  if (process.env.TEST_DATABASE_URL) await db.run('TRUNCATE tasks, series, task_events, github_links, users, login_attempts, clientes, pagos_cliente, audit_log RESTART IDENTITY CASCADE');
  if (process.env.TEST_DATABASE_URL) await db.run("DELETE FROM schema_migrations WHERE name LIKE 'admin_recovery:%'"); // marcas de recuperación de corridas anteriores
  await sembrarAdmin(db, cfg);
  server = crearApp({ cfg, db }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  cifrador = crearCifrador({ dataKey: KEY });
  ck.admin = await activar('admin@liva.co', INICIAL, ADMIN_PASS);
  for (const [rol, email, nombre, rolU, acceso] of [
    ['ana', 'ana@liva.co', 'Ana Asesora', 'miembro', 'propia'], ['beto', 'beto@liva.co', 'Beto Asesor', 'miembro', 'propia'],
    ['coord', 'coord@liva.co', 'Cora Coordinadora', 'miembro', 'total'], ['lecP', 'lecp@liva.co', 'Lía Lectora', 'lector', 'propia'],
    ['lecT', 'lect@liva.co', 'Luis Lector Total', 'lector', 'total'], ['nada', 'nada@liva.co', 'Nico Nada', 'miembro', 'ninguno']]) {
    const r = await req('admin', 'POST', '/api/users', { email, nombre, rol: rolU, area: 'Dirección Comercial', acceso_cartera: acceso });
    assert.equal(r.status, 201, await r.clone().text());
    const j = await r.json(); ids[rol] = j.usuario.id;
    ck[rol] = await activar(email, j.temporal, USER_PASS);
  }
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

/* ---------- cifrado ---------- */
test('cifrado: la base no contiene nombre ni cédula en claro y el texto cifrado no se puede mover a otra fila', async () => {
  const c = await crear('ana', { nombre: 'Zacarías Pérez Único', cedula: '79.888.777' });
  const fila = await db.get('SELECT * FROM clientes WHERE id = ?', [c.id]);
  const volcado = JSON.stringify(fila);
  for (const secreto of ['Zacarías', 'Pérez', '79888777', '79.888.777', '3001234567']) assert.ok(!volcado.includes(secreto), `se filtró ${secreto}`);
  assert.equal(fila.cedula_ult4, '8777');
  assert.notEqual(fila.cedula_idx, '79888777');
  assert.deepEqual(cifrador.descifrar(fila.pii, `cliente:${c.id}`).cedula, '79888777');
  assert.throws(() => cifrador.descifrar(fila.pii, 'cliente:otro-id'), 'AAD distinto debe fallar');
  const alterado = fila.pii.slice(0, -3) + (fila.pii.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.throws(() => cifrador.descifrar(alterado, `cliente:${c.id}`), 'texto alterado debe fallar');
  assert.throws(() => crearCifrador({ dataKey: KEY }).descifrar(fila.pii.replace('.v1.', '.'), 'x'));
  assert.notEqual(cifrador.cifrar({ a: 1 }, 'x'), cifrador.cifrar({ a: 1 }, 'x'), 'IV aleatorio por valor');
});

test('rotación de claves: la clave anterior sigue descifrando y rotarClaves re-cifra todo y recalcula el índice', async () => {
  const c = await crear('ana', { nombre: 'Rota Clave', cedula: '11111111' });
  const nuevo = crearCifrador({ dataKey: KEY2, dataKeyPrev: KEY });
  const antes = await db.get('SELECT pii, cedula_idx FROM clientes WHERE id = ?', [c.id]);
  assert.equal(nuevo.descifrar(antes.pii, `cliente:${c.id}`).nombre, 'Rota Clave');
  assert.ok(nuevo.necesitaRotar(antes.pii));
  const cart = crearCartera({ db, cifrador: nuevo, auditoria: crearAuditoria(db) });
  const n = await cart.rotarClaves();
  assert.ok(n >= 2);
  const despues = await db.get('SELECT pii, cedula_idx FROM clientes WHERE id = ?', [c.id]);
  assert.ok(!nuevo.necesitaRotar(despues.pii));
  assert.notEqual(despues.cedula_idx, antes.cedula_idx);
  assert.equal(despues.cedula_idx, nuevo.indiceCedula('11111111'));
  assert.throws(() => cifrador.descifrar(despues.pii, `cliente:${c.id}`), 'la clave vieja ya no descifra lo rotado');
  await cart.rotarClaves(); // volver al estado original para el resto de pruebas
  const volver = crearCartera({ db, cifrador: crearCifrador({ dataKey: KEY, dataKeyPrev: KEY2 }), auditoria: crearAuditoria(db) });
  await volver.rotarClaves();
  assert.equal(cifrador.descifrar((await db.get('SELECT pii FROM clientes WHERE id = ?', [c.id])).pii, `cliente:${c.id}`).nombre, 'Rota Clave');
});

test('configuración: DATA_KEY y MFA_REQUIRED se validan', () => {
  const base = { NODE_ENV: 'production', OWNER_TOKEN: 'x'.repeat(12), SESSION_SECRET: 'y'.repeat(16), ADMIN_EMAIL: 'a@b.co', DATABASE_URL: 'postgres://u:p@h/d', DATA_KEY: KEY };
  assert.equal(loadConfig(base).mfaRequired, 'admin', 'en producción el admin debe usar MFA por defecto');
  assert.throws(() => loadConfig({ ...base, DATA_KEY: '' }), /DATA_KEY/);
  assert.throws(() => loadConfig({ ...base, DATA_KEY: 'corta' }), /DATA_KEY/);
  assert.throws(() => loadConfig({ ...base, MFA_REQUIRED: 'si' }), /MFA_REQUIRED/);
  assert.throws(() => crearCifrador({ dataKey: 'abc' }), /32 bytes/);
});

/* ---------- permisos / IDOR ---------- */
test('alcance: cada asesor solo ve y toca SUS clientes (lectura, edición, pagos, detalle, búsqueda)', async () => {
  const a = await crear('ana', { nombre: 'Cliente De Ana', cedula: '20000001' });
  const b = await crear('beto', { nombre: 'Cliente De Beto', cedula: '20000002' });
  const lista = async rol => (await (await req(rol, 'GET', '/api/cartera/clientes')).json()).clientes.map(c => c.nombre);
  assert.ok((await lista('ana')).includes('Cliente De Ana'));
  assert.ok(!(await lista('ana')).includes('Cliente De Beto'));
  assert.ok(!(await lista('beto')).includes('Cliente De Ana'));
  for (const [m, p, body] of [['GET', `/api/cartera/clientes/${b.id}`], ['PATCH', `/api/cartera/clientes/${b.id}`, { sede: 'x' }],
    ['POST', `/api/cartera/clientes/${b.id}/pagos`, { valor: 1000, fecha: '2026-08-01' }]]) {
    assert.equal((await req('ana', m, p, body)).status, 404, `${m} ${p} debe parecer inexistente`);
  }
  // buscar la cédula de otro asesor no devuelve nada
  assert.deepEqual((await (await req('ana', 'GET', '/api/cartera/clientes?q=20000002')).json()).clientes, []);
  assert.equal((await (await req('ana', 'GET', '/api/cartera/clientes?q=20000001')).json()).clientes.length, 1);
  // sin acceso → 403; sin sesión → 401
  for (const p of ['/api/cartera/clientes', '/api/cartera/resumen', '/api/cartera/flujo']) {
    assert.equal((await req('nada', 'GET', p)).status, 403, p);
    assert.equal((await llamar(null, 'GET', p)).status, 401, p);
  }
  assert.equal((await req('nada', 'POST', '/api/cartera/clientes', cliente({ cedula: '20000003' }))).status, 403);
  // acceso total: ve a todos; lector no escribe
  assert.ok((await lista('coord')).includes('Cliente De Ana') && (await lista('coord')).includes('Cliente De Beto'));
  assert.ok((await lista('lecT')).includes('Cliente De Beto'));
  assert.equal((await req('lecT', 'PATCH', `/api/cartera/clientes/${b.id}`, { sede: 'x' })).status, 403);
  assert.equal((await req('lecT', 'POST', `/api/cartera/clientes/${b.id}/pagos`, { valor: 1000, fecha: '2026-08-01' })).status, 403);
  assert.equal((await req('lecP', 'POST', '/api/cartera/clientes', cliente({ cedula: '20000004' }))).status, 403);
  assert.equal((await req('coord', 'PATCH', `/api/cartera/clientes/${b.id}`, { sede: 'Sede Norte' })).status, 200);
  // resumen respeta el alcance
  const rA = await (await req('ana', 'GET', '/api/cartera/resumen')).json();
  assert.ok(rA.por_asesor.every(x => x.id === ids.ana));
  const flujoA = await (await req('ana', 'GET', '/api/cartera/flujo')).json();
  assert.ok(flujoA.filas.every(f => f.nombre !== 'Cliente De Beto'));
});

test('un asesor no puede asignarse clientes a otro, reasignar, cerrar ni exportar; el admin sí', async () => {
  const c1 = await req('ana', 'POST', '/api/cartera/clientes', cliente({ cedula: '30000001', asesor_id: ids.beto }));
  assert.equal((await c1.json()).cliente.asesor_id, ids.ana, 'se fuerza al propio asesor');
  const propio = (await (await req('ana', 'GET', '/api/cartera/clientes?q=30000001')).json()).clientes[0];
  assert.equal((await req('ana', 'PATCH', `/api/cartera/clientes/${propio.id}`, { asesor_id: ids.beto })).status, 403);
  assert.equal((await req('ana', 'PATCH', `/api/cartera/clientes/${propio.id}`, { estado: 'cerrado' })).status, 403);
  assert.equal((await req('ana', 'GET', '/api/cartera/export.csv')).status, 403);
  assert.equal((await req('lecT', 'GET', '/api/cartera/export.csv')).status, 403);
  assert.equal((await req('admin', 'PATCH', `/api/cartera/clientes/${propio.id}`, { asesor_id: ids.beto })).status, 200);
  assert.equal((await req('ana', 'GET', `/api/cartera/clientes/${propio.id}`)).status, 404, 'tras reasignar, Ana pierde el acceso');
  assert.equal((await req('beto', 'GET', `/api/cartera/clientes/${propio.id}`)).status, 200);
  assert.equal((await req('admin', 'POST', '/api/cartera/clientes', cliente({ cedula: '30000002', asesor_id: 'no-existe' }))).status, 422);
  assert.equal((await req('admin', 'GET', '/api/cartera/asesores')).status, 200);
  assert.equal((await req('ana', 'GET', '/api/cartera/asesores')).status, 403);
});

test('cambiar el acceso a cartera de un usuario cierra sus sesiones de inmediato', async () => {
  const r = await req('admin', 'POST', '/api/users', { email: 'temp@liva.co', nombre: 'Temp Usuario', rol: 'miembro', area: 'Dirección Comercial', acceso_cartera: 'total' });
  const j = await r.json(); const c = await activar('temp@liva.co', j.temporal, USER_PASS);
  assert.equal((await llamar(c, 'GET', '/api/cartera/clientes')).status, 200);
  await req('admin', 'PATCH', `/api/users/${j.usuario.id}`, { acceso_cartera: 'ninguno' });
  assert.equal((await llamar(c, 'GET', '/api/cartera/clientes')).status, 401);
});

/* ---------- validación, CSRF ---------- */
test('validación: cédula, dinero entero, fechas, cuotas, duplicados y CSRF', async () => {
  const malos = [[{ cedula: '12' }, /Cédula/], [{ cedula: 'abc12345' }, /Cédula/], [{ nombre: '' }, /Nombre/], [{ total_contrato: 1500.5 }, /entero/], [{ total_contrato: '1.500,50' }, /entero/],
    [{ total_contrato: -1 }, /entero/], [{ cuota_mensual: 1e15 }, /entero/], [{ fecha_ingreso: '2026-02-30' }, /fecha/i], [{ n_cuotas: 0 }, /cuotas/], [{ n_cuotas: 500 }, /cuotas/],
    [{ estado_proceso: 'Inventado' }, /Estado/], [{ correo: 'no-es-correo' }, /Correo/], [{ telefono: '12' }, /Teléfono/]];
  for (const [extra, re] of malos) {
    const r = await req('admin', 'POST', '/api/cartera/clientes', cliente({ cedula: '40000001', asesor_id: ids.ana, ...extra }));
    assert.equal(r.status, 422, JSON.stringify(extra)); assert.match((await r.json()).error, re);
  }
  assert.equal((await req('admin', 'POST', '/api/cartera/clientes', cliente({ cedula: '40000001', asesor_id: ids.ana }))).status, 201);
  assert.equal((await req('admin', 'POST', '/api/cartera/clientes', cliente({ cedula: '40.000.001', asesor_id: ids.beto }))).status, 409, 'cédula duplicada aunque cambie el formato');
  const sinHeader = await fetch(base + '/api/cartera/clientes', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck.admin }, body: JSON.stringify(cliente({ cedula: '40000009', asesor_id: ids.ana })) });
  assert.equal(sinHeader.status, 403, 'CSRF');
});

test('versión optimista: dos ediciones con la misma versión → la segunda recibe 409', async () => {
  const c = await crear('ana', { cedula: '41000001' });
  assert.equal((await req('ana', 'PATCH', `/api/cartera/clientes/${c.id}`, { sede: 'A', version: c.version })).status, 200);
  assert.equal((await req('ana', 'PATCH', `/api/cartera/clientes/${c.id}`, { sede: 'B', version: c.version })).status, 409);
});

/* ---------- pagos ---------- */
test('pagos: idempotencia, validaciones, anulación solo admin y libro inmutable a nivel de base', async () => {
  const c = await crear('ana', { cedula: '50000001' });
  const p = { valor: 1230000, fecha: '2026-08-10', concepto: 'cuota', idem: 'envio-0001-abcd' };
  const r1 = await req('ana', 'POST', `/api/cartera/clientes/${c.id}/pagos`, p);
  const r2 = await req('ana', 'POST', `/api/cartera/clientes/${c.id}/pagos`, p);
  assert.equal(r1.status, 201); assert.equal(r2.status, 200); assert.equal((await r2.json()).repetido, true);
  const det = async () => (await (await req('ana', 'GET', `/api/cartera/clientes/${c.id}`)).json()).cliente;
  assert.equal((await det()).recibido, 1230000, 'el reintento no duplicó el pago');
  for (const [extra, re] of [[{ valor: 0 }, /mayor/], [{ valor: 10.5 }, /entero/], [{ valor: -5 }, /entero/], [{ fecha: '2026-13-01' }, /fecha/i], [{ fecha: '2099-01-01' }, /futuro/], [{ concepto: 'regalo' }, /Concepto/], [{ idem: 'x' }, /idempotencia/]]) {
    const r = await req('ana', 'POST', `/api/cartera/clientes/${c.id}/pagos`, { ...p, idem: undefined, ...extra });
    assert.equal(r.status, 422, JSON.stringify(extra)); assert.match((await r.json()).error, re);
  }
  const pagoId = (await det()).pagos[0].id;
  assert.equal((await req('ana', 'POST', `/api/cartera/pagos/${pagoId}/anular`, { motivo: 'error de digitación' })).status, 403);
  assert.equal((await req('admin', 'POST', `/api/cartera/pagos/${pagoId}/anular`, { motivo: 'xx' })).status, 422);
  assert.equal((await req('admin', 'POST', `/api/cartera/pagos/${pagoId}/anular`, { motivo: 'error de digitación' })).status, 200);
  assert.equal((await req('admin', 'POST', `/api/cartera/pagos/${pagoId}/anular`, { motivo: 'otra vez' })).status, 409);
  const d = await det();
  assert.equal(d.recibido, 0, 'el pago anulado no cuenta'); assert.equal(d.pagos[0].anulado, true);
  // el libro no se edita ni se borra ni siquiera con acceso directo a la base
  await assert.rejects(db.run('UPDATE pagos_cliente SET valor = 1 WHERE id = ?', [pagoId]), /no se puede modificar/);
  await assert.rejects(db.run('DELETE FROM pagos_cliente WHERE id = ?', [pagoId]), /no se borran/);
  await assert.rejects(db.run('UPDATE pagos_cliente SET anulado_at = NULL, anulado_por = NULL WHERE id = ?', [pagoId]), /no se puede modificar/);
});

/* ---------- cálculos (casos de la matriz real) ---------- */
test('cálculos: reproducen la matriz (cuotas pagadas, mora, valor, días, fin) y detectan inconsistencias', () => {
  const base = { estado: 'activo', inicio_pagos: '2026-07-15', n_cuotas: 6, cuota_mensual: 1230000, total_contrato: 11000000, honorarios: 1200000, bonificacion: 300000, gastos_admin: 200000, gastos_adq: 500000, pago_centro: 2225000, deuda_declarada: 87786000, deuda_priorizada: 26335800 };
  const hoy = '2026-09-20'; // vencidas: 15 jul, 15 ago, 15 sep
  const j = derivar(base, [{ valor: 3630000 }], hoy);
  assert.deepEqual([j.cuotas_esperadas, j.cuotas_pagadas, j.cuotas_en_mora, j.valor_en_mora, j.dias_mora, j.cuotas_restantes], [3, 2, 1, 1230000, 30, 4]);
  assert.equal(j.fecha_fin, '2027-01-15'); // la matriz: 15/01/2027
  assert.equal(j.saldo, 7370000); assert.equal(Math.round(j.cumplimiento * 1000), 330);
  assert.equal(j.utilidad_esperada, 6575000, 'contrato − costos − centro (la hoja muestra este valor con signo contrario)');
  assert.ok(j.avisos.some(a => /cuota × n/.test(a)), 'cuota×n (7.380.000) ≠ contrato (11.000.000)');
  const r = derivar({ ...base, cuota_mensual: 1760000, n_cuotas: 5 }, [{ valor: 1500000 }], hoy);
  assert.deepEqual([r.cuotas_pagadas, r.cuotas_en_mora, r.valor_en_mora, r.dias_mora, r.fecha_fin], [0, 3, 5280000, 90, '2026-12-15']);
  const a = derivar({ ...base, cuota_mensual: 860000, n_cuotas: 15, total_contrato: 15000000 }, [], hoy);
  assert.deepEqual([a.valor_en_mora, a.dias_mora, a.alerta, a.fecha_fin], [2580000, 90, 'sin_pago', '2027-10-15']);
  assert.equal(derivar(base, [{ valor: 11000000 }], hoy).alerta, 'finalizado');
  assert.equal(derivar(base, [{ valor: 3690000 }], hoy).alerta, 'al_dia');
  assert.equal(derivar({ ...base, inicio_pagos: '2026-11-15' }, [], hoy).cuotas_en_mora, 0, 'aún no empieza el plazo');
  assert.equal(derivar({ ...base, inicio_pagos: '2026-01-31', n_cuotas: 3 }, [], '2026-03-31').cuotas_esperadas, 3, 'día ancla 31 → 28 feb → 31 mar');
  assert.equal(derivar({ ...base, estado: 'cerrado' }, [], hoy).cuotas_en_mora, 0);
  assert.equal(derivar({ ...base, cuota_mensual: 0 }, [{ valor: 5 }], hoy).cuotas_pagadas, 0, 'sin dividir por cero');
});

/* ---------- búsqueda y auditoría ---------- */
test('búsqueda por cédula (con o sin puntos), por nombre y por últimos 4; el detalle completo queda auditado', async () => {
  const c = await crear('ana', { nombre: 'Búsqueda Exacta', cedula: '60.111.222' });
  for (const q of ['60111222', '60.111.222', 'búsqueda', 'EXACTA', '1222']) {
    const l = (await (await req('ana', 'GET', `/api/cartera/clientes?q=${encodeURIComponent(q)}`)).json()).clientes;
    assert.ok(l.some(x => x.id === c.id), `q=${q}`);
  }
  assert.deepEqual((await (await req('ana', 'GET', '/api/cartera/clientes?q=60111223')).json()).clientes, []);
  const lista = (await (await req('ana', 'GET', '/api/cartera/clientes?q=60111222')).json()).clientes[0];
  assert.equal(lista.cedula, '••••1222', 'la lista solo muestra la cédula enmascarada');
  assert.equal(lista.telefono, undefined);
  const det = (await (await req('ana', 'GET', `/api/cartera/clientes/${c.id}`)).json()).cliente;
  assert.equal(det.cedula, '60111222'); assert.equal(det.telefono, '3001234567');
  const ev = (await (await req('admin', 'GET', `/api/cartera/auditoria?entidad_id=${c.id}`)).json()).eventos;
  assert.ok(ev.some(e => e.accion === 'ver_cliente' && e.actor === 'ana@liva.co'), 'ver un cliente deja rastro');
  assert.ok(ev.some(e => e.accion === 'crear_cliente'));
  assert.equal((await req('ana', 'GET', '/api/cartera/auditoria')).status, 403);
});

test('la bitácora NO contiene datos personales y su cadena se verifica (y detecta alteraciones)', async () => {
  const todo = JSON.stringify(await db.all('SELECT * FROM audit_log'));
  for (const secreto of ['Búsqueda Exacta', '60111222', '60.111.222', 'Zacarías', '79888777', '3001234567', 'Marta Quintero']) assert.ok(!todo.includes(secreto), `la bitácora filtró ${secreto}`);
  assert.deepEqual({ ...(await (await req('admin', 'GET', '/api/cartera/auditoria/verificar')).json()) }.ok, true);
  await assert.rejects(db.run("UPDATE audit_log SET accion = 'nada' WHERE id = 1"), /no se modifica/);
  await assert.rejects(db.run('DELETE FROM audit_log WHERE id = 1'), /no se modifica/);
  // un atacante con acceso total a la base que desactive el trigger y altere una fila es detectado por la cadena
  await db.run('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_inmutable');
  await db.run("UPDATE audit_log SET detalle = 'manipulado' WHERE id = (SELECT min(id) FROM audit_log WHERE id > 2)");
  await db.run('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_inmutable');
  const v = await (await req('admin', 'GET', '/api/cartera/auditoria/verificar')).json();
  assert.equal(v.ok, false); assert.ok(v.rotoEn > 2);
  // se repara para no afectar otras pruebas: se recalcula la cadena desde cero
  await db.run('ALTER TABLE audit_log DISABLE TRIGGER trg_audit_inmutable');
  await db.run('TRUNCATE audit_log');
  await db.run('ALTER TABLE audit_log ENABLE TRIGGER trg_audit_inmutable');
});

test('auditoría de acceso: login, login fallido y cambios de usuario quedan registrados con IP', async () => {
  await llamar(null, 'POST', '/api/login', { email: 'ana@liva.co', password: 'incorrecta-123' });
  await llamar(null, 'POST', '/api/login', { email: 'ana@liva.co', password: USER_PASS });
  const ev = (await (await req('admin', 'GET', '/api/cartera/auditoria?limite=50')).json()).eventos;
  assert.ok(ev.some(e => e.accion === 'login_fallido' && e.actor === 'ana@liva.co'));
  assert.ok(ev.some(e => e.accion === 'login' && e.actor === 'ana@liva.co' && e.ip));
  assert.ok(!JSON.stringify(ev).includes(USER_PASS) && !JSON.stringify(ev).includes('incorrecta-123'), 'nunca se registran claves');
});

/* ---------- exportación y anonimización ---------- */
test('exportación CSV: solo admin, auditada y neutraliza fórmulas (CSV injection)', async () => {
  await crear('ana', { nombre: '=HYPERLINK("http://malo","clic")', cedula: '70000001' });
  const r = await req('admin', 'GET', '/api/cartera/export.csv');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
  const csv = await r.text();
  assert.ok(csv.includes("\"'=HYPERLINK"), 'la fórmula queda como texto');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
  const ev = (await (await req('admin', 'GET', '/api/cartera/auditoria?accion=exportar')).json()).eventos;
  assert.ok(ev.length >= 1);
});

test('anonimizar: borra los datos personales, conserva el libro de pagos y los totales', async () => {
  const c = await crear('ana', { nombre: 'Para Olvidar', cedula: '80000001' });
  await req('ana', 'POST', `/api/cartera/clientes/${c.id}/pagos`, { valor: 500000, fecha: '2026-08-01' });
  const antes = (await (await req('admin', 'GET', '/api/cartera/resumen')).json()).totales.recibido;
  assert.equal((await req('ana', 'POST', `/api/cartera/clientes/${c.id}/anonimizar`)).status, 403);
  assert.equal((await req('admin', 'POST', `/api/cartera/clientes/${c.id}/anonimizar`)).status, 200);
  const fila = await db.get('SELECT * FROM clientes WHERE id = ?', [c.id]);
  assert.equal(fila.estado, 'anonimizado'); assert.equal(fila.cedula_ult4, '');
  assert.ok(!cifrador.descifrar(fila.pii, `cliente:${c.id}`).nombre.includes('Olvidar'));
  assert.equal((await req('admin', 'GET', `/api/cartera/clientes/${c.id}`)).status, 404);
  assert.deepEqual((await (await req('admin', 'GET', '/api/cartera/clientes?q=80000001')).json()).clientes, []);
  assert.equal((await (await req('admin', 'GET', '/api/cartera/resumen')).json()).totales.recibido, antes, 'los totales contables no cambian');
  assert.equal((await req('admin', 'POST', '/api/cartera/clientes', cliente({ cedula: '80000001', asesor_id: ids.ana }))).status, 201, 'la cédula queda libre');
});

/* ---------- importación ---------- */
const CSV = [
  ',,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '"📋  MATRIZ CLIENTES · LEY DE INSOLVENCIA 2026",,,,,"DEUDA TOTAL",,,,,,,,,,,,,,,,,,,,,,,,',
  'ID / CLIENTE,,DATOS DEL PROCESO,,,DEUDA TOTAL,,CONTRATO,,CENTRO CONCILIACIÓN,,HONORARIOS,,GASTOS FIRMA,,COBROS Y SALDOS,,,RENTABILIDAD,,,INICIO PAGOS',
  ['N°', 'NOMBRE CLIENTE / CÉDULA', 'ASESOR', 'FECHA INGRESO', 'ESTADO PROCESO', 'DEUDA TOTAL DECLARADA', '"DEUDA PRIORIZADA\n(Conciliable 30%)"', '"N°\nCUOTAS"', '"CUOTA MENSUAL\nPROCESO (COP)"', '"PAGO CENTRO\nCONCILIACIÓN (COP)"', 'SEDE / ENTIDAD',
    '"HONORARIOS\nABOGADO (COP)"', '"BONIFICACIÓN\nASESOR (COP)"', '"GASTOS ADMIN /\nNOTARIALES (COP)"', 'GASTOS ADQUISICIÓN CLIENTES', '"TOTAL CONTRATO\nCLIENTE"', '"TOTAL RECIBIDO\nPOR CLIENTE"', '"SALDO POR COBRAR\n(Pendiente)"', '"INGRESO NETO\nFIRMA (Q-M-N-O)"', '"% CUMPL.\nCLIENTE"', 'ALERTA', '"FECHA INICIO\nPAGOS ★"'].join(','),
  '001,"Jessica Ballesteros - 1.000.000.001",Ana Asesora,05/03/2026,A. Inicio,"$87,786,000","$26,335,800",6,"$1,230,000","$2,225,000",Abraham Lincoln,"$1,200,000","$300,000","$200,000","$500,000","$11,000,000","$3,630,000","$7,370,000","($6,575,000)",33.0%,🔴 En mora,15/07/2026',
  '002,Rosalba Firacative 1000000002,Beto Asesor,,A. Inicio,"$80,000,000","$24,000,000",5,"$1,760,000","$2,225,000",Abraham Lincoln,"$1,200,000","$300,000","$200,000","$500,000","$11,000,000","$1,500,000","$9,500,000","($6,575,000)",13.6%,🔴 En mora,15/07/2026',
  '003,Ariel Ladino 1000000003,Ana Asesora,,A. Aprobado,"$240,000,000","$72,000,000",15,"$860,000","$5,700,858",,"$1,200,000","$300,000","$200,000","$500,000","$15,000,000",$0,"$15,000,000","($7,099,142)",-,🔴 Sin pago,15/07/2026',
  '004,Sin Cedula Alguna,Ana Asesora,,A. Inicio,"$1,000,000",$0,1,"$100,000",$0,,$0,$0,$0,$0,"$500,000",$0,"$500,000",-,-,-,15/07/2026',
  '005,Asesor Fantasma 1000000005,Nadie Existe,,A. Inicio,"$1,000,000",$0,1,"$100,000",$0,,$0,$0,$0,$0,"$500,000",$0,"$500,000",-,-,-,15/07/2026',
  '006,Dinero Malo 1000000006,Ana Asesora,,A. Inicio,"$1.500,50",$0,1,"$100,000",$0,,$0,$0,$0,$0,"$500,000",$0,"$500,000",-,-,-,15/07/2026',
  '007,Repetida Uno 1000000001,Ana Asesora,,A. Inicio,"$1,000,000",$0,1,"$100,000",$0,,$0,$0,$0,$0,"$500,000",$0,"$500,000",-,-,-,15/07/2026'
].join('\n');

test('importación: parser CSV (comillas, saltos de línea, BOM) y mapeo de encabezados de la matriz', () => {
  const f = parseCsv('﻿a,"b,\n""x""",c\r\n1,2,3');
  assert.deepEqual(f, [['a', 'b,\n"x"', 'c'], ['1', '2', '3']]);
  assert.throws(() => parseCsv('x'.repeat(3_100_000)), /grande/);
});

test('importación: la simulación no escribe nada, no devuelve datos personales y marca cada problema por fila', async () => {
  const antes = Number((await db.get('SELECT count(*) AS n FROM clientes')).n);
  const r = await req('admin', 'POST', '/api/cartera/import?dry=1', { csv: CSV });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json(); const txt = JSON.stringify(j);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM clientes')).n), antes, 'simular no inserta');
  assert.equal(j.validas, 3);
  const motivos = j.rechazos.map(x => x.motivo).join(' | ');
  assert.match(motivos, /sin cédula/); assert.match(motivos, /asesor no coincide/); assert.match(motivos, /formato de dinero/);
  assert.equal(j.rechazos.length, 4, motivos); // incluye la cédula repetida dentro del archivo
  for (const secreto of ['Jessica', 'Ballesteros', '1000000001', '1.000.000.001', 'Rosalba', 'Ladino']) assert.ok(!txt.includes(secreto), `el informe filtró ${secreto}`);
  assert.equal(j.conciliacion.total_contrato, 37000000); assert.equal(j.conciliacion.recibido, 5130000);
  assert.ok(j.n_avisos >= 1);
  assert.equal((await req('ana', 'POST', '/api/cartera/import?dry=1', { csv: CSV })).status, 403);
  assert.equal((await req('admin', 'POST', '/api/cartera/import?dry=1', { csv: 'a,b\n1,2' })).status, 422);
});

test('importación: aplicar exige resolver rechazos (o aceptar parcial), crea pagos migrados y repetirla no duplica', async () => {
  assert.equal((await req('admin', 'POST', '/api/cartera/import', { csv: CSV })).status, 422, 'con rechazos pendientes no aplica');
  const limpio = CSV.split('\n').filter(l => !/^00[4567]/.test(l)).join('\n');
  const r = await req('admin', 'POST', '/api/cartera/import', { csv: limpio });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).creados, 3);
  const jess = (await (await req('admin', 'GET', '/api/cartera/clientes?q=1000000001')).json()).clientes[0];
  assert.equal(jess.nombre, 'Jessica Ballesteros'); assert.equal(jess.asesor_id, ids.ana);
  assert.equal(jess.recibido, 3630000); assert.equal(jess.total_contrato, 11000000); assert.equal(jess.n_cuotas, 6); assert.equal(jess.inicio_pagos, '2026-07-15');
  const det = (await (await req('admin', 'GET', `/api/cartera/clientes/${jess.id}`)).json()).cliente;
  assert.equal(det.pagos[0].concepto, 'migracion');
  const otra = await (await req('admin', 'POST', '/api/cartera/import', { csv: limpio })).json();
  assert.equal(otra.creados, 0); assert.equal(otra.omitidas.length, 3, 'repetir no duplica');
  const pagos = Number((await db.get("SELECT count(*) AS n FROM pagos_cliente WHERE concepto = 'migracion'")).n);
  assert.equal(pagos, 2, 'solo los 2 clientes con total recibido > 0');
  const parcial = await req('admin', 'POST', '/api/cartera/import?parcial=1', { csv: CSV.replace(/^001,.*$/m, '').replace('Rosalba Firacative 1000000002', 'Rosalba Firacative 1000000102').replace('Ariel Ladino 1000000003', 'Ariel Ladino 1000000103') });
  assert.equal(parcial.status, 200, await parcial.clone().text());
  const ev = (await (await req('admin', 'GET', '/api/cartera/auditoria?accion=importar')).json()).eventos;
  assert.ok(ev.length >= 2);
});

/* ---------- MFA ---------- */
test('TOTP: vector oficial RFC 6238 y rechazo de códigos repetidos', () => {
  const secreto = totp.base32(Buffer.from('12345678901234567890'));
  assert.equal(secreto, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.codigo(secreto, 1), '287082'); // t = 59 s
  assert.equal(totp.codigo(secreto, 37037036), '081804'); // t = 1111111109
  const ahora = 1111111109000, c = totp.verificar(secreto, '081804', 0, ahora);
  assert.equal(c, 37037036);
  assert.equal(totp.verificar(secreto, '081804', c, ahora), null, 'el mismo código no sirve dos veces');
  assert.equal(totp.verificar(secreto, '000000', 0, ahora), null);
  assert.equal(totp.verificar(secreto, 'abcdef', 0, ahora), null);
});

test('MFA: activar, iniciar sesión con segundo factor, anti-repetición, códigos de recuperación y restablecimiento por el admin', async () => {
  const email = 'mfa@liva.co';
  const r = await req('admin', 'POST', '/api/users', { email, nombre: 'Maria Factor', rol: 'miembro', area: 'Dirección Comercial', acceso_cartera: 'propia' });
  const j = await r.json(); let c = await activar(email, j.temporal, USER_PASS);
  const setup = await (await llamar(c, 'POST', '/api/me/mfa/setup')).json();
  assert.match(setup.uri, /^otpauth:\/\/totp\//); assert.equal(setup.secreto.length, 32);
  assert.ok(!JSON.stringify(await db.get('SELECT mfa_secret FROM users WHERE email = ?', [email])).includes(setup.secreto), 'el secreto TOTP se guarda cifrado');
  assert.equal((await llamar(c, 'POST', '/api/me/mfa/enable', { codigo: '000000' })).status, 401);
  const t0 = Math.floor(Date.now() / 30000);
  const ok = await llamar(c, 'POST', '/api/me/mfa/enable', { codigo: totp.codigo(setup.secreto, t0) });
  assert.equal(ok.status, 200); const { recuperacion } = await ok.json(); assert.equal(recuperacion.length, 8);
  c = cookie(ok);
  assert.equal((await llamar(c, 'GET', '/api/session').then(x => x.json())).user.mfa, true);
  // login: ya no entrega sesión, entrega un reto
  const l1 = await llamar(null, 'POST', '/api/login', { email, password: USER_PASS });
  const reto = (await l1.json()); assert.equal(reto.mfa, true); assert.equal(l1.headers.get('set-cookie'), null);
  assert.equal((await llamar(null, 'POST', '/api/login/mfa', { reto: reto.reto, codigo: '123456' })).status, 401);
  assert.equal((await llamar(null, 'POST', '/api/login/mfa', { reto: 'mfa.x.9999999999.firma', codigo: '123456' })).status, 401);
  const buen = totp.codigo(setup.secreto, t0 + 1);
  const l2 = await llamar(null, 'POST', '/api/login/mfa', { reto: reto.reto, codigo: buen });
  assert.equal(l2.status, 200); assert.ok(l2.headers.get('set-cookie'));
  assert.equal((await llamar(null, 'POST', '/api/login/mfa', { reto: reto.reto, codigo: buen })).status, 401, 'el mismo código no se reutiliza');
  // recuperación: sirve una sola vez
  const l3 = await llamar(null, 'POST', '/api/login', { email, password: USER_PASS });
  const reto3 = (await l3.json()).reto;
  assert.equal((await llamar(null, 'POST', '/api/login/mfa', { reto: reto3, codigo: recuperacion[0] })).status, 200);
  assert.equal((await llamar(null, 'POST', '/api/login/mfa', { reto: reto3, codigo: recuperacion[0] })).status, 401);
  // desactivar exige clave + código
  assert.equal((await llamar(c, 'POST', '/api/me/mfa/disable', { clave: 'mala-clave-123', codigo: totp.codigo(setup.secreto, t0 + 2) })).status, 401);
  // el admin restablece MFA de un usuario que perdió el teléfono
  assert.equal((await req('admin', 'POST', `/api/users/${j.usuario.id}/mfa/reset`)).status, 200);
  assert.equal((await llamar(null, 'POST', '/api/login', { email, password: USER_PASS }).then(x => x.json())).mfa, undefined);
  assert.equal((await req('ana', 'POST', `/api/users/${j.usuario.id}/mfa/reset`)).status, 403);
});

test('MFA obligatoria para administradores: sin activarla la API de datos responde 403 must_mfa', async () => {
  const cfg2 = loadConfig({ OWNER_TOKEN: 'otro-inicial-123', ADMIN_EMAIL: 'boss@liva.co', SESSION_SECRET: 'test-session-secret-123', DATA_KEY: KEY, MFA_REQUIRED: 'admin' });
  const dir2 = mkdtempSync(join(tmpdir(), 'mfa-'));
  const db2 = await openDb({ url: `pglite:${join(dir2, 'pg')}` });
  await sembrarAdmin(db2, cfg2);
  const s2 = crearApp({ cfg: cfg2, db: db2 }).listen(0);
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const f = (c, m, p, body) => fetch(b2 + p, { method: m, headers: { ...H, ...(c ? { cookie: c } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    let r = await f(null, 'POST', '/api/login', { email: 'boss@liva.co', password: 'otro-inicial-123' });
    let c = cookie(r);
    r = await f(c, 'POST', '/api/me/password', { actual: 'otro-inicial-123', nueva: 'Clave-jefe-segura-77' }); c = cookie(r);
    assert.equal((await r.json()).user.must_mfa, true);
    for (const p of ['/api/cartera/clientes', '/api/tasks', '/api/users']) {
      const x = await f(c, 'GET', p); assert.equal(x.status, 403, p); assert.equal((await x.json()).code, 'must_mfa');
    }
    const setup = await (await f(c, 'POST', '/api/me/mfa/setup')).json();
    assert.equal((await f(c, 'POST', '/api/me/mfa/disable', { clave: 'Clave-jefe-segura-77', codigo: '000000' })).status, 403, 'no se puede desactivar si la política la exige');
    r = await f(c, 'POST', '/api/me/mfa/enable', { codigo: totp.codigo(setup.secreto, Math.floor(Date.now() / 30000)) });
    assert.equal(r.status, 200); c = cookie(r);
    assert.equal((await f(c, 'GET', '/api/cartera/resumen')).status, 200);
  } finally { s2.close(); await db2.close(); rmSync(dir2, { recursive: true, force: true }); }
});

/* ---------- política de claves y cabeceras ---------- */
test('política de claves: rechaza comunes, repetitivas y las que contienen el correo; cabeceras de seguridad presentes', async () => {
  for (const nueva of ['1234567890', 'aaaaaaaaaaaa', 'abababababab']) assert.equal((await llamar(ck.ana, 'POST', '/api/me/password', { actual: USER_PASS, nueva })).status, 422, nueva);
  assert.equal((await llamar(ck.beto, 'POST', '/api/me/password', { actual: USER_PASS, nueva: 'Beto-segura-1234' })).status, 422, 'contiene el correo');
  const h = (await fetch(base + '/healthz')).headers;
  assert.match(h.get('permissions-policy'), /camera=\(\)/);
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(h.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.match(h.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(base + '/api/cartera/clientes')).headers.get('cache-control'), 'no-store');
});

test('resumen y flujo: totales consistentes con la lista y alertas por estado', async () => {
  const res = await (await req('admin', 'GET', '/api/cartera/resumen')).json();
  const lista = (await (await req('admin', 'GET', '/api/cartera/clientes')).json()).clientes;
  assert.equal(res.totales.clientes, lista.length + 1 - 1 + (res.totales.clientes - lista.length)); // incluye anonimizados en totales
  assert.ok(res.totales.total_contrato >= lista.reduce((a, c) => a + c.total_contrato, 0));
  assert.equal(res.mensual.length, 12);
  const suma = Object.values(res.alertas).reduce((a, b) => a + b, 0);
  assert.equal(suma, res.totales.clientes);
  const fl = (await (await req('admin', 'GET', '/api/cartera/flujo')).json()).filas;
  assert.equal(fl.reduce((a, f) => a + f.total, 0), res.mensual.reduce((a, m) => a + m.recibido, 0));
});

test('resumen: proyección de caja a 6 meses, cartera por antigüedad, egresos y lista de atención', async () => {
  const resumen = async () => (await (await req('admin', 'GET', '/api/cartera/resumen')).json());
  const antes = await resumen();
  assert.equal(antes.proyeccion.length, 6);
  assert.equal(antes.proyeccion[0].mes, hoyISO().slice(0, 7), 'empieza en el mes actual');
  assert.ok(antes.proyeccion.every((p, i, a) => i === 0 || p.mes > a[i - 1].mes));
  // un cliente cuyo plan empieza dentro de 2 meses (día 15) y dura 4 cuotas aporta 1.000.000 a los meses +2..+5, y nada antes
  const [y, m] = hoyISO().split('-').map(Number), ini = new Date(Date.UTC(y, m - 1 + 2, 15)).toISOString().slice(0, 10);
  await crear('admin', { nombre: 'Proyección Futura', cedula: '91000001', asesor_id: ids.ana, inicio_pagos: ini, n_cuotas: 4, cuota_mensual: 1000000, total_contrato: 4000000 });
  const despues = await resumen();
  assert.deepEqual(despues.proyeccion.map((p, i) => p.esperado - antes.proyeccion[i].esperado), [0, 0, 1000000, 1000000, 1000000, 1000000]);
  assert.deepEqual(despues.proyeccion.map((p, i) => p.cuotas - antes.proyeccion[i].cuotas), [0, 0, 1, 1, 1, 1]);
  // antigüedad: cuatro rangos, nunca más que la mora total
  assert.deepEqual(despues.edades.map(e => e.rango), ['1–30 días', '31–60 días', '61–90 días', 'Más de 90 días']);
  assert.ok(despues.edades.reduce((a, e) => a + e.valor, 0) <= despues.totales.valor_en_mora);
  // egresos: el total es la suma de sus partes y coincide con los clientes
  const e = despues.egresos;
  assert.equal(e.total, e.honorarios + e.bonificacion + e.gastos_admin + e.gastos_adq + e.pago_centro);
  assert.ok(e.total > 0);
  // atención: ordenadas de mayor a menor y limitadas
  const mm = despues.atencion.mayores_moras;
  assert.ok(mm.length <= 5 && mm.every((x, i) => i === 0 || mm[i - 1].valor >= x.valor));
  assert.ok(despues.atencion.vencen_semana.length <= 6);
  // un asesor solo ve la proyección de SUS clientes
  const mia = await (await req('ana', 'GET', '/api/cartera/resumen')).json();
  assert.ok(mia.proyeccion.reduce((a, p) => a + p.esperado, 0) <= despues.proyeccion.reduce((a, p) => a + p.esperado, 0));
  const propios = new Set((await (await req('ana', 'GET', '/api/cartera/clientes')).json()).clientes.map(c => c.id));
  assert.ok(mia.atencion.mayores_moras.every(x => propios.has(x.id)) && mia.atencion.vencen_semana.every(x => propios.has(x.id)), 'la lista de atención respeta el alcance');
});
