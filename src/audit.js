import { createHash } from 'node:crypto';

const GENESIS = '0'.repeat(64);
const LOCK = 7412003;
const huella = (prev, f) => createHash('sha256').update([prev, f.at, f.actor, f.accion, f.entidad, f.entidad_id, f.detalle, f.ip].join('\u0001')).digest('hex');

/**
 * Bitácora de auditoría encadenada y de solo-agregar (el trigger de la base impide UPDATE/DELETE).
 * REGLA: `detalle` nunca lleva datos personales (nombre, cédula, teléfono); se identifica por id interno.
 */
export function crearAuditoria(db) {
  async function insertar(x, ev) {
    await x.run('SELECT pg_advisory_xact_lock(?)', [LOCK]); // serializa para mantener la cadena
    const ult = await x.get('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
    const prev = ult?.hash || GENESIS;
    const f = { at: new Date().toISOString(), actor: String(ev.actor || 'sistema').slice(0, 120), accion: ev.accion, entidad: ev.entidad || '',
      entidad_id: String(ev.entidad_id || ''), detalle: String(ev.detalle || '').slice(0, 500), ip: String(ev.ip || '').slice(0, 64) };
    await x.run('INSERT INTO audit_log(at,actor_id,actor,accion,entidad,entidad_id,detalle,ip,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [f.at, ev.actor_id || null, f.actor, f.accion, f.entidad, f.entidad_id, f.detalle, f.ip, prev, huella(prev, f)]);
  }
  return {
    /** `x`: transacción abierta (para que el evento y el cambio sean atómicos). Sin `x`, abre la suya. */
    registrar: (ev, x) => (x ? insertar(x, ev) : db.tx(t => insertar(t, ev))),
    async verificar() {
      const filas = await db.all('SELECT * FROM audit_log ORDER BY id');
      let prev = GENESIS;
      for (const f of filas) {
        if (f.prev_hash !== prev || f.hash !== huella(prev, f)) return { ok: false, filas: filas.length, rotoEn: f.id };
        prev = f.hash;
      }
      return { ok: true, filas: filas.length };
    },
    listar: ({ limite = 200, entidad_id, actor, accion } = {}) => {
      const w = [], a = [];
      if (entidad_id) { w.push('entidad_id = ?'); a.push(entidad_id); }
      if (actor) { w.push('actor = ?'); a.push(actor); }
      if (accion) { w.push('accion = ?'); a.push(accion); }
      return db.all(`SELECT id,at,actor,accion,entidad,entidad_id,detalle,ip FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(Number(limite) || 200, 500)}`, a);
    }
  };
}
