import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptP = promisify(scrypt);
const PARAMS = { N: 16384, r: 8, p: 1 };
export const RANGO = { lector: 1, miembro: 2, admin: 3 };
const MAX_AGE = 12 * 3600; // segundos
export const MIN_CLAVE = 10;

/* ---------- contraseñas (scrypt con sal) ---------- */
export async function hashClave(clave) {
  const sal = randomBytes(16);
  const h = await scryptP(clave, sal, 64, PARAMS);
  return `scrypt$${sal.toString('base64')}$${h.toString('base64')}`;
}
export async function verificarClave(clave, guardado) {
  const [alg, sal, h] = String(guardado).split('$');
  if (alg !== 'scrypt' || !h) return false;
  const calc = await scryptP(String(clave), Buffer.from(sal, 'base64'), 64, PARAMS);
  const esperado = Buffer.from(h, 'base64');
  return calc.length === esperado.length && timingSafeEqual(calc, esperado);
}
let falso; // hash de relleno para igualar tiempos cuando el correo no existe
export const hashFalso = () => (falso ??= hashClave(randomBytes(8).toString('hex')));

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
export const claveTemporal = (n = 14) => Array.from({ length: n }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');
export function validarClaveNueva(nueva, actual) {
  if (typeof nueva !== 'string' || nueva.length < MIN_CLAVE) return `La clave nueva debe tener al menos ${MIN_CLAVE} caracteres.`;
  if (nueva.length > 128) return 'La clave nueva es demasiado larga.';
  if (nueva === actual) return 'La clave nueva debe ser distinta a la actual.';
  return '';
}

/* ---------- sesión (cookie firmada; se invalida al cambiar session_version) ---------- */
const firmar = (p, secret) => createHmac('sha256', secret).update(p).digest('base64url');
const igual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function crearSesion(u, secret, now = Date.now()) {
  const p = `${u.id}.${u.session_version}.${Math.floor(now / 1000) + MAX_AGE}`;
  return `${p}.${firmar(p, secret)}`;
}
export function leerSesion(cookie, secret, now = Date.now()) {
  const partes = String(cookie || '').split('.');
  if (partes.length !== 4) return null;
  const [id, ver, exp, sig] = partes;
  if (!igual(sig, firmar(`${id}.${ver}.${exp}`, secret)) || Number(exp) * 1000 <= now) return null;
  return { id, ver: Number(ver) };
}
export const publico = u => ({ id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, area: u.area, must_change: Boolean(u.must_change) });
const cookies = h => Object.fromEntries(String(h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

export function authMiddleware(cfg, db) {
  // Modo desarrollo (admin sintético): solo con DEV_OPEN=1 y nunca en producción.
  const abierto = cfg.devOpen === true;
  return async (req, _res, next) => {
    if (abierto) req.user = { id: 'dev', email: 'dev@local', nombre: 'Desarrollo', rol: 'admin', area: null, must_change: false };
    else {
      const s = leerSesion(cookies(req.headers.cookie).sid, cfg.sessionSecret);
      const u = s && await db.get('SELECT * FROM users WHERE id = ?', [s.id]);
      req.user = u && u.activo && u.session_version === s.ver ? publico(u) : null;
    }
    req.actor = req.user?.email || 'anon';
    next();
  };
}
export const requiere = minimo => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Inicia sesión.' });
  if (req.user.must_change) return res.status(403).json({ error: 'Debes cambiar tu clave antes de continuar.', code: 'must_change' });
  if (RANGO[req.user.rol] < RANGO[minimo]) return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  next();
};
/** Mitiga CSRF: con SameSite=Strict además se exige una cabecera que un formulario cross-site no puede enviar. */
export const anticsrf = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'liva') return res.status(403).json({ error: 'Solicitud no permitida.' });
  next();
};
export const cookieOpts = cfg => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${cfg.prod ? '; Secure' : ''}`;
