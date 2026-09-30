import { randomUUID } from 'node:crypto';
import { diasHasta, escalamiento, hoyISO, reglasNegocio, sumarMes } from './domain.js';

const ahora = () => new Date().toISOString();
export class ConflictoError extends Error { constructor(m) { super(m); this.status = 409; } }
export class NegocioError extends Error { constructor(m, status = 422) { super(m); this.status = status; } }

export function crearStore(db) {
  const get = (id, x = db) => x.get('SELECT * FROM tasks WHERE id = ?', [id]);
  const evento = (x, id, actor, accion, detalle = '') =>
    x.run('INSERT INTO task_events(task_id, actor, accion, detalle, at) VALUES (?,?,?,?,?)', [id, actor, accion, detalle, ahora()]);

  function enriquecer(t, hoy = hoyISO()) {
    const n = diasHasta(t.fecha_limite, hoy);
    return { ...t, ...escalamiento(t, hoy), dias: n, vencida: t.estado === 'pendiente' && n !== null && n < 0, recurrente: t.serie_id ? 'mensual' : 'no' };
  }

  async function listar({ incluirPagos }) {
    const filas = await db.all(`SELECT t.*, (SELECT count(*) FROM github_links g WHERE g.task_id = t.id) AS n_links
      FROM tasks t ${incluirPagos ? '' : "WHERE t.tipo = 'actividad' AND t.estado IN ('pendiente','cerrada')"} ORDER BY t.fecha_limite IS NULL, t.fecha_limite, t.created_at`);
    const hoy = hoyISO();
    return filas.map(t => enriquecer(t, hoy));
  }

  async function crear(actor, v, { tipo, estado = 'pendiente' }) {
    const id = randomUUID(), ts = ahora();
    const t = { id, tipo, estado, serie_id: null, periodo: null, responsable: '', origen: '', notas: '', monto: null, fecha_limite: null, ...v };
    const err = reglasNegocio(t, { confirmando: estado === 'pendiente' });
    if (err) throw new NegocioError(err);
    await db.tx(async x => {
      let serie = null;
      if (tipo === 'pago' && v.recurrente === 'mensual' && t.fecha_limite) {
        serie = randomUUID();
        await x.run('INSERT INTO series(id, frecuencia, dia_ancla) VALUES (?,?,?)', [serie, 'mensual', Number(t.fecha_limite.slice(8))]);
      }
      await x.run(`INSERT INTO tasks(id,tipo,titulo,categoria,area,responsable,fecha_limite,estado,origen,notas,monto,serie_id,periodo,created_at,updated_at)
        VALUES (@id,@tipo,@titulo,@categoria,@area,@responsable,@fecha_limite,@estado,@origen,@notas,@monto,@serie,@periodo,@ts,@ts)`,
        { id, tipo, titulo: t.titulo, categoria: t.categoria, area: t.area, responsable: t.responsable, fecha_limite: t.fecha_limite, estado,
          origen: t.origen, notas: t.notas, monto: t.monto, serie, periodo: serie ? t.fecha_limite.slice(0, 7) : null, ts });
      await evento(x, id, actor, 'crear', t.titulo);
    });
    return enriquecer(await get(id));
  }

  async function actualizar(actor, id, v, version) {
    const t = await get(id);
    if (!t) throw new NegocioError('No existe.', 404);
    if (version !== undefined && version !== t.version) throw new ConflictoError('Alguien más modificó esto. Recarga para ver la última versión.');
    const { recurrente, ...campos } = v;
    const nuevo = { ...t, ...campos };
    const err = reglasNegocio(nuevo);
    if (err) throw new NegocioError(err);
    const cambios = Object.keys(campos).filter(k => campos[k] !== t[k]);
    if (!cambios.length) return enriquecer(t);
    await db.tx(async x => {
      const r = await x.run(`UPDATE tasks SET titulo=@titulo,categoria=@categoria,area=@area,responsable=@responsable,fecha_limite=@fecha_limite,
        origen=@origen,notas=@notas,monto=@monto,version=version+1,updated_at=@ts WHERE id=@id AND version=@version`,
        { titulo: nuevo.titulo, categoria: nuevo.categoria, area: nuevo.area, responsable: nuevo.responsable, fecha_limite: nuevo.fecha_limite,
          origen: nuevo.origen, notas: nuevo.notas, monto: nuevo.monto, ts: ahora(), id, version: t.version });
      if (!r.changes) throw new ConflictoError('Alguien más modificó esto. Recarga para ver la última versión.');
      await evento(x, id, actor, 'editar', cambios.map(k => `${k}: ${t[k] ?? ''} → ${campos[k] ?? ''}`).join('; ').slice(0, 500));
    });
    return enriquecer(await get(id));
  }

  /** Transiciones válidas de estado. Devuelve la tarea y, si aplica, el siguiente pago recurrente. */
  async function transicion(actor, id, accion) {
    const t = await get(id);
    if (!t) throw new NegocioError('No existe.', 404);
    const permitidas = { cerrar: ['pendiente'], reabrir: ['cerrada'], descartar: ['pendiente', 'propuesta'], restaurar: ['descartada'], confirmar: ['propuesta'] };
    if (!permitidas[accion]) throw new NegocioError('Acción inválida.', 400);
    if (!permitidas[accion].includes(t.estado)) throw new NegocioError(`No se puede ${accion} algo en estado "${t.estado}".`, 409);
    if (accion === 'confirmar') { const e = reglasNegocio(t, { confirmando: true }); if (e) throw new NegocioError(e); }
    const estado = { cerrar: 'cerrada', reabrir: 'pendiente', descartar: 'descartada', restaurar: 'pendiente', confirmar: 'pendiente' }[accion];
    let siguienteId = null;
    await db.tx(async x => {
      // La condición sobre el estado previo evita que dos clics simultáneos apliquen la misma transición dos veces.
      const r = await x.run('UPDATE tasks SET estado=?, cerrada_at=?, version=version+1, updated_at=? WHERE id=? AND estado=?',
        [estado, estado === 'cerrada' ? ahora() : null, ahora(), id, t.estado]);
      if (!r.changes) throw new ConflictoError('El estado cambió mientras tanto. Recarga.');
      await evento(x, id, actor, accion);
      if (accion === 'cerrar' && t.serie_id && t.fecha_limite) siguienteId = await siguientePago(x, actor, t);
    });
    return { tarea: enriquecer(await get(id)), siguiente: siguienteId ? enriquecer(await get(siguienteId)) : null };
  }

  // Idempotente: UNIQUE(serie_id, periodo) impide duplicados aunque haya doble clic o dos clientes.
  async function siguientePago(x, actor, t) {
    const serie = await x.get('SELECT * FROM series WHERE id = ?', [t.serie_id]);
    const fecha = sumarMes(t.fecha_limite, serie.dia_ancla);
    if (serie.fin_fecha && fecha > serie.fin_fecha) return null;
    const id = randomUUID(), ts = ahora();
    const r = await x.run(`INSERT INTO tasks(id,tipo,titulo,categoria,area,responsable,fecha_limite,estado,origen,notas,monto,serie_id,periodo,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pendiente',?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [id, 'pago', t.titulo, t.categoria, t.area, t.responsable, fecha, t.origen, t.notas, t.monto, t.serie_id, fecha.slice(0, 7), ts, ts]);
    if (!r.changes) return null;
    await evento(x, id, actor, 'crear', `Recurrente desde ${t.id}`);
    return id;
  }

  async function confirmarReunion(actor, origen) {
    const props = await db.all("SELECT * FROM tasks WHERE estado='propuesta' AND origen = ?", [origen]);
    let ok = 0; const pendientes = [];
    await db.tx(async x => {
      for (const t of props) {
        if (reglasNegocio(t, { confirmando: true })) { pendientes.push(t.id); continue; }
        await x.run("UPDATE tasks SET estado='pendiente', version=version+1, updated_at=? WHERE id=? AND estado='propuesta'", [ahora(), t.id]);
        await evento(x, t.id, actor, 'confirmar', 'en lote'); ok++;
      }
    });
    return { confirmadas: ok, requierenRevision: pendientes };
  }

  async function eliminar(actor, id) {
    const t = await get(id);
    if (!t) throw new NegocioError('No existe.', 404);
    await db.tx(async x => {
      await evento(x, id, actor, 'eliminar', `${t.tipo}: ${t.titulo}${t.monto ? ' ($' + t.monto + ')' : ''}`);
      await x.run('DELETE FROM github_links WHERE task_id = ?', [id]);
      await x.run('DELETE FROM tasks WHERE id = ?', [id]);
    });
  }

  async function resumen(incluirPagos) {
    const hoy = hoyISO();
    const ts = (await listar({ incluirPagos })).filter(t => t.estado !== 'propuesta' && t.estado !== 'descartada');
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
      const sem = abiertos.filter(t => t.dias !== null && t.dias >= 0 && t.dias <= 7);
      const mes = hoy.slice(0, 7);
      r.pagos = {
        vencidos: { n: venc.length, total: suma(venc) }, proximos30: { n: prox.length, total: suma(prox) },
        semana: { n: sem.length, total: suma(sem) },
        pagadosMes: suma(pagos.filter(t => t.estado === 'cerrada' && t.cerrada_at && t.cerrada_at.slice(0, 7) === mes)),
        sinFecha: abiertos.filter(t => !t.fecha_limite).length
      };
    }
    return r;
  }

  return {
    get, listar, crear, actualizar, transicion, confirmarReunion, eliminar, resumen,
    evento: (id, actor, accion, detalle) => evento(db, id, actor, accion, detalle),
    eventos: id => db.all('SELECT actor, accion, detalle, at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 100', [id])
  };
}
