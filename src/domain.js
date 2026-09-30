import { AREAS, AREA_ALIAS, CATEGORIAS, ESCALA_DIAS, GENERAL, TODOS, TZ } from './config.js';

/** Fecha de negocio "hoy" (YYYY-MM-DD) en America/Bogotá, independiente del servidor. */
export function hoyISO(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const esFechaISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

/** Diferencia en días calendario (fecha - hoy), sin depender de husos ni DST. */
export function diasHasta(fecha, hoy = hoyISO()) {
  if (!fecha) return null;
  return Math.round((Date.parse(fecha + 'T00:00:00Z') - Date.parse(hoy + 'T00:00:00Z')) / 86400000);
}

/** Suma un mes conservando el día ancla (31 ene → 28 feb → 31 mar). */
export function sumarMes(fecha, diaAncla) {
  const [y, m] = fecha.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const ult = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(diaAncla || Number(fecha.slice(8)), ult)).padStart(2, '0')}`;
}

export function normArea(a) {
  if (!a) return GENERAL;
  return AREA_ALIAS[a] || a;
}

/** Escalamiento derivado (nunca se persiste sobre la categoría). */
export function escalamiento(t, hoy = hoyISO()) {
  if (t.estado !== 'pendiente' || t.categoria === 'urgente') return { categoria_efectiva: t.categoria, escalada: null };
  const n = diasHasta(t.fecha_limite, hoy);
  if (n === null || n > ESCALA_DIAS) return { categoria_efectiva: t.categoria, escalada: null };
  return { categoria_efectiva: 'urgente', escalada: n < 0 ? 'vencida' : 'proxima' };
}

/** Valida y normaliza el cuerpo de una tarea. Devuelve { error } o { valor }. */
export function validarTarea(b, { tipo, parcial = false } = {}) {
  const v = {};
  const t = tipo;
  if (!parcial || b.titulo !== undefined) {
    v.titulo = String(b.titulo ?? '').trim();
    if (!v.titulo) return { error: 'Escribe qué hay que hacer.' };
    if (v.titulo.length > 160) return { error: 'El título supera 160 caracteres.' };
  }
  if (!parcial || b.categoria !== undefined) {
    if (!CATEGORIAS.includes(b.categoria)) return { error: 'Categoría inválida.' };
    v.categoria = b.categoria;
  }
  if (!parcial || b.area !== undefined) {
    v.area = normArea(b.area);
    if (!AREAS.includes(v.area)) return { error: 'Dirección inválida.' };
  }
  if (b.fecha_limite !== undefined) {
    if (b.fecha_limite === null || b.fecha_limite === '') v.fecha_limite = null;
    else if (!esFechaISO(b.fecha_limite)) return { error: 'Fecha inválida (AAAA-MM-DD).' };
    else v.fecha_limite = b.fecha_limite;
  } else if (!parcial) v.fecha_limite = null;
  for (const [k, max] of [['responsable', 80], ['origen', 80], ['notas', 1000]]) {
    if (b[k] !== undefined) {
      v[k] = String(b[k] ?? '').trim();
      if (v[k].length > max) return { error: `${k} supera ${max} caracteres.` };
    }
  }
  if (t === 'pago') {
    if (b.monto !== undefined) {
      if (b.monto === null || b.monto === '') v.monto = null;
      else if (!Number.isInteger(b.monto) || b.monto < 0 || b.monto > 1e12) return { error: 'El valor debe ser un entero de pesos ≥ 0.' };
      else v.monto = b.monto;
    }
    if (b.recurrente !== undefined) v.recurrente = b.recurrente === 'mensual' ? 'mensual' : 'no';
  }
  return { valor: v };
}

/** Reglas de negocio sobre la tarea completa (ya combinada con lo guardado). */
export function reglasNegocio(t, { confirmando = false } = {}) {
  if (t.tipo === 'pago' && !t.fecha_limite && (confirmando || t.estado !== 'propuesta')) return 'Asigna la fecha de pago para que el tablero te avise.';
  if (t.categoria === 'prioritario' && t.area === GENERAL) return 'Lo Prioritario se gestiona con el equipo: elige una dirección o Todos.';
  if (t.categoria === 'importante' && t.area === GENERAL) return 'Lo Importante se delega: elige otra dirección o Todos.';
  return '';
}

export { TODOS };
