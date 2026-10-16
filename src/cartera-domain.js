import { hoyISO, sumarMes } from './domain.js';

export const ESTADOS_PROCESO = ['A. Inicio', 'A. Aprobado', 'En audiencia', 'En ejecución', 'Finalizado'];
export const CONCEPTOS = ['anticipo', 'cuota', 'honorarios', 'migracion', 'otro'];
export const MAX_COP = 1e13;
export class ValidacionError extends Error { constructor(m) { super(m); this.status = 422; } }

export const esFecha = s => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const t = Date.parse(s + 'T00:00:00Z'); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };
const fallo = m => { throw new ValidacionError(m); };

/** Pesos enteros (COP). Acepta número entero o cadena de dígitos; rechaza decimales, negativos y notación científica. */
export function cop(v, campo) {
  if (v === undefined || v === null || v === '') return 0;
  const s = typeof v === 'number' ? (Number.isSafeInteger(v) ? String(v) : '') : String(v).trim();
  if (!/^\d{1,13}$/.test(s) || Number(s) > MAX_COP) fallo(`${campo}: debe ser un valor entero en pesos (sin decimales ni signos).`);
  return Number(s);
}
const fecha = (v, campo) => { if (v === undefined || v === null || v === '') return null; if (!esFecha(v)) fallo(`${campo}: fecha inválida (AAAA-MM-DD).`); return v; };
const texto = (v, campo, max, req = false) => { const s = String(v ?? '').trim(); if (req && !s) fallo(`${campo} es obligatorio.`); if (s.length > max) fallo(`${campo}: máximo ${max} caracteres.`); return s; };

/** Valida el cuerpo de un cliente. Devuelve { pii?, cols? } con solo lo enviado cuando `parcial`. */
export function validarCliente(b, { parcial = false } = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fallo('Datos inválidos.');
  const tiene = k => !parcial || b[k] !== undefined;
  const pii = {}, cols = {};
  if (tiene('nombre')) pii.nombre = texto(b.nombre, 'Nombre', 120, true);
  if (tiene('cedula')) {
    const ced = String(b.cedula ?? '').replace(/[.\s-]/g, '');
    if (!/^\d{5,12}$/.test(ced)) fallo('Cédula inválida: solo dígitos, entre 5 y 12.');
    pii.cedula = ced;
  }
  if (tiene('telefono')) { const t = String(b.telefono ?? '').replace(/[\s()+-]/g, ''); if (t && !/^\d{7,15}$/.test(t)) fallo('Teléfono inválido.'); pii.telefono = t; }
  if (tiene('correo')) { const c = texto(b.correo, 'Correo', 120).toLowerCase(); if (c && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c)) fallo('Correo inválido.'); pii.correo = c; }
  if (tiene('notas')) pii.notas = texto(b.notas, 'Notas', 2000);
  if (tiene('estado_proceso')) { if (!ESTADOS_PROCESO.includes(b.estado_proceso ?? 'A. Inicio')) fallo('Estado del proceso inválido.'); cols.estado_proceso = b.estado_proceso ?? 'A. Inicio'; }
  if (tiene('fecha_ingreso')) cols.fecha_ingreso = fecha(b.fecha_ingreso, 'Fecha de ingreso');
  if (tiene('inicio_pagos')) cols.inicio_pagos = fecha(b.inicio_pagos, 'Inicio de pagos');
  for (const k of ['deuda_declarada', 'deuda_priorizada', 'cuota_mensual', 'total_contrato', 'pago_centro', 'honorarios', 'bonificacion', 'gastos_admin', 'gastos_adq']) {
    if (tiene(k)) cols[k] = cop(b[k], k.replace(/_/g, ' '));
  }
  if (tiene('n_cuotas')) { const n = Number(b.n_cuotas ?? 1); if (!Number.isInteger(n) || n < 1 || n > 120) fallo('N° de cuotas: entero entre 1 y 120.'); cols.n_cuotas = n; }
  if (tiene('sede')) cols.sede = texto(b.sede, 'Sede', 80);
  if (b.asesor_id !== undefined) cols.asesor_id = texto(b.asesor_id, 'Asesor', 64, true);
  else if (!parcial) fallo('Asesor es obligatorio.');
  return { pii, cols };
}

export function validarPago(b) {
  if (!b || typeof b !== 'object') fallo('Datos inválidos.');
  const valor = cop(b.valor, 'Valor');
  if (valor <= 0) fallo('El valor debe ser mayor que cero.');
  const f = fecha(b.fecha, 'Fecha');
  if (!f) fallo('La fecha es obligatoria.');
  if (f > hoyISO(new Date(Date.now() + 86400000))) fallo('La fecha no puede estar en el futuro.');
  if (!CONCEPTOS.includes(b.concepto ?? 'cuota')) fallo('Concepto inválido.');
  const idem = b.idem === undefined || b.idem === null ? null : String(b.idem);
  if (idem !== null && !/^[\w-]{8,64}$/.test(idem)) fallo('Clave de idempotencia inválida.');
  return { valor, fecha: f, concepto: b.concepto ?? 'cuota', nota: texto(b.nota, 'Nota', 300), idem };
}

/** Fechas de vencimiento de las cuotas: día ancla del inicio de pagos, un mes tras otro. */
export function vencimientos(inicio, n) {
  if (!inicio) return [];
  const ancla = Number(inicio.slice(8)), out = [inicio];
  while (out.length < n) out.push(sumarMes(out[out.length - 1], ancla));
  return out;
}
const dias = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

/**
 * Cálculos de un cliente a partir de sus pagos NO anulados. Reglas tomadas de la matriz actual:
 *  - cuotas pagadas = piso(recibido / cuota mensual), tope n° de cuotas
 *  - cuotas en mora = esperadas − pagadas; valor en mora = cuotas en mora × cuota; días en mora ≈ 30 × cuotas en mora
 * Se añaden `dias_reales` (desde el vencimiento de la cuota impaga más antigua) y `utilidad_esperada`.
 */
export function derivar(c, pagos, hoy = hoyISO()) {
  const recibido = pagos.reduce((s, p) => s + Number(p.valor), 0);
  const venc = vencimientos(c.inicio_pagos, c.n_cuotas);
  const esperadas = venc.filter(v => v <= hoy).length;
  const pagadas = c.cuota_mensual > 0 ? Math.min(c.n_cuotas, Math.floor(recibido / c.cuota_mensual)) : 0;
  const enMora = c.estado === 'activo' ? Math.max(0, esperadas - pagadas) : 0;
  const saldo = Math.max(0, c.total_contrato - recibido);
  const finalizado = c.total_contrato > 0 ? recibido >= c.total_contrato : pagadas >= c.n_cuotas;
  const alerta = c.estado === 'cerrado' || finalizado ? 'finalizado'
    : recibido === 0 && esperadas > 0 ? 'sin_pago' : enMora * 30 >= 60 ? 'mora_grave' : enMora > 0 ? 'mora' : 'al_dia';
  const costos = c.honorarios + c.bonificacion + c.gastos_admin + c.gastos_adq;
  return {
    recibido, saldo, cumplimiento: c.total_contrato ? Math.min(1, recibido / c.total_contrato) : 0,
    cuotas_esperadas: esperadas, cuotas_pagadas: pagadas, cuotas_en_mora: enMora, valor_en_mora: enMora * c.cuota_mensual,
    dias_mora: enMora * 30, dias_reales: enMora && venc[pagadas] ? Math.max(0, dias(hoy, venc[pagadas])) : 0,
    cuotas_restantes: Math.max(0, c.n_cuotas - pagadas), fecha_fin: c.inicio_pagos ? vencimientos(c.inicio_pagos, c.n_cuotas + 1).at(-1) : null, // convención de la matriz: inicio + n meses
    proximo_vencimiento: venc.find(v => v > hoy) || null,
    costos, utilidad_esperada: c.total_contrato - costos - c.pago_centro, alerta,
    avisos: [
      ...(c.cuota_mensual * c.n_cuotas !== c.total_contrato && c.total_contrato > 0 ? ['cuota × n° de cuotas no coincide con el total del contrato'] : []),
      ...(recibido > c.total_contrato && c.total_contrato > 0 ? ['lo recibido supera el total del contrato'] : []),
      ...(c.deuda_declarada > 0 && Math.abs(c.deuda_priorizada - Math.round(c.deuda_declarada * 0.3)) > 1 ? ['la deuda priorizada no es el 30% de la declarada'] : []),
      ...(!c.inicio_pagos ? ['sin fecha de inicio de pagos'] : [])
    ]
  };
}

export function totales(filas) {
  const s = k => filas.reduce((a, f) => a + (f[k] || 0), 0);
  const act = filas.filter(f => f.alerta !== 'finalizado');
  const contrato = s('total_contrato'), recibido = s('recibido');
  return { clientes: filas.length, activos: act.length, deuda_declarada: s('deuda_declarada'), total_contrato: contrato, recibido, saldo: s('saldo'),
    valor_en_mora: s('valor_en_mora'), con_mora: filas.filter(f => f.valor_en_mora > 0).length, utilidad_esperada: s('utilidad_esperada'),
    recuperacion: contrato ? recibido / contrato : 0, recuperacion_promedio: filas.length ? filas.reduce((a, f) => a + f.cumplimiento, 0) / filas.length : 0 };
}
