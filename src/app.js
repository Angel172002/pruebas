import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AREAS, CATEGORIAS } from './config.js';
import { anticsrf, authMiddleware, cookieOpts, crearReto, crearSesion, exigeMfa, hashFalso, leerReto, publico, requiere, validarClaveNueva, verificarClave } from './auth.js';
import { crearCifrador } from './crypto.js';
import { crearAuditoria } from './audit.js';
import { crearCartera } from './cartera.js';
import { crearImportador } from './cartera-import.js';
import { CONCEPTOS, ESTADOS_PROCESO } from './cartera-domain.js';
import * as totp from './totp.js';
import { validarTarea } from './domain.js';
import { crearStore } from './store.js';
import { crearUsuarios, esCorreo } from './users.js';
import { aCsv, exportar, importar, normalizarImport } from './portability.js';
import { GitHubError, crearGitHub } from './services/github.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VENTANA_MS = 15 * 60000, MAX_POR_PAR = 8, MAX_POR_CORREO = 30, MAX_POR_IP = 40;
const SIN_SESION = 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

export function crearApp({ cfg, db, fetchImpl }) {
  const app = express();
  const store = crearStore(db);
  const usuarios = crearUsuarios(db);
  const cifrador = crearCifrador({ dataKey: cfg.dataKey, dataKeyPrev: cfg.dataKeyPrev });
  const auditoria = crearAuditoria(db);
  const cartera = crearCartera({ db, cifrador, auditoria });
  const importador = crearImportador({ db, cifrador, auditoria, cartera });
  const audit = (req, accion, extra = {}) => auditoria.registrar({ actor_id: req.user?.id, actor: req.user?.email || extra.actor || 'anon', accion, ip: req.ip, ...extra });
  const gh = crearGitHub({ token: cfg.githubToken, repos: cfg.githubRepos, fetchImpl });
  app.disable('x-powered-by');
  if (cfg.prod) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
      ...(cfg.prod ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {})
    });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => { try { await db.get('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });

  app.use(express.json({ limit: '2mb' }));
  app.use(authMiddleware(cfg, db), anticsrf);

  // ---- Sesión y cuenta propia
  const areasDe = u => (u.rol === 'admin' ? AREAS : [u.area]);
  app.get('/api/session', (req, res) => res.json({
    user: req.user, areas: req.user ? areasDe(req.user) : [], categorias: CATEGORIAS, cartera: { estados: ESTADOS_PROCESO, conceptos: CONCEPTOS },
    github: { configurado: gh.configurado(), repos: req.user?.rol === 'admin' || req.user?.rol === 'miembro' ? gh.repos() : [] }
  }));

  // Límite de intentos (en base de datos: vale entre instancias serverless). El intento se registra ANTES de
  // verificar la clave, así una ráfaga paralela no puede superar el tope. Claves: par correo+IP (estricto),
  // correo solo (más alto, para que nadie pueda dejar fuera al admin desde otra IP) e IP.
  async function registrarIntento(claves) {
    const t = Date.now(), ids = [];
    await db.run('DELETE FROM login_attempts WHERE at_ms < ?', [t - VENTANA_MS]);
    for (const [clave, max] of claves) {
      const fila = (await db.all('INSERT INTO login_attempts(clave, at_ms) VALUES (?,?) RETURNING id', [clave, t]))[0];
      ids.push(fila.id);
      const n = Number((await db.get('SELECT count(*) AS n FROM login_attempts WHERE clave = ? AND at_ms > ?', [clave, t - VENTANA_MS])).n);
      if (n > max) return { bloqueado: true, ids };
    }
    return { bloqueado: false, ids };
  }
  const olvidar = ids => ids.length ? db.run(`DELETE FROM login_attempts WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : null;
  const emitir = (res, u) => res.set('Set-Cookie', `sid=${crearSesion(u, cfg.sessionSecret)}; ${cookieOpts(cfg)}`);
  app.post('/api/login', async (req, res) => {
    const correo = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 120), clave = String(req.body?.password ?? '');
    const intento = await registrarIntento([[`p:${correo}|${req.ip}`, MAX_POR_PAR], [`c:${correo}`, MAX_POR_CORREO], [`i:${req.ip}`, MAX_POR_IP]]);
    if (intento.bloqueado) { await audit(req, 'login_bloqueado', { actor: correo }); return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }); }
    const u = esCorreo(correo) && clave.length <= 128 ? await db.get('SELECT * FROM users WHERE email = ?', [correo]) : undefined;
    const ok = await verificarClave(clave, u ? u.pass_hash : await hashFalso()) && u && u.activo;
    if (!ok) { await audit(req, 'login_fallido', { actor: correo }); return res.status(401).json({ error: 'Correo o clave incorrectos.' }); }
    if (u.mfa_enabled) return res.json({ mfa: true, reto: crearReto(u, cfg.sessionSecret) }); // la sesión se emite tras el segundo factor
    await olvidar(intento.ids); // un ingreso correcto no cuenta contra el límite
    await db.run('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), u.id]);
    await audit(req, 'login', { actor_id: u.id, actor: u.email });
    emitir(res, u).json({ user: publico({ ...u, must_mfa: exigeMfa(cfg, u) }) });
  });
  app.post('/api/login/mfa', async (req, res) => {
    const id = leerReto(req.body?.reto, cfg.sessionSecret);
    const u = id && await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u || !u.activo || !u.mfa_enabled) return res.status(401).json({ error: 'La verificación expiró. Inicia sesión de nuevo.' });
    const intento = await registrarIntento([[`m:${u.id}`, MAX_POR_PAR], [`i:${req.ip}`, MAX_POR_IP]]);
    if (intento.bloqueado) { await audit(req, 'mfa_bloqueado', { actor_id: u.id, actor: u.email }); return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' }); }
    const cod = String(req.body?.codigo ?? '');
    let valido = false;
    // Se "consume" el contador con UPDATE condicional: dos envíos paralelos del mismo código no pasan ambos.
    const c = totp.verificar(cifrador.descifrar(u.mfa_secret, `mfa:${u.id}`), cod, Number(u.mfa_ultimo));
    if (c !== null) valido = (await db.run('UPDATE users SET mfa_ultimo = ? WHERE id = ? AND mfa_ultimo < ?', [c, u.id, c])).changes === 1;
    else {
      const h = totp.hashRecuperacion(cod), lista = JSON.parse(u.mfa_recuperacion || '[]');
      if (lista.includes(h)) valido = (await db.run('UPDATE users SET mfa_recuperacion = ? WHERE id = ? AND mfa_recuperacion = ?', [JSON.stringify(lista.filter(x => x !== h)), u.id, u.mfa_recuperacion])).changes === 1;
      if (valido) await audit(req, 'mfa_recuperacion_usada', { actor_id: u.id, actor: u.email, detalle: `quedan ${lista.length - 1}` });
    }
    if (!valido) { await audit(req, 'mfa_fallido', { actor_id: u.id, actor: u.email }); return res.status(401).json({ error: 'Código incorrecto.' }); }
    await olvidar(intento.ids);
    await db.run('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), u.id]);
    await audit(req, 'login', { actor_id: u.id, actor: u.email, detalle: 'con segundo factor' });
    emitir(res, u).json({ user: publico({ ...u, must_mfa: false }) });
  });
  app.post('/api/logout', async (req, res) => { if (req.user && req.user.id !== 'dev') await audit(req, 'logout'); res.set('Set-Cookie', SIN_SESION).json({ ok: true }); });
  app.post('/api/me/password', async (req, res) => {
    if (!req.user || req.user.id === 'dev') return res.status(401).json({ error: 'Inicia sesión.' });
    const { actual, nueva } = req.body || {};
    const intento = await registrarIntento([[`k:${req.user.id}`, MAX_POR_PAR]]);
    if (intento.bloqueado) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const fila = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!(await verificarClave(String(actual ?? ''), fila.pass_hash))) return res.status(401).json({ error: 'La clave actual no es correcta.' });
    await olvidar(intento.ids);
    const err = validarClaveNueva(nueva, actual, req.user.email);
    if (err) return res.status(422).json({ error: err });
    await usuarios.cambiarClave(req.user.id, nueva);
    const fresca = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    await audit(req, 'cambiar_clave');
    emitir(res, fresca).json({ user: publico({ ...fresca, must_mfa: exigeMfa(cfg, fresca) }) });
  });

  // ---- Verificación en dos pasos (TOTP). Estas rutas sirven también cuando MFA es obligatoria y aún no está activa.
  const sesionReal = (req, res) => { if (!req.user || req.user.id === 'dev') { res.status(401).json({ error: 'Inicia sesión.' }); return false; } if (req.user.must_change) { res.status(403).json({ error: 'Debes cambiar tu clave antes de continuar.', code: 'must_change' }); return false; } return true; };
  app.post('/api/me/mfa/setup', async (req, res) => {
    if (!sesionReal(req, res)) return;
    if (req.user.mfa) return res.status(409).json({ error: 'La verificación en dos pasos ya está activa.' });
    const secreto = totp.nuevoSecreto();
    await db.run('UPDATE users SET mfa_secret = ?, mfa_ultimo = 0 WHERE id = ?', [cifrador.cifrar(secreto, `mfa:${req.user.id}`), req.user.id]);
    res.json({ secreto, uri: totp.uri(secreto, req.user.email) });
  });
  app.post('/api/me/mfa/enable', async (req, res) => {
    if (!sesionReal(req, res)) return;
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (u.mfa_enabled || !u.mfa_secret) return res.status(409).json({ error: 'Inicia la configuración de nuevo.' });
    const intento = await registrarIntento([[`m:${u.id}`, MAX_POR_PAR]]);
    if (intento.bloqueado) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const c = totp.verificar(cifrador.descifrar(u.mfa_secret, `mfa:${u.id}`), req.body?.codigo, 0);
    if (c === null) return res.status(401).json({ error: 'Código incorrecto. Revisa la hora del teléfono e inténtalo de nuevo.' });
    await olvidar(intento.ids);
    const codigos = totp.generarRecuperacion();
    await db.run('UPDATE users SET mfa_enabled = TRUE, mfa_ultimo = ?, mfa_recuperacion = ?, session_version = session_version + 1 WHERE id = ?', [c, JSON.stringify(codigos.map(totp.hashRecuperacion)), u.id]);
    await audit(req, 'mfa_activar');
    emitir(res, await db.get('SELECT * FROM users WHERE id = ?', [u.id])).json({ ok: true, recuperacion: codigos }); // se muestran una sola vez
  });
  app.post('/api/me/mfa/disable', async (req, res) => {
    if (!sesionReal(req, res)) return;
    const u = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (exigeMfa(cfg, { ...u, mfa_enabled: false })) return res.status(403).json({ error: 'La política de seguridad exige la verificación en dos pasos para tu cuenta.' });
    const intento = await registrarIntento([[`m:${u.id}`, MAX_POR_PAR]]);
    if (intento.bloqueado) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const okClave = await verificarClave(String(req.body?.clave ?? ''), u.pass_hash);
    const c = u.mfa_enabled && totp.verificar(cifrador.descifrar(u.mfa_secret, `mfa:${u.id}`), req.body?.codigo, Number(u.mfa_ultimo));
    if (!okClave || c === null || c === false) return res.status(401).json({ error: 'Clave o código incorrectos.' });
    await olvidar(intento.ids);
    await db.run("UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_recuperacion = '[]', session_version = session_version + 1 WHERE id = ?", [u.id]);
    await audit(req, 'mfa_desactivar');
    emitir(res, await db.get('SELECT * FROM users WHERE id = ?', [u.id])).json({ ok: true });
  });

  const api = express.Router();
  api.use(requiere('lector'));
  const esAdmin = req => req.user.rol === 'admin';
  const visible = (req, t) => t && (esAdmin(req) || (t.tipo === 'actividad' && ['pendiente', 'cerrada'].includes(t.estado) && (t.area === req.user.area || t.area === 'Todos')));
  /** Un miembro solo edita actividades de SU dirección; lo de "Todos" lo gestiona el admin. */
  const puedeEditar = (req, t) => esAdmin(req) || (req.user.rol === 'miembro' && t.tipo === 'actividad' && t.estado !== 'propuesta' && t.area === req.user.area);
  const cargar = async (req, res) => {
    const t = await store.get(req.params.id);
    if (!visible(req, t)) { res.status(404).json({ error: 'No existe.' }); return null; }
    return t;
  };
  const cargarEditable = async (req, res) => {
    const t = await cargar(req, res); if (!t) return null;
    if (!puedeEditar(req, t)) { res.status(403).json({ error: 'No tienes permiso para modificar esto.' }); return null; }
    return t;
  };
  const alcance = req => (esAdmin(req) ? null : req.user.area);

  api.get('/tasks', async (req, res) => res.json({ tasks: await store.listar({ incluirPagos: esAdmin(req), area: alcance(req) }) }));
  api.get('/summary', async (req, res) => res.json(await store.resumen(esAdmin(req), alcance(req))));
  api.get('/tasks/:id/events', async (req, res) => { if (await cargar(req, res)) res.json({ events: await store.eventos(req.params.id) }); });

  api.post('/tasks', requiere('miembro'), async (req, res) => {
    const tipo = req.body?.tipo === 'pago' ? 'pago' : 'actividad';
    if (tipo === 'pago' && !esAdmin(req)) return res.status(403).json({ error: 'Solo el administrador gestiona pagos.' });
    const cuerpo = esAdmin(req) ? req.body || {} : { ...req.body, area: req.user.area }; // un miembro solo crea en su dirección
    const { error, valor } = validarTarea(cuerpo, { tipo });
    if (error) return res.status(422).json({ error });
    res.status(201).json({ task: await store.crear(req.actor, valor, { tipo }) });
  });
  api.patch('/tasks/:id', requiere('miembro'), async (req, res) => {
    const t = await cargarEditable(req, res); if (!t) return;
    const cuerpo = esAdmin(req) ? req.body || {} : { ...req.body, area: t.area };
    const { error, valor } = validarTarea(cuerpo, { tipo: t.tipo, parcial: true });
    if (error) return res.status(422).json({ error });
    res.json({ task: await store.actualizar(req.actor, t.id, valor, Number.isInteger(req.body?.version) ? req.body.version : undefined) });
  });
  api.post('/tasks/:id/transition', requiere('miembro'), async (req, res) => {
    const t = await cargarEditable(req, res); if (!t) return;
    const accion = req.body?.accion;
    if (['descartar', 'restaurar', 'confirmar'].includes(accion) && !esAdmin(req)) return res.status(403).json({ error: 'Solo el administrador puede hacer esto.' });
    res.json(await store.transicion(req.actor, t.id, accion));
  });
  api.delete('/tasks/:id', requiere('admin'), async (req, res) => { await store.eliminar(req.actor, req.params.id); res.status(204).end(); });
  api.post('/meetings/confirm', requiere('admin'), async (req, res) => res.json(await store.confirmarReunion(req.actor, String(req.body?.origen ?? ''))));

  // ---- Usuarios (solo administrador)
  api.get('/users', requiere('admin'), async (_req, res) => res.json({ users: await usuarios.listar() }));
  api.post('/users', requiere('admin'), async (req, res) => { const r = await usuarios.crear(req.user, req.body || {}); await audit(req, 'usuario_crear', { entidad: 'usuario', entidad_id: r.usuario.id, detalle: `${r.usuario.rol} · cartera ${r.usuario.acceso_cartera}` }); res.status(201).json(r); });
  api.patch('/users/:id', requiere('admin'), async (req, res) => { const u = await usuarios.actualizar(req.user, req.params.id, req.body || {}); await audit(req, 'usuario_editar', { entidad: 'usuario', entidad_id: u.id, detalle: `campos: ${Object.keys(req.body || {}).filter(k => k !== 'version').join(', ')}` }); res.json({ user: u }); });
  api.post('/users/:id/reset', requiere('admin'), async (req, res) => { const r = await usuarios.restablecer(req.user, req.params.id); await audit(req, 'usuario_reset_clave', { entidad: 'usuario', entidad_id: req.params.id }); res.json(r); });
  api.post('/users/:id/mfa/reset', requiere('admin'), async (req, res) => {
    const r = await db.run("UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_recuperacion = '[]', session_version = session_version + 1 WHERE id = ?", [req.params.id]);
    if (!r.changes) return res.status(404).json({ error: 'No existe.' });
    await audit(req, 'usuario_reset_mfa', { entidad: 'usuario', entidad_id: req.params.id }); res.json({ ok: true });
  });

  // ---- Bandeja: propuestas (solo admin) y su alta manual
  api.get('/proposals', requiere('admin'), async (_req, res) => res.json({ tasks: (await store.listar({ incluirPagos: true })).filter(t => t.estado === 'propuesta' || t.estado === 'descartada') }));
  api.post('/proposals', requiere('admin'), async (req, res) => {
    const out = [];
    for (const x of Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : []) {
      const tipo = x.tipo === 'pago' ? 'pago' : 'actividad';
      const { error, valor } = validarTarea(x, { tipo });
      if (error) return res.status(422).json({ error: `${x.titulo || '(sin título)'}: ${error}` });
      out.push({ tipo, valor });
    }
    for (const o of out) await store.crear(req.actor, o.valor, { tipo: o.tipo, estado: 'propuesta' });
    res.status(201).json({ creadas: out.length });
  });

  // ---- Exportar / importar / backup
  api.get('/export', requiere('admin'), async (_req, res) => res.set('Content-Disposition', 'attachment; filename="liva-export.json"').json(await exportar(db)));
  api.get('/export.csv', requiere('admin'), async (req, res) => {
    const tipo = req.query.tipo === 'pago' ? 'pago' : 'actividad';
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="liva-${tipo}s.csv"`)
      .send(aCsv((await store.listar({ incluirPagos: true })).filter(t => t.tipo === tipo && t.estado !== 'propuesta')));
  });
  api.post('/import', requiere('admin'), async (req, res) => {
    const r = normalizarImport(req.body);
    if (r.error) return res.status(422).json({ error: r.error });
    if (req.query.dry === '1') return res.json({ validas: r.filas.length, rechazos: r.rechazos });
    res.json({ ...(await importar(db, r.filas)), rechazos: r.rechazos });
  });

  // ---- GitHub
  const guardarLink = (taskId, l) => db.run(`INSERT INTO github_links(task_id,repo,tipo,numero,titulo,url,estado,synced_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(repo,tipo,numero) DO UPDATE SET titulo=excluded.titulo, estado=excluded.estado, synced_at=excluded.synced_at`,
    [taskId, l.repo, l.tipo, l.numero, l.titulo, l.url, l.estado, new Date().toISOString()]);
  const linksDe = id => db.all('SELECT * FROM github_links WHERE task_id = ?', [id]);
  api.get('/tasks/:id/links', async (req, res) => { if (await cargar(req, res)) res.json({ links: await linksDe(req.params.id) }); });
  api.post('/tasks/:id/issue', requiere('miembro'), async (req, res) => {
    const t = await cargarEditable(req, res); if (!t) return;
    if (t.tipo === 'pago') return res.status(422).json({ error: 'Los pagos no se publican en GitHub.' });
    const cuerpo = [t.notas, `\n---\nCategoría: ${t.categoria} · Dirección: ${t.area}${t.fecha_limite ? ' · Fecha límite: ' + t.fecha_limite : ''}`].join('\n').trim();
    const l = await gh.crearIssue(req.body?.repo, { titulo: t.titulo, cuerpo });
    await guardarLink(t.id, l); await store.evento(t.id, req.actor, 'github', `Issue ${l.repo}#${l.numero}`);
    res.status(201).json({ link: l });
  });
  api.post('/tasks/:id/links', requiere('miembro'), async (req, res) => {
    const t = await cargarEditable(req, res); if (!t) return;
    const l = await gh.obtener(req.body?.repo, Number(req.body?.numero));
    const previo = await db.get('SELECT task_id FROM github_links WHERE repo=? AND tipo=? AND numero=?', [l.repo, l.tipo, l.numero]);
    if (previo && previo.task_id !== t.id) return res.status(409).json({ error: 'Ese issue ya está vinculado a otra actividad.' });
    await guardarLink(t.id, l); await store.evento(t.id, req.actor, 'github', `Vinculado ${l.repo}#${l.numero}`);
    res.status(201).json({ link: l });
  });
  api.post('/tasks/:id/links/refresh', requiere('miembro'), async (req, res) => {
    const t = await cargarEditable(req, res); if (!t) return;
    for (const l of await linksDe(t.id)) await guardarLink(t.id, await gh.obtener(l.repo, l.numero));
    res.json({ links: await linksDe(t.id) });
  });
  api.delete('/links/:id', requiere('miembro'), async (req, res) => {
    const l = await db.get('SELECT task_id FROM github_links WHERE id = ?', [Number(req.params.id)]);
    const t = l && await store.get(l.task_id);
    if (!t || !puedeEditar(req, t)) return res.status(404).json({ error: 'No existe.' });
    await db.run('DELETE FROM github_links WHERE id = ?', [Number(req.params.id)]); res.status(204).end();
  });
  api.get('/github/issues', requiere('admin'), async (req, res) => {
    const lista = await gh.listarAbiertos(req.query.repo);
    const ya = new Set((await db.all('SELECT repo, tipo, numero FROM github_links')).map(l => `${l.repo}/${l.tipo}/${l.numero}`));
    res.json({ issues: lista.map(i => ({ ...i, importado: ya.has(`${i.repo}/${i.tipo}/${i.numero}`) })) });
  });
  api.post('/github/import', requiere('admin'), async (req, res) => {
    const lista = (await gh.listarAbiertos(req.body?.repo)).filter(i => i.tipo === 'issue' && (!req.body?.numeros || req.body.numeros.includes(i.numero)));
    let creadas = 0;
    for (const i of lista) {
      if (await db.get('SELECT 1 FROM github_links WHERE repo=? AND tipo=? AND numero=?', [i.repo, i.tipo, i.numero])) continue;
      const t = await store.crear(req.actor, { titulo: i.titulo || `${i.repo}#${i.numero}`, categoria: 'prioritario', area: 'Todos', origen: `GitHub ${i.repo}` }, { tipo: 'actividad', estado: 'propuesta' });
      await guardarLink(t.id, i); creadas++;
    }
    res.json({ creadas });
  });

  // ---- Cartera (matriz financiera). El alcance por usuario se aplica en src/cartera.js; aquí solo se enruta.
  const ctx = req => ({ ip: req.ip });
  api.get('/cartera/resumen', async (req, res) => res.json(await cartera.resumen(req.user)));
  api.get('/cartera/clientes', async (req, res) => res.json({ clientes: await cartera.listar(req.user, { q: String(req.query.q ?? '').slice(0, 80) }, ctx(req)) }));
  api.get('/cartera/clientes/:id', async (req, res) => { const c = await cartera.obtener(req.user, req.params.id, ctx(req)); if (!c) return res.status(404).json({ error: 'No existe.' }); res.json({ cliente: c }); });
  api.post('/cartera/clientes', async (req, res) => res.status(201).json({ cliente: await cartera.crear(req.user, req.body, ctx(req)) }));
  api.patch('/cartera/clientes/:id', async (req, res) => res.json({ cliente: await cartera.actualizar(req.user, req.params.id, req.body, ctx(req)) }));
  api.post('/cartera/clientes/:id/pagos', async (req, res) => { const r = await cartera.registrarPago(req.user, req.params.id, req.body, ctx(req)); res.status(r.repetido ? 200 : 201).json(r); });
  api.post('/cartera/pagos/:id/anular', async (req, res) => { await cartera.anularPago(req.user, req.params.id, req.body?.motivo, ctx(req)); res.json({ ok: true }); });
  api.post('/cartera/clientes/:id/anonimizar', async (req, res) => { await cartera.anonimizar(req.user, req.params.id, ctx(req)); res.json({ ok: true }); });
  api.get('/cartera/flujo', async (req, res) => res.json({ filas: await cartera.flujo(req.user) }));
  api.get('/cartera/export.csv', async (req, res) => res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="cartera.csv"').send(await cartera.exportarCsv(req.user, ctx(req))));
  api.get('/cartera/asesores', requiere('admin'), async (_req, res) => res.json({ asesores: (await db.all('SELECT id, nombre, email FROM users WHERE activo = TRUE ORDER BY nombre')) }));
  api.post('/cartera/import', requiere('admin'), async (req, res) => {
    const csv = String(req.body?.csv ?? '');
    res.json(req.query.dry === '1' ? await importador.simular(req.user, csv, ctx(req)) : await importador.aplicar(req.user, csv, { permitirParcial: req.query.parcial === '1' }, ctx(req)));
  });
  api.get('/cartera/auditoria', requiere('admin'), async (req, res) => res.json({ eventos: await auditoria.listar({ limite: req.query.limite, entidad_id: req.query.entidad_id, actor: req.query.actor, accion: req.query.accion }) }));
  api.get('/cartera/auditoria/verificar', requiere('admin'), async (_req, res) => res.json(await auditoria.verificar()));

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado.' }));
  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: cfg.prod ? '1h' : 0 }));

  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : err.code === '23505' ? 409 : err.code === '23514' ? 422 : 500);
    if (!err.status && err.code === '23505') err.message = 'Ya existe un registro igual.';
    if (!err.status && err.code === '23514') err.message = 'Los datos no cumplen las reglas de validación.';
    const id = randomUUID().slice(0, 8);
    if (status >= 500) console.error(JSON.stringify({ level: 'error', id, path: req.path, msg: err.message }));
    res.status(status).json({ error: status >= 500 && !(err instanceof GitHubError) ? `Error interno (ref ${id}).` : err.message });
  });
  return app;
}
