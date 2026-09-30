import { randomUUID } from 'node:crypto';
import { AREAS, TODOS } from './config.js';
import { claveTemporal, hashClave, publico } from './auth.js';

const ahora = () => new Date().toISOString();
export const esCorreo = s => typeof s === 'string' && s.length <= 120 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
export class UsuarioError extends Error { constructor(m, status = 422) { super(m); this.status = status; } }

/** Crea (o, con recuperación, restablece) al administrador inicial con OWNER_TOKEN como clave temporal. */
export async function sembrarAdmin(db, cfg) {
  if (!cfg.adminEmail || !cfg.ownerToken) return;
  const hash = await hashClave(cfg.ownerToken);
  const existente = await db.get('SELECT id FROM users WHERE email = ?', [cfg.adminEmail]);
  if (existente && cfg.adminRecovery) {
    await db.run("UPDATE users SET pass_hash=?, must_change=TRUE, activo=TRUE, rol='admin', area=NULL, session_version=session_version+1 WHERE id=?", [hash, existente.id]);
    return;
  }
  const hayAdmin = await db.get("SELECT 1 AS x FROM users WHERE rol='admin' AND activo=TRUE LIMIT 1");
  if (hayAdmin || existente) return;
  await db.run('INSERT INTO users(id,email,nombre,rol,area,pass_hash,must_change,activo,session_version,created_at) VALUES (?,?,?,?,?,?,TRUE,TRUE,1,?)',
    [randomUUID(), cfg.adminEmail, 'Administrador', 'admin', null, hash, ahora()]);
}

function validar(b, { parcial = false } = {}) {
  const v = {};
  if (!parcial || b.email !== undefined) {
    v.email = String(b.email ?? '').trim().toLowerCase();
    if (!esCorreo(v.email)) throw new UsuarioError('Correo inválido.');
  }
  if (!parcial || b.nombre !== undefined) {
    v.nombre = String(b.nombre ?? '').trim();
    if (!v.nombre || v.nombre.length > 80) throw new UsuarioError('El nombre es obligatorio (máx. 80 caracteres).');
  }
  if (!parcial || b.rol !== undefined) {
    if (!['admin', 'miembro', 'lector'].includes(b.rol)) throw new UsuarioError('Rol inválido.');
    v.rol = b.rol;
  }
  if (!parcial || b.area !== undefined || v.rol) {
    if (v.rol === 'admin') v.area = null;
    else {
      if (!AREAS.includes(b.area) || b.area === TODOS) throw new UsuarioError('Elige la dirección del usuario.');
      v.area = b.area;
    }
  }
  if (b.activo !== undefined) v.activo = Boolean(b.activo);
  return v;
}

export function crearUsuarios(db) {
  const admins = async () => Number((await db.get("SELECT count(*) AS n FROM users WHERE rol='admin' AND activo=TRUE")).n);
  return {
    listar: () => db.all('SELECT id,email,nombre,rol,area,must_change,activo,created_at,last_login FROM users ORDER BY activo DESC, rol, nombre'),
    async crear(actor, b) {
      const v = validar(b);
      if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', [v.email])) throw new UsuarioError('Ese correo ya está registrado.', 409);
      const temporal = claveTemporal();
      const id = randomUUID();
      await db.run('INSERT INTO users(id,email,nombre,rol,area,pass_hash,must_change,activo,session_version,created_at) VALUES (?,?,?,?,?,?,TRUE,TRUE,1,?)',
        [id, v.email, v.nombre, v.rol, v.area, await hashClave(temporal), ahora()]);
      return { usuario: publico(await db.get('SELECT * FROM users WHERE id = ?', [id])), temporal };
    },
    async actualizar(actor, id, b) {
      const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
      if (!u) throw new UsuarioError('No existe.', 404);
      const v = validar({ ...b, rol: b.rol ?? u.rol, area: b.area ?? u.area }, { parcial: true });
      const nuevo = { ...u, ...v };
      if (id === actor.id && (nuevo.rol !== 'admin' || !nuevo.activo)) throw new UsuarioError('No puedes quitarte el rol de administrador ni desactivarte.');
      if (u.rol === 'admin' && u.activo && (nuevo.rol !== 'admin' || !nuevo.activo) && await admins() <= 1) throw new UsuarioError('Debe quedar al menos un administrador activo.');
      const cambioAcceso = nuevo.rol !== u.rol || nuevo.area !== u.area || nuevo.activo !== u.activo;
      await db.run('UPDATE users SET nombre=?, rol=?, area=?, activo=?, session_version=session_version+? WHERE id=?',
        [nuevo.nombre, nuevo.rol, nuevo.area, nuevo.activo, cambioAcceso ? 1 : 0, id]);
      return publico(await db.get('SELECT * FROM users WHERE id = ?', [id]));
    },
    async restablecer(actor, id) {
      const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
      if (!u) throw new UsuarioError('No existe.', 404);
      const temporal = claveTemporal();
      await db.run('UPDATE users SET pass_hash=?, must_change=TRUE, session_version=session_version+1 WHERE id=?', [await hashClave(temporal), id]);
      return { temporal };
    },
    async cambiarClave(id, nuevaClave) {
      await db.run('UPDATE users SET pass_hash=?, must_change=FALSE, session_version=session_version+1 WHERE id=?', [await hashClave(nuevaClave), id]);
      return publico(await db.get('SELECT * FROM users WHERE id = ?', [id]));
    }
  };
}
