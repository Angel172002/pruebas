import { randomUUID } from 'node:crypto';
import { diasHasta, escalamiento, hoyISO, normArea, reglasNegocio, sumarMes } from './domain.js';

const ahora = () => new Date().toISOString();
export class ConflictoError extends Error { constructor(m) { super(m); this.status = 409; } }
export class NegocioError extends Error { constructor(m, status = 422) { super(m); this.status = status; } }

export function crearStore(db) {
  const get = id => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  const evento = (id, actor, accion, detalle = '') =>
    db.prepare('INSERT INTO task_events(task_id, actor, accion, detalle, at) VALUES (?,?,?,?,?)').run(id, actor, accion, detalle, ahora());

  function enriquecer(t, hoy = hoyISO()) {
    const esc = escalamiento(t, hoy);
    const n = diasHasta(t.fecha_limite, hoy);
    return { ...t, ...esc, dias: n, vencida: t.estado === 'pendiente' && n !== null && n < 0, recurrente: t.serie_id ? 'mensual' : 'no' };
  }

  function listar({ incluirPagos }) {
    const filas = db.prepare(`SELECT t.*, (SELECT count(*) FROM github_links g WHERE g.task_id = t.id) AS n_links
      FROM tasks t ${incluirPagos ? '' : "WHERE t.tipo = 'actividad' AND t.estado IN ('pendiente','cerrada')"} ORDER BY t.fecha_limite IS NULL, t.fecha_limite, t.created_at`).all();
    const hoy = hoyISO();
    return filas.map(t => enriquecer(t, hoy));
  }

  function crear(actor, v, { tipo, estado = 'pendiente' }) {
    const id = randomUUID(), ts = ahora();
    const t = { id, tipo, estado, serie_id: null, periodo: null, responsable: '', origen: '', notas: '', monto: null, fecha_limite: null, ...v };
    const err = reglasNegocio(t, { confirmando: estado === 'pendiente' });
    if (err) throw new NegocioError(err);
    db.transaction(() => {
      let serie = null;
      if (tipo === 'pago' && v.recurrente === 'mensual' && t.fecha_limite) {
        serie = randomUUID();
        db.prepare('INSERT INTO series(id, frecuencia, dia_ancla) VALUES (?,?,?)').run(serie, 'mensual', Number(t.fecha_limite.slice(8)));
      }
      db.prepare(`INSERT INTO tasks(id,tipo,titulo,categoria,area,responsable,fecha_limite,estado,origen,notas,monto,serie_id,periodo,created_at,updated_at)
        VALUES (@id,@tipo,@titulo,@categoria,@area,@responsable,@fecha_limite,@estado,@origen,@notas,@monto,@serie,@periodo,@ts,@ts)`)
        .run({ ...t, serie, periodo: serie ? t.fecha_limite.slice(0, 7) : null, ts });
      evento(id, actor, 'crear', t.titulo);
    })();
    return enriquecer(get(id));
  }

  function actualizar(actor, id, v, version) {
    const t = get(id);
    if (!t) throw new NegocioError('No existe.', 404);
    if (version !== undefined && version !== t.version) throw new ConflictoError('Alguien más modificó esto. Recarga para ver la última versión.');
    const { recurrente, ...campos } = v;
    const nuevo = { ...t, ...campos };
    const err = reglasNegocio(nuevo);
    if (err) throw new NegocioError(err);
    const cambios = Object.keys(campos).filter(k => campos[k] !== t[k]);
    if (!cambios.length) return enriquecer(t);
    db.transaction(() => {
      const r = db.prepare(`UPDATE tasks SET titulo=@titulo,categoria=@categoria,area=@area,responsable=@responsable,fecha_limite=@fecha_limite,
        origen=@origen,notas=@notas,monto=@monto,version=version+1,updated_at=@ts WHERE id=@id AND version=@version`).run({ ...nuevo, ts: ahora() });
      if (!r.changes) throw new ConflictoError('Alguien más modificó esto. Recarga para ver la última versión.');
      evento(id, actor, 'editar', cambios.map(k => `${k}: ${t[k] ?? ''} → ${campos[k] ?? ''}`).join('; ').slice(0, 500));
    })();
    return enriquecer(get(id));
  }

  /** Transiciones válidas de estado. Devuelve la tarea y, si aplica, el siguiente pago recurrente. */
  function transicion(actor, id, accion) {
    const t = get(id);
    if (!t) throw new NegocioError('No existe.', 404);
    const permitidas = { cerrar: ['pendiente'], reabrir: ['cerrada'], descartar: ['pendiente', 'propuesta'], restaurar: ['descartada'], confirmar: ['propuesta'] };
    if (!permitidas[accion]) throw new NegocioError('Acción inválida.', 400);
    if (!permitidas[accion].includes(t.estado)) throw new NegocioError(`No se puede ${accion} algo en estado "${t.estado}".`, 409);
    if (accion === 'confirmar') { const e = reglasNegocio(t, { confirmando: true }); if (e) throw new NegocioError(e); }
    const estado = { cerrar: 'cerrada', reabrir: 'pendiente', descartar: 'descartada', restaurar: 'pendiente', confirmar: 'pendiente' }[accion];
    let siguiente = null;
    db.transaction(() => {
      db.prepare('UPDATE tasks SET estado=?, cerrada_at=?, version=version+1, updated_at=? WHERE id=?')
        .run(estado, estado === 'cerrada' ? ahora() : null, ahora(), id);
      evento(id, actor, accion);
      if (accion === 'cerrar' && t.serie_id && t.fecha_limite) siguiente = siguientePago(actor, t);
    })();
    return { tarea: enriquecer(get(id)), siguiente: siguiente && enriquecer(siguiente) };
  }

  // Idempotente: UNIQUE(serie_id, periodo) impide duplicados aunque haya doble clic o dos clientes.
  function siguientePago(actor, t) {
    const serie = db.prepare('SELECT * FROM series WHERE id = ?').get(t.serie_id);
    const fecha = sumarMes(t.fecha_limite, serie.dia_ancla);
    if (serie.fin_fecha && fecha > serie.fin_fecha) return null;
    const id = randomUUID(), ts = ahora();
    const r = db.prepare(`INSERT OR IGNORE INTO tasks(id,tipo,titulo,categoria,area,responsable,fecha_limite,estado,origen,notas,monto,serie_id,periodo,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pendiente',?,?,?,?,?,?,?)`)
      .run(id, 'pago', t.titulo, t.categoria, t.area, t.responsable, fecha, t.origen, t.notas, t.monto, t.serie_id, fecha.slice(0, 7), ts, ts);
    if (!r.changes) return null;
    evento(id, actor, 'crear', `Recurrente desde ${t.id}`);
    return get(id);
  }

  function confirmarReunion(actor, origen) {
    const props = db.prepare("SELECT * FROM tasks WHERE estado='propuesta' AND origen = ?").all(origen);
    let ok = 0, pendientes = [];
    db.transaction(() => {
      for (const t of props) {
        if (reglasNegocio(t, { confirmando: true })) { pendientes.push(t.id); continue; }
        db.prepare("UPDATE tasks SET estado='pendiente', version=version+1, updated_at=? WHERE id=? AND estado='propuesta'").run(ahora(), t.id);
        evento(t.id, actor, 'confirmar', 'en lote'); ok++;
      }
    })();
    return { confirmadas: ok, requierenRevision: pendientes };
  }

  function eliminar(actor, id) {
    const t = get(id);
    if (!t) throw new NegocioError('No existe.', 404);
    db.transaction(() => {
      evento(id, actor, 'eliminar', `${t.tipo}: ${t.titulo}${t.monto ? ' ($' + t.monto + ')' : ''}`);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    })();
  }

  function resumen(incluirPagos) {
    const hoy = hoyISO();
    const ts = listar({ incluirPagos }).filter(t => t.estado !== 'propuesta' && t.estado !== 'descartada');
    const acts = ts.filter(t => t.tipo === 'actividad'), pagos = ts.filter(t => t.tipo === 'pago');
    const abiertas = acts.filter(t => t.estado === 'pendiente');
    const delegadas = abiertas.filter(t => t.area !== 'Dirección General' && t.area !== 'Todos').length;
    const hace7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const r = {
      hoy,
      actividades: {
        abiertas: abiertas.length, vencidas: abiertas.filter(t => t.vencida).length,
        vencenHoy: abiertas.filter(t => t.dias === 0).length,
        pctDelegado: abiertas.length ? Math.round(delegadas / abiertas.length * 100) : 0,
        cerradas7d: acts.filter(t => t.estado === 'cerrada' && t.cerrada_at >= hace7).length
      }
    };
    if (incluirPagos) {
      const abiertos = pagos.filter(t => t.estado === 'pendiente');
      const suma = l => l.reduce((s, t) => s + (t.monto || 0), 0);
      const venc = abiertos.filter(t => t.vencida);
      const prox = abiertos.filter(t => t.dias !== null && t.dias >= 0 && t.dias <= 30);
      const mes = hoy.slice(0, 7);
      r.pagos = {
        vencidos: { n: venc.length, total: suma(venc) }, proximos30: { n: prox.length, total: suma(prox) },
        semana: { n: abiertos.filter(t => t.dias !== null && t.dias >= 0 && t.dias <= 7).length, total: suma(abiertos.filter(t => t.dias !== null && t.dias >= 0 && t.dias <= 7)) },
        pagadosMes: suma(pagos.filter(t => t.estado === 'cerrada' && t.cerrada_at && t.cerrada_at.slice(0, 7) === mes)),
        sinFecha: abiertos.filter(t => !t.fecha_limite).length
      };
    }
    return r;
  }

  return { get, listar, crear, actualizar, transicion, confirmarReunion, eliminar, resumen, evento, enriquecer,
    eventos: id => db.prepare('SELECT actor, accion, detalle, at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 100').all(id) };
}
export { normArea };
