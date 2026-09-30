import { createHmac, timingSafeEqual } from 'node:crypto';

const ROLES = ['viewer', 'editor', 'owner'];
const rank = r => ROLES.indexOf(r);
const MAX_AGE = 12 * 3600; // segundos

const firmar = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');
const igual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function crearSesion(rol, secret, now = Date.now()) {
  const p = `${rol}.${Math.floor(now / 1000) + MAX_AGE}`;
  return `${p}.${firmar(p, secret)}`;
}
export function leerSesion(cookie, secret, now = Date.now()) {
  const [rol, exp, sig] = String(cookie || '').split('.');
  if (!sig || !ROLES.includes(rol) || !igual(sig, firmar(`${rol}.${exp}`, secret))) return null;
  return Number(exp) * 1000 > now ? rol : null;
}
export function rolPorToken(token, cfg) {
  const t = String(token || '');
  for (const [rol, esperado] of [['owner', cfg.ownerToken], ['editor', cfg.editorToken], ['viewer', cfg.viewerToken]]) {
    if (esperado && igual(t, esperado)) return rol;
  }
  return null;
}
const cookies = h => Object.fromEntries(String(h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

export function authMiddleware(cfg) {
  // Sin tokens configurados y fuera de producción: modo desarrollo (owner), para probar localmente.
  const abierto = !cfg.prod && !cfg.ownerToken;
  return (req, _res, next) => {
    req.rol = abierto ? 'owner' : leerSesion(cookies(req.headers.cookie).sid, cfg.sessionSecret);
    req.actor = req.rol || 'anon';
    next();
  };
}
export const requiere = minimo => (req, res, next) => {
  if (!req.rol) return res.status(401).json({ error: 'Inicia sesión.' });
  if (rank(req.rol) < rank(minimo)) return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  next();
};
/** Mitiga CSRF: con SameSite=Strict además se exige una cabecera que un formulario cross-site no puede enviar. */
export const anticsrf = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'liva') return res.status(403).json({ error: 'Solicitud no permitida.' });
  next();
};

const intentos = new Map();
export function limiteLogin(req, res, next) {
  const k = req.ip, ahora = Date.now();
  const e = (intentos.get(k) || []).filter(t => ahora - t < 15 * 60000);
  if (e.length >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  e.push(ahora); intentos.set(k, e); next();
}
export const cookieOpts = cfg => `HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${cfg.prod ? '; Secure' : ''}`;
