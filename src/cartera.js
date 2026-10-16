import { randomBytes, randomUUID } from 'node:crypto';
import { enmascarar } from './crypto.js';
import { derivar, totales, validarCliente, validarPago, vencimientos, ValidacionError } from './cartera-domain.js';
import { hoyISO } from './domain.js';
import { RANGO } from './auth.js';

export class CarteraError extends Error { constructor(m, status = 422) { super(m); this.status = status; } }
const ahora = () => new Date().toISOString();
const COLS = ['estado_proceso', 'fecha_ingreso', 'inicio_pagos', 'deuda_declarada', 'deuda_priorizada', 'n_cuotas', 'cuota_mensual', 'total_contrato',
  'pago_centro', 'sede', 'honorarios', 'bonificacion', 'gastos_admin', 'gastos_adq'];

/**
 * Alcance de un usuario sobre la cartera (UNA sola regla, usada por todas las consultas):
 *  admin → todo · acceso 'total' → todo · acceso 'propia' → solo sus clientes · 'ninguno' → nada.
 * Escribir exige además rol miembro o admin (el lector nunca escribe).
 */
export function alcance(u) {
  const nivel = u.rol === 'admin' ? 'total' : u.acceso_cartera || 'ninguno';
  return { nivel, todo: nivel === 'total', propia: nivel === 'propia', escribe: RANGO[u.rol] >= RANGO.miembro && nivel !== 'ninguno', admin: u.rol === 'admin' };
}

export function crearCartera({ db, cifrador, auditoria }) {
  const aad = id => `cliente:${id}`;
  const abrir = f => ({ ...cifrador.descifrar(f.pii, aad(f.id)) });

  async function asesores() {
    return new Map((await db.all('SELECT id, nombre, email FROM users')).map(u => [u.id, u]));
  }
  /** Filas (cifradas) dentro del alcance del usuario. Nunca devuelve clientes ajenos a un asesor 'propia'. */
  async function filasVisibles(u, { id, incluirAnon = false } = {}) {
    const a = alcance(u);
    if (a.nivel === 'ninguno') throw new CarteraError('No tienes acceso a la cartera.', 403);
    const w = [], args = [];
    if (a.propia) { w.push('asesor_id = ?'); args.push(u.id); }
    if (id) { w.push('id = ?'); args.push(id); }
    if (!incluirAnon) w.push("estado <> 'anonimizado'");
    return db.all(`SELECT * FROM clientes ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY numero`, args);
  }
  async function pagosDe(ids, { conAnulados = false } = {}) {
    if (!ids.length) return new Map();
    const filas = await db.all(`SELECT * FROM pagos_cliente WHERE cliente_id IN (${ids.map(() => '?').join(',')}) ${conAnulados ? '' : 'AND anulado_at IS NULL'} ORDER BY fecha DESC, created_at DESC`, ids);
    const m = new Map(ids.map(i => [i, []]));
    filas.forEach(p => m.get(p.cliente_id).push(p));
    return m;
  }
  const publicoLista = (f, pii, d, ase) => ({
    id: f.id, numero: f.numero, nombre: pii.nombre, cedula: enmascarar(pii.cedula), asesor_id: f.asesor_id, asesor: ase.get(f.asesor_id)?.nombre || '—',
    estado: f.estado, estado_proceso: f.estado_proceso, ...Object.fromEntries(COLS.map(k => [k, f[k]])), version: f.version, ...d
  });

  async function listar(u, { q = '', incluirAnon = false } = {}, ctx = {}) {
    const filas = await filasVisibles(u, { incluirAnon });
    const [pagos, ase] = [await pagosDe(filas.map(f => f.id)), await asesores()];
    const hoy = hoyISO();
    let out = filas.map(f => publicoLista(f, abrir(f), derivar(f, pagos.get(f.id), hoy), ase));
    const t = String(q).trim().toLowerCase();
    if (t) {
      const dig = t.replace(/\D/g, '');
      const idx = dig.length >= 5 ? [cifrador.indiceCedula(dig), ...cifrador.indicesCedulaPrevios(dig)] : [];
      const porId = new Map(filas.map(f => [f.id, f]));
      out = out.filter(c => c.nombre.toLowerCase().includes(t) || idx.includes(porId.get(c.id).cedula_idx) || (dig.length === 4 && porId.get(c.id).cedula_ult4 === dig));
      await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'buscar', entidad: 'cliente', detalle: `${idx.length ? 'por cédula' : 'por nombre'}: ${out.length} resultado(s)`, ip: ctx.ip });
    }
    return out;
  }

  async function obtener(u, id, ctx = {}) {
    const [f] = await filasVisibles(u, { id });
    if (!f) return null; // fuera de alcance == no existe
    const pii = abrir(f), ase = await asesores();
    const todos = (await pagosDe([f.id], { conAnulados: true })).get(f.id);
    const d = derivar(f, todos.filter(p => !p.anulado_at), hoyISO());
    await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'ver_cliente', entidad: 'cliente', entidad_id: f.id, ip: ctx.ip });
    return { ...publicoLista(f, pii, d, ase), cedula: pii.cedula, telefono: pii.telefono || '', correo: pii.correo || '', notas: pii.notas || '', fecha_ingreso: f.fecha_ingreso,
      pagos: todos.map(p => ({ id: p.id, fecha: p.fecha, valor: p.valor, concepto: p.concepto, nota: p.nota, registrado_por: p.registrado_por, anulado: Boolean(p.anulado_at), motivo_anulacion: p.motivo_anulacion })) };
  }

  async function validarAsesor(id) {
    const a = await db.get('SELECT id, activo FROM users WHERE id = ?', [id]);
    if (!a || !a.activo) throw new CarteraError('El asesor indicado no existe o está inactivo.');
  }

  async function insertar(x, id, pii, cols) {
    const ts = ahora();
    await x.run(`INSERT INTO clientes(id,pii,cedula_idx,cedula_ult4,asesor_id,estado_proceso,fecha_ingreso,inicio_pagos,deuda_declarada,deuda_priorizada,n_cuotas,cuota_mensual,total_contrato,
      pago_centro,sede,honorarios,bonificacion,gastos_admin,gastos_adq,created_at,updated_at)
      VALUES (@id,@pii,@idx,@u4,@asesor_id,@estado_proceso,@fecha_ingreso,@inicio_pagos,@deuda_declarada,@deuda_priorizada,@n_cuotas,@cuota_mensual,@total_contrato,@pago_centro,@sede,@honorarios,@bonificacion,@gastos_admin,@gastos_adq,@ts,@ts)`,
      { id, pii: cifrador.cifrar(pii, aad(id)), idx: cifrador.indiceCedula(pii.cedula), u4: pii.cedula.slice(-4), ts, estado_proceso: 'A. Inicio', fecha_ingreso: null, inicio_pagos: null, sede: '',
        deuda_declarada: 0, deuda_priorizada: 0, n_cuotas: 1, cuota_mensual: 0, total_contrato: 0, pago_centro: 0, honorarios: 0, bonificacion: 0, gastos_admin: 0, gastos_adq: 0, ...cols });
  }

  async function crear(u, body, ctx = {}) {
    const a = alcance(u);
    if (!a.escribe) throw new CarteraError('No tienes permiso para crear clientes.', 403);
    const { pii, cols } = validarCliente({ ...body, asesor_id: a.admin ? body?.asesor_id : u.id });
    await validarAsesor(cols.asesor_id);
    const id = randomUUID();
    try {
      await db.tx(async x => {
        await insertar(x, id, pii, cols);
        await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'crear_cliente', entidad: 'cliente', entidad_id: id, ip: ctx.ip }, x);
      });
    } catch (e) { if (e.code === '23505') throw new CarteraError('Ya existe un cliente con esa cédula.', 409); throw e; }
    return obtener(u, id, ctx);
  }

  async function actualizar(u, id, body, ctx = {}) {
    const a = alcance(u);
    const [f] = await filasVisibles(u, { id });
    if (!f) throw new CarteraError('No existe.', 404);
    if (!a.escribe) throw new CarteraError('No tienes permiso para modificar clientes.', 403);
    const { pii: nuevoPii, cols } = validarCliente(body, { parcial: true });
    if (cols.asesor_id !== undefined) { // reasignar es decisión de administración
      if (!a.admin) throw new CarteraError('Solo el administrador reasigna asesores.', 403);
      await validarAsesor(cols.asesor_id);
    }
    if (body.estado !== undefined) {
      if (!a.admin) throw new CarteraError('Solo el administrador cierra o reabre procesos.', 403);
      if (!['activo', 'cerrado'].includes(body.estado)) throw new CarteraError('Estado inválido.');
      cols.estado = body.estado;
    }
    if (Number.isInteger(body.version) && body.version !== f.version) throw new CarteraError('Alguien más modificó este cliente. Recarga para ver la última versión.', 409);
    const pii = { ...abrir(f), ...nuevoPii };
    const set = { ...cols, pii: cifrador.cifrar(pii, aad(id)) };
    if (nuevoPii.cedula !== undefined) { set.cedula_idx = cifrador.indiceCedula(pii.cedula); set.cedula_ult4 = pii.cedula.slice(-4); }
    const claves = Object.keys(set);
    try {
      await db.tx(async x => {
        const r = await x.run(`UPDATE clientes SET ${claves.map(k => `${k} = @${k}`).join(', ')}, version = version + 1, updated_at = @ts WHERE id = @id AND version = @v`, { ...set, ts: ahora(), id, v: f.version });
        if (!r.changes) throw new CarteraError('Alguien más modificó este cliente. Recarga para ver la última versión.', 409);
        await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'editar_cliente', entidad: 'cliente', entidad_id: id,
          detalle: 'campos: ' + [...Object.keys(nuevoPii), ...Object.keys(cols)].join(', '), ip: ctx.ip }, x);
      });
    } catch (e) { if (e.code === '23505') throw new CarteraError('Ya existe un cliente con esa cédula.', 409); throw e; }
    return obtener(u, id, ctx);
  }

  async function registrarPago(u, clienteId, body, ctx = {}) {
    const a = alcance(u);
    const [f] = await filasVisibles(u, { id: clienteId });
    if (!f) throw new CarteraError('No existe.', 404);
    if (!a.escribe) throw new CarteraError('No tienes permiso para registrar pagos.', 403);
    if (f.estado !== 'activo') throw new CarteraError('El cliente no está activo.');
    const v = validarPago(body);
    const id = randomUUID();
    if (v.idem) { // reintento del mismo envío: devuelve el pago ya guardado, sin duplicar
      const previo = await db.get('SELECT * FROM pagos_cliente WHERE idem = ?', [v.idem]);
      if (previo) { if (previo.cliente_id !== clienteId) throw new CarteraError('Clave de idempotencia ya usada.', 409); return { id: previo.id, repetido: true }; }
    }
    await db.tx(async x => {
      await x.run('INSERT INTO pagos_cliente(id,cliente_id,fecha,valor,concepto,nota,idem,registrado_por,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, clienteId, v.fecha, v.valor, v.concepto, v.nota, v.idem, u.email, ahora()]);
      await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'registrar_pago', entidad: 'cliente', entidad_id: clienteId, detalle: `pago ${id} · ${v.concepto} · $${v.valor}`, ip: ctx.ip }, x);
    });
    return { id, repetido: false };
  }

  async function anularPago(u, pagoId, motivo, ctx = {}) {
    if (!alcance(u).admin) throw new CarteraError('Solo el administrador anula pagos.', 403);
    const m = String(motivo ?? '').trim();
    if (m.length < 5 || m.length > 300) throw new CarteraError('Indica el motivo de la anulación (5 a 300 caracteres).');
    const p = await db.get('SELECT * FROM pagos_cliente WHERE id = ?', [pagoId]);
    if (!p) throw new CarteraError('No existe.', 404);
    if (p.anulado_at) throw new CarteraError('Ese pago ya está anulado.', 409);
    await db.tx(async x => {
      await x.run('UPDATE pagos_cliente SET anulado_at = ?, anulado_por = ?, motivo_anulacion = ? WHERE id = ?', [ahora(), u.email, m, pagoId]);
      await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'anular_pago', entidad: 'cliente', entidad_id: p.cliente_id, detalle: `pago ${pagoId} · $${p.valor}`, ip: ctx.ip }, x);
    });
  }

  /** Derecho de supresión: borra los datos personales y conserva el libro de pagos para la contabilidad. Irreversible. */
  async function anonimizar(u, id, ctx = {}) {
    if (!alcance(u).admin) throw new CarteraError('Solo el administrador anonimiza clientes.', 403);
    const [f] = await filasVisibles(u, { id });
    if (!f) throw new CarteraError('No existe.', 404);
    await db.tx(async x => {
      await x.run("UPDATE clientes SET pii = ?, cedula_idx = ?, cedula_ult4 = '', estado = 'anonimizado', version = version + 1, updated_at = ? WHERE id = ?",
        [cifrador.cifrar({ nombre: `Cliente anonimizado ${f.numero}`, cedula: '' }, aad(id)), 'anon:' + randomBytes(16).toString('hex'), ahora(), id]);
      await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'anonimizar_cliente', entidad: 'cliente', entidad_id: id, ip: ctx.ip }, x);
    });
  }

  async function resumen(u) {
    const lista = await listar(u, { incluirAnon: true });
    const ase = [...new Map(lista.map(c => [c.asesor_id, c.asesor]))];
    const mes = Array.from({ length: 12 }, () => ({ recibido: 0, esperado: 0 }));
    const anio = Number(hoyISO().slice(0, 4));
    const ids = lista.map(c => c.id);
    const pagos = await pagosDe(ids);
    const hoy = hoyISO();
    for (const c of lista) {
      for (const p of pagos.get(c.id)) if (Number(p.fecha.slice(0, 4)) === anio) mes[Number(p.fecha.slice(5, 7)) - 1].recibido += Number(p.valor);
      vencimientos(c.inicio_pagos, c.n_cuotas).forEach(v => { if (Number(v.slice(0, 4)) === anio && v <= hoy) mes[Number(v.slice(5, 7)) - 1].esperado += c.cuota_mensual; });
    }
    const por = k => lista.filter(c => c.alerta === k).length;
    return { hoy, anio, totales: totales(lista), alertas: { al_dia: por('al_dia'), mora: por('mora'), mora_grave: por('mora_grave'), sin_pago: por('sin_pago'), finalizado: por('finalizado') },
      por_asesor: ase.map(([id, nombre]) => ({ id, nombre, ...totales(lista.filter(c => c.asesor_id === id)) })), mensual: mes };
  }

  /** Flujo anual: pagos recibidos por cliente y mes. */
  async function flujo(u, anio = Number(hoyISO().slice(0, 4))) {
    const lista = await listar(u, { incluirAnon: true });
    const pagos = await pagosDe(lista.map(c => c.id));
    return lista.map(c => {
      const m = Array(12).fill(0);
      for (const p of pagos.get(c.id)) if (Number(p.fecha.slice(0, 4)) === anio) m[Number(p.fecha.slice(5, 7)) - 1] += Number(p.valor);
      return { id: c.id, numero: c.numero, nombre: c.nombre, asesor: c.asesor, cuota_mensual: c.cuota_mensual, meses: m, total: m.reduce((a, b) => a + b, 0) };
    });
  }

  const csv = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  async function exportarCsv(u, ctx = {}) {
    const a = alcance(u);
    if (!a.admin && !(a.todo && a.escribe)) throw new CarteraError('No tienes permiso para exportar.', 403);
    const filas = [];
    for (const f of await filasVisibles(u)) filas.push(f);
    const pagos = await pagosDe(filas.map(f => f.id)), ase = await asesores(), hoy = hoyISO();
    const cab = ['numero', 'cedula', 'nombre', 'asesor', 'estado_proceso', 'total_contrato', 'recibido', 'saldo', 'cuotas_en_mora', 'valor_en_mora', 'alerta'];
    const lineas = filas.map(f => { const pii = abrir(f), d = derivar(f, pagos.get(f.id), hoy);
      return [f.numero, pii.cedula, pii.nombre, ase.get(f.asesor_id)?.nombre, f.estado_proceso, f.total_contrato, d.recibido, d.saldo, d.cuotas_en_mora, d.valor_en_mora, d.alerta].map(csv).join(','); });
    await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'exportar', entidad: 'cliente', detalle: `${filas.length} clientes (con datos personales)`, ip: ctx.ip });
    return '﻿' + [cab.join(','), ...lineas].join('\r\n');
  }

  /** Re-cifra todo con la clave vigente (tras cambiar DATA_KEY y dejar la anterior en DATA_KEY_PREV). */
  async function rotarClaves() {
    let n = 0;
    for (const f of await db.all('SELECT id, pii, cedula_idx FROM clientes')) {
      if (f.cedula_idx.startsWith('anon:')) { if (cifrador.necesitaRotar(f.pii)) { await db.run('UPDATE clientes SET pii = ? WHERE id = ?', [cifrador.cifrar(cifrador.descifrar(f.pii, aad(f.id)), aad(f.id)), f.id]); n++; } continue; }
      const pii = cifrador.descifrar(f.pii, aad(f.id));
      await db.run('UPDATE clientes SET pii = ?, cedula_idx = ? WHERE id = ?', [cifrador.cifrar(pii, aad(f.id)), cifrador.indiceCedula(pii.cedula), f.id]); n++;
    }
    return n;
  }

  return { insertar, listar, obtener, crear, actualizar, registrarPago, anularPago, anonimizar, resumen, flujo, exportarCsv, rotarClaves, alcance, asesores, aad, abrir, validarAsesor };
}
export { ValidacionError };
