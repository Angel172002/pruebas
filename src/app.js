import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AREAS, CATEGORIAS } from './config.js';
import { anticsrf, authMiddleware, cookieOpts, crearSesion, hashFalso, requiere, validarClaveNueva, verificarClave } from './auth.js';
import { validarTarea } from './domain.js';
import { crearStore } from './store.js';
import { crearUsuarios, esCorreo } from './users.js';
import { aCsv, exportar, importar, normalizarImport } from './portability.js';
import { GitHubError, crearGitHub } from './services/github.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VENTANA_MS = 15 * 60000, MAX_POR_CORREO = 8, MAX_POR_IP = 40;
const SIN_SESION = 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

export function crearApp({ cfg, db, fetchImpl }) {
  const app = express();
  const store = crearStore(db);
  const usuarios = crearUsuarios(db);
  const gh = crearGitHub({ token: cfg.githubToken, repos: cfg.githubRepos, fetchImpl });
  app.disable('x-powered-by');
  if (cfg.prod) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      ...(cfg.prod ? { 'Strict-Transport-Security': 'max-age=15552000' } : {})
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
    user: req.user, areas: req.user ? areasDe(req.user) : [], categorias: CATEGORIAS,
    github: { configurado: gh.configurado(), repos: req.user?.rol === 'admin' || req.user?.rol === 'miembro' ? gh.repos() : [] }
  }));

  // Bloqueo por intentos fallidos (en base de datos: sirve entre instancias serverless).
  async function bloqueado(claves) {
    const desde = Date.now() - VENTANA_MS;
    for (const [clave, max] of claves) {
      const n = Number((await db.get('SELECT count(*) AS n FROM login_attempts WHERE clave = ? AND at_ms > ?', [clave, desde])).n);
      if (n >= max) return true;
    }
    return false;
  }
  app.post('/api/login', async (req, res) => {
    const correo = String(req.body?.email ?? '').trim().toLowerCase(), clave = String(req.body?.password ?? '');
    const kc = `c:${correo.slice(0, 120)}`, ki = `i:${req.ip}`;
    if (await bloqueado([[kc, MAX_POR_CORREO], [ki, MAX_POR_IP]])) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    const u = esCorreo(correo) && clave.length <= 128 ? await db.get('SELECT * FROM users WHERE email = ?', [correo]) : undefined;
    const ok = await verificarClave(clave, u ? u.pass_hash : await hashFalso()) && u && u.activo;
    if (!ok) {
      const t = Date.now();
      await db.run('INSERT INTO login_attempts(clave, at_ms) VALUES (?,?), (?,?)', [kc, t, ki, t]);
      await db.run('DELETE FROM login_attempts WHERE at_ms < ?', [t - VENTANA_MS]);
      return res.status(401).json({ error: 'Correo o clave incorrectos.' });
    }
    await db.run('DELETE FROM login_attempts WHERE clave = ?', [kc]);
    await db.run('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), u.id]);
    res.set('Set-Cookie', `sid=${crearSesion(u, cfg.sessionSecret)}; ${cookieOpts(cfg)}`)
      .json({ user: { id: u.id, email: u.email, nombre: u.nombre, rol: u.rol, area: u.area, must_change: Boolean(u.must_change) } });
  });
  app.post('/api/logout', (_req, res) => res.set('Set-Cookie', SIN_SESION).json({ ok: true }));
  app.post('/api/me/password', async (req, res) => {
    if (!req.user || req.user.id === 'dev') return res.status(401).json({ error: 'Inicia sesión.' });
    const { actual, nueva } = req.body || {};
    const fila = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!(await verificarClave(String(actual ?? ''), fila.pass_hash))) return res.status(401).json({ error: 'La clave actual no es correcta.' });
    const err = validarClaveNueva(nueva, actual);
    if (err) return res.status(422).json({ error: err });
    const u = await usuarios.cambiarClave(req.user.id, nueva);
    const fresca = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.set('Set-Cookie', `sid=${crearSesion(fresca, cfg.sessionSecret)}; ${cookieOpts(cfg)}`).json({ user: u });
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
    res.json({ task: await store.actualizar(req.actor, t.id, valor, Number.isInteger(req.body.version) ? req.body.version : undefined) });
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
  api.post('/users', requiere('admin'), async (req, res) => res.status(201).json(await usuarios.crear(req.user, req.body || {})));
  api.patch('/users/:id', requiere('admin'), async (req, res) => res.json({ user: await usuarios.actualizar(req.user, req.params.id, req.body || {}) }));
  api.post('/users/:id/reset', requiere('admin'), async (req, res) => res.json(await usuarios.restablecer(req.user, req.params.id)));

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

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado.' }));
  app.use(express.static(PUBLIC, { index: 'index.html', maxAge: cfg.prod ? '1h' : 0 }));

  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    const id = randomUUID().slice(0, 8);
    if (status >= 500) console.error(JSON.stringify({ level: 'error', id, path: req.path, msg: err.message }));
    res.status(status).json({ error: status >= 500 && !(err instanceof GitHubError) ? `Error interno (ref ${id}).` : err.message });
  });
  return app;
}
