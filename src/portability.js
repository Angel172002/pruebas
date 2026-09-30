import { randomUUID } from 'node:crypto';
import { AREAS, CATEGORIAS } from './config.js';
import { normArea } from './domain.js';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const monto = v => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  // Formato del artifact: solo dígitos. Rechaza lo ambiguo (decimales, signos, notación científica).
  return /^\d{1,13}$/.test(s) ? Number(s) : undefined;
};

/** Acepta el formato del artifact original ({tareas, pagos}) o el export propio ({tasks}). Devuelve filas válidas y descartes. */
export function normalizarImport(body) {
  const filas = [], rechazos = [];
  const fuentes = [];
  if (Array.isArray(body?.tasks)) body.tasks.forEach(x => fuentes.push([x.tipo === 'pago' ? 'pago' : 'actividad', x]));
  if (Array.isArray(body?.tareas)) body.tareas.filter(x => x.tipo !== 'pago').forEach(x => fuentes.push(['actividad', x]));
  if (Array.isArray(body?.pagos)) body.pagos.forEach(x => fuentes.push(['pago', x]));
  if (!fuentes.length) return { error: 'El archivo no contiene "tareas", "pagos" ni "tasks".' };
  for (const [tipo, x] of fuentes) {
    const titulo = String(x.titulo ?? '').trim().slice(0, 160);
    const area = normArea(x.area ?? x.direccion);
    const fecha = x.fecha_limite ?? x.fecha ?? null;
    const m = tipo === 'pago' ? monto(x.monto) : null;
    const categoria = CATEGORIAS.includes(x.categoria) ? x.categoria : (tipo === 'pago' ? 'importante' : null);
    const motivo = !titulo ? 'sin título' : !categoria ? 'categoría inválida' : !AREAS.includes(area) ? `dirección desconocida "${area}"`
      : fecha && !FECHA.test(fecha) ? 'fecha inválida' : m === undefined ? 'monto ambiguo' : null;
    if (motivo) { rechazos.push({ titulo: titulo || '(vacío)', motivo }); continue; }
    const cerrada = x.estado === 'cerrada' || x.estado === 'hecha' || x.estado === 'pagado';
    const estado = x.estado === 'descartada' ? 'descartada' : (x.propuesta === true || x.estado === 'propuesta') ? 'propuesta' : cerrada ? 'cerrada' : 'pendiente';
    const ts = (x.created_at || x.creada) && !Number.isNaN(Date.parse(x.created_at || x.creada)) ? new Date(x.created_at || x.creada).toISOString() : new Date().toISOString();
    const cierre = x.cerrada_at || x.completada || x.pagado;
    filas.push({
      id: typeof x.id === 'string' && /^[\w-]{1,64}$/.test(x.id) ? x.id : randomUUID(), tipo, titulo, categoria, area,
      responsable: String(x.responsable ?? '').slice(0, 80), fecha_limite: fecha || null, estado,
      cerrada_at: estado === 'cerrada' ? (cierre && !Number.isNaN(Date.parse(cierre)) ? new Date(cierre).toISOString() : ts) : null,
      origen: String(x.origen ?? '').slice(0, 80), notas: String(x.notas ?? '').slice(0, 1000), monto: m ?? null,
      recurrente: tipo === 'pago' && (x.recurrente === 'mensual' || x.serie_id) ? 'mensual' : 'no', created_at: ts
    });
  }
  return { filas, rechazos };
}

export async function importar(db, filas) {
  let nuevas = 0;
  await db.tx(async x => {
    for (const f of filas) {
      let serie = null;
      if (f.recurrente === 'mensual' && f.fecha_limite && f.estado !== 'descartada') {
        serie = randomUUID();
        await x.run('INSERT INTO series(id, frecuencia, dia_ancla) VALUES (?,?,?)', [serie, 'mensual', Number(f.fecha_limite.slice(8))]);
      }
      const r = await x.run(`INSERT INTO tasks(id,tipo,titulo,categoria,area,responsable,fecha_limite,estado,cerrada_at,origen,notas,monto,serie_id,periodo,created_at,updated_at)
        VALUES (@id,@tipo,@titulo,@categoria,@area,@responsable,@fecha_limite,@estado,@cerrada_at,@origen,@notas,@monto,@serie,@periodo,@created_at,@created_at)
        ON CONFLICT(id) DO NOTHING`,
        { id: f.id, tipo: f.tipo, titulo: f.titulo, categoria: f.categoria, area: f.area, responsable: f.responsable, fecha_limite: f.fecha_limite,
          estado: f.estado, cerrada_at: f.cerrada_at, origen: f.origen, notas: f.notas, monto: f.monto, serie, periodo: serie ? f.fecha_limite.slice(0, 7) : null, created_at: f.created_at });
      if (r.changes) nuevas++; else if (serie) await x.run('DELETE FROM series WHERE id = ?', [serie]);
    }
  });
  return { nuevas, existentes: filas.length - nuevas };
}

export async function exportar(db) {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(),
    tasks: (await db.all('SELECT * FROM tasks ORDER BY created_at')).map(({ version, updated_at, ...t }) => t),
    links: await db.all('SELECT * FROM github_links') };
}

const celda = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function aCsv(filas) {
  const cols = ['tipo', 'titulo', 'categoria', 'area', 'responsable', 'fecha_limite', 'estado', 'monto', 'origen', 'notas'];
  return '﻿' + [cols.join(','), ...filas.map(f => cols.map(c => celda(f[c])).join(','))].join('\r\n');
}
