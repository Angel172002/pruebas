import { randomUUID } from 'node:crypto';
import { derivar, esFecha, totales, validarCliente, ValidacionError } from './cartera-domain.js';
import { hoyISO } from './domain.js';
import { CarteraError } from './cartera.js';

/**
 * Migración desde la hoja "MATRIZ CLIENTES" exportada como CSV (Archivo → Descargar → CSV).
 * Flujo: 1) SIMULAR (no escribe nada; el informe NO incluye nombres ni cédulas, solo n.º de fila y motivo)
 *        2) corregir la hoja y repetir hasta que no haya rechazos  3) APLICAR (transacción única, idempotente).
 */
const MAX_BYTES = 3_000_000, MAX_FILAS = 5000;
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9/%() .°]+/g, ' ').replace(/\s+/g, ' ').trim();

export function parseCsv(texto) {
  const t = String(texto ?? '').replace(/^﻿/, '');
  if (t.length > MAX_BYTES) throw new CarteraError('El archivo es demasiado grande.', 413);
  const filas = []; let fila = [], cel = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cel += '"'; i++; } else q = false; } else cel += c; }
    else if (c === '"') q = true;
    else if (c === ',') { fila.push(cel); cel = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; fila.push(cel); filas.push(fila); fila = []; cel = ''; if (filas.length > MAX_FILAS) throw new CarteraError('Demasiadas filas.', 413); }
    else cel += c;
  }
  if (cel !== '' || fila.length) { fila.push(cel); filas.push(fila); }
  return filas;
}

// encabezado normalizado → campo. Se compara por "empieza con" para tolerar sufijos como (COP) o ★.
const MAPA = [
  ['nombre_cedula', ['nombre cliente / cedula', 'nombre cliente', 'cliente']], ['cedula', ['cedula', 'documento', 'identificacion', 'cc']], ['telefono', ['telefono', 'celular']],
  ['asesor', ['asesor']], ['fecha_ingreso', ['fecha ingreso']], ['estado_proceso', ['estado proceso']],
  ['deuda_declarada', ['deuda total declarada']], ['deuda_priorizada', ['deuda priorizada']], ['n_cuotas', ['n° cuotas', 'n cuotas', 'numero de cuotas']],
  ['cuota_mensual', ['cuota mensual proceso', 'cuota mensual']], ['pago_centro', ['pago centro conciliacion']], ['sede', ['sede / entidad', 'sede']],
  ['honorarios', ['honorarios abogado']], ['bonificacion', ['bonificacion asesor']], ['gastos_admin', ['gastos admin']], ['gastos_adq', ['gastos adquisicion']],
  ['total_contrato', ['total contrato cliente', 'total contrato']], ['recibido', ['total recibido por cliente', 'total recibido']], ['inicio_pagos', ['fecha inicio pagos']]
];
const campoDe = h => { const n = norm(h); if (!n) return null; for (const [campo, claves] of MAPA) if (claves.some(k => n === k || n.startsWith(k + ' ') || n.startsWith(k + '(') || n.startsWith(k + '★'))) return campo; return null; };

const peso = (v, campo) => {
  let s = String(v ?? '').trim();
  if (s === '' || s === '-' || s === '—') return 0;
  if (/^\(.*\)$/.test(s) || /^-/.test(s)) throw new ValidacionError(`${campo}: valor negativo`);
  s = s.replace(/[$\s]/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(s) || /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  if (!/^\d{1,13}$/.test(s)) throw new ValidacionError(`${campo}: formato de dinero no reconocido (decimales o texto)`);
  return Number(s);
};
const fechaIso = (v, campo) => {
  const s = String(v ?? '').trim(); if (!s || s === '-') return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s), iso = null;
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s;
  if (!iso || !esFecha(iso)) throw new ValidacionError(`${campo}: fecha no reconocida (use dd/mm/aaaa)`);
  return iso;
};
function nombreCedula(celda, cedulaAparte) {
  const t = String(celda ?? '').trim();
  if (cedulaAparte) return { nombre: t, cedula: cedulaAparte };
  const m = /^(.*?)[\s,\-–—·|/]*\(?(\d[\d.\s]{3,13}\d)\)?$/.exec(t);
  if (!m || !m[1].trim()) return { nombre: t, cedula: '' };
  return { nombre: m[1].trim(), cedula: m[2].replace(/[.\s]/g, '') };
}

export function crearImportador({ db, cifrador, auditoria, cartera }) {
  async function preparar(csv) {
    const filas = parseCsv(csv);
    const hi = filas.findIndex(f => f.some(c => norm(c).startsWith('nombre cliente')));
    if (hi < 0) throw new CarteraError('No se encontró la fila de encabezados ("NOMBRE CLIENTE / CÉDULA"). Exporta la pestaña MATRIZ CLIENTES como CSV.');
    const cols = filas[hi].map(campoDe);
    const faltan = ['nombre_cedula', 'asesor', 'total_contrato'].filter(c => !cols.includes(c));
    if (faltan.length) throw new CarteraError(`Faltan columnas obligatorias: ${faltan.join(', ')}.`);
    const usuarios = await db.all('SELECT id, nombre, email FROM users WHERE activo = TRUE');
    const porNombre = new Map();
    usuarios.forEach(u => { const k = norm(u.nombre); porNombre.set(k, [...(porNombre.get(k) || []), u]); });
    const existentes = new Set((await db.all('SELECT cedula_idx FROM clientes')).map(r => r.cedula_idx));
    const hoy = hoyISO(), validas = [], rechazos = [], omitidas = [], avisos = [], vistos = new Set();
    for (let i = hi + 1; i < filas.length; i++) {
      const f = filas[i], n = i + 1;
      const v = {}; cols.forEach((c, j) => { if (c && v[c] === undefined) v[c] = f[j]; });
      if (!f.some(c => String(c).trim()) || !String(v.nombre_cedula ?? '').trim()) continue; // fila vacía o de totales
      try {
        const { nombre, cedula } = nombreCedula(v.nombre_cedula, String(v.cedula ?? '').trim());
        if (!cedula) throw new ValidacionError('sin cédula: agrega la columna CÉDULA o escribe «Nombre – 123456789»');
        const cand = porNombre.get(norm(v.asesor)) || [];
        if (cand.length !== 1) throw new ValidacionError(cand.length ? 'asesor ambiguo (dos usuarios con ese nombre)' : 'asesor no coincide con ningún usuario activo (créalo antes en Usuarios)');
        const { pii, cols: c } = validarCliente({
          nombre, cedula, telefono: v.telefono, asesor_id: cand[0].id, estado_proceso: String(v.estado_proceso ?? '').trim() || 'A. Inicio',
          fecha_ingreso: fechaIso(v.fecha_ingreso, 'fecha ingreso'), inicio_pagos: fechaIso(v.inicio_pagos, 'fecha inicio pagos'),
          deuda_declarada: peso(v.deuda_declarada, 'deuda declarada'), deuda_priorizada: peso(v.deuda_priorizada, 'deuda priorizada'),
          n_cuotas: Number(String(v.n_cuotas ?? '1').trim() || 1), cuota_mensual: peso(v.cuota_mensual, 'cuota mensual'),
          total_contrato: peso(v.total_contrato, 'total contrato'), pago_centro: peso(v.pago_centro, 'pago centro'), sede: v.sede,
          honorarios: peso(v.honorarios, 'honorarios'), bonificacion: peso(v.bonificacion, 'bonificación'), gastos_admin: peso(v.gastos_admin, 'gastos admin'), gastos_adq: peso(v.gastos_adq, 'gastos adquisición')
        });
        const recibido = peso(v.recibido, 'total recibido');
        const idx = cifrador.indiceCedula(pii.cedula);
        if (vistos.has(idx)) throw new ValidacionError('cédula repetida dentro del archivo');
        vistos.add(idx);
        if (existentes.has(idx)) { omitidas.push({ fila: n, motivo: 'ya existe un cliente con esa cédula (no se modifica)' }); continue; }
        const d = derivar({ ...c, estado: 'activo' }, recibido ? [{ valor: recibido }] : [], hoy);
        d.avisos.forEach(a => avisos.push({ fila: n, aviso: a }));
        validas.push({ fila: n, pii, cols: c, recibido, derivado: { ...d, total_contrato: c.total_contrato, deuda_declarada: c.deuda_declarada, asesor_id: c.asesor_id, cumplimiento: d.cumplimiento } });
      } catch (e) {
        if (e instanceof ValidacionError) rechazos.push({ fila: n, motivo: e.message }); else throw e;
      }
    }
    return { validas, rechazos, omitidas, avisos, filasLeidas: validas.length + rechazos.length + omitidas.length };
  }

  const informe = r => {
    const filas = r.validas.map(v => ({ ...v.derivado }));
    return { leidas: r.filasLeidas, validas: r.validas.length, omitidas: r.omitidas, rechazos: r.rechazos, avisos: r.avisos.slice(0, 200), n_avisos: r.avisos.length,
      conciliacion: totales(filas) };
  };

  return {
    /** Simulación: no escribe nada. */
    async simular(u, csv, ctx = {}) {
      if (!cartera.alcance(u).admin) throw new CarteraError('Solo el administrador importa datos.', 403);
      const r = await preparar(csv);
      await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'importar_simulacion', entidad: 'cliente', detalle: `${r.validas.length} válidas, ${r.rechazos.length} rechazadas`, ip: ctx.ip });
      return informe(r);
    },
    /** Aplicación: todo o nada. Con rechazos pendientes exige `permitirParcial`. Repetirla no duplica (cédula única + idempotencia del pago migrado). */
    async aplicar(u, csv, { permitirParcial = false } = {}, ctx = {}) {
      if (!cartera.alcance(u).admin) throw new CarteraError('Solo el administrador importa datos.', 403);
      const r = await preparar(csv);
      if (r.rechazos.length && !permitirParcial) throw new CarteraError(`Hay ${r.rechazos.length} fila(s) rechazada(s). Corrígelas o confirma la importación parcial.`);
      let creados = 0;
      await db.tx(async x => {
        for (const v of r.validas) {
          const id = randomUUID();
          await cartera.insertar(x, id, v.pii, v.cols);
          if (v.recibido > 0) {
            await x.run('INSERT INTO pagos_cliente(id,cliente_id,fecha,valor,concepto,nota,idem,registrado_por,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
              [randomUUID(), id, v.cols.fecha_ingreso || hoyISO(), v.recibido, 'migracion', 'Total recibido migrado desde la matriz', `mig-${cifrador.indiceCedula(v.pii.cedula).slice(0, 40)}`, u.email, new Date().toISOString()]);
          }
          creados++;
        }
        await auditoria.registrar({ actor_id: u.id, actor: u.email, accion: 'importar', entidad: 'cliente', detalle: `${creados} clientes creados, ${r.rechazos.length} rechazados, ${r.omitidas.length} ya existían`, ip: ctx.ip }, x);
      });
      return { creados, ...informe(r) };
    }
  };
}
