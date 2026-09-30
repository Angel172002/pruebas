import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AREAS, CATEGORIAS } from './config.js';
import { anticsrf, authMiddleware, cookieOpts, crearSesion, limiteLogin, requiere, rolPorToken } from './auth.js';
import { validarTarea } from './domain.js';
import { crearStore } from './store.js';
import { aCsv, exportar, importar, normalizarImport } from './portability.js';
import { GitHubError, crearGitHub } from './services/github.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function crearApp({ cfg, db, fetchImpl }) {
  const app = express();
  const store = crearStore(db);
  const gh = crearGitHub({ token: cfg.githubToken, repos: cfg.githubRepos, fetchImpl });
  app.disable('x-powered-by');
  if (cfg.prod) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      ...(cfg.prod ? { 'Strict-Transport-Security': 'max-age=15552000' } : {})
    });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => { try { await db.get('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });

  app.use(express.json({ limit: '2mb' }));
  app.use(authMiddleware(cfg), anticsrf);

  // ---- Sesión
  app.get('/api/session', (req, res) => res.json({
    rol: req.rol, areas: AREAS, categorias: CATEGORIAS, github: { configurado: gh.configurado(), repos: gh.repos() }
  }));
  app.post('/api/login', limiteLogin, (req, res) => {
    const rol = rolPorToken(req.body?.token, cfg);
    if (!rol) return res.status(401).json({ error: 'Clave incorrecta.' });
    res.set('Set-Cookie', `sid=${crearSesion(rol, cfg.sessionSecret)}; ${cookieOpts(cfg)}`).json({ rol });
  });
  app.post('/api/logout', (_req, res) => res.set('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0').json({ ok: true }));

  const api = express.Router();
  api.use(requiere('viewer'));
  const esOwner = req => req.rol === 'owner';
  const visible = (req, t) => t && (esOwner(req) || (t.tipo === 'actividad' && ['pendiente', 'cerrada'].includes(t.estado)));
  const cargar = async (req, res) => {
    const t = await store.get(req.params.id);
    if (!visible(req, t)) { res.status(404).json({ error: 'No existe.' }); return null; }
    return t;
  };

  api.get('/tasks', async (req, res) => res.json({ tasks: await store.listar({ incluirPagos: esOwner(req) }) }));
  api.get('/summary', async (req, res) => res.json(await store.resumen(esOwner(req))));
  api.get('/tasks/:id/events', async (req, res) => { if (await cargar(req, res)) res.json({ events: await store.eventos(req.params.id) }); });

  api.post('/tasks', requiere('editor'), async (req, res) => {
    const tipo = req.body?.tipo === 'pago' ? 'pago' : 'actividad';
    if (tipo === 'pago' && !esOwner(req)) return res.status(403).json({ error: 'Solo el owner gestiona pagos.' });
    const { error, valor } = validarTarea(req.body || {}, { tipo });
    if (error) return res.status(422).json({ error });
    res.status(201).json({ task: await store.crear(req.actor, valor, { tipo }) });
  });
  api.patch('/tasks/:id', requiere('editor'), async (req, res) => {
    const t = await cargar(req, res); if (!t) return;
    if (t.estado === 'propuesta' && !esOwner(req)) return res.status(403).json({ error: 'Sin permiso.' });
    const { error, valor } = validarTarea(req.body || {}, { tipo: t.tipo, parcial: true });
    if (error) return res.status(422).json({ error });
    res.json({ task: await store.actualizar(req.actor, t.id, valor, Number.isInteger(req.body.version) ? req.body.version : undefined) });
  });
  api.post('/tasks/:id/transition', requiere('editor'), async (req, res) => {
    const t = await cargar(req, res); if (!t) return;
    const accion = req.body?.accion;
    if (['descartar', 'restaurar', 'confirmar'].includes(accion) && !esOwner(req)) return res.status(403).json({ error: 'Solo el owner puede hacer esto.' });
    res.json(await store.transicion(req.actor, t.id, accion));
  });
  api.delete('/tasks/:id', requiere('owner'), async (req, res) => { await store.eliminar(req.actor, req.params.id); res.status(204).end(); });
  api.post('/meetings/confirm', requiere('owner'), async (req, res) => res.json(await store.confirmarReunion(req.actor, String(req.body?.origen ?? ''))));

  // ---- Bandeja: propuestas (solo owner) y su alta manual
  api.get('/proposals', requiere('owner'), async (_req, res) => res.json({ tasks: (await store.listar({ incluirPagos: true })).filter(t => t.estado === 'propuesta' || t.estado === 'descartada') }));
  api.post('/proposals', requiere('owner'), async (req, res) => {
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
  api.get('/export', requiere('owner'), async (_req, res) => res.set('Content-Disposition', 'attachment; filename="liva-export.json"').json(await exportar(db)));
  api.get('/export.csv', requiere('owner'), async (req, res) => {
    const tipo = req.query.tipo === 'pago' ? 'pago' : 'actividad';
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="liva-${tipo}s.csv"`)
      .send(aCsv((await store.listar({ incluirPagos: true })).filter(t => t.tipo === tipo && t.estado !== 'propuesta')));
  });
  api.post('/import', requiere('owner'), async (req, res) => {
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
  api.post('/tasks/:id/issue', requiere('editor'), async (req, res) => {
    const t = await cargar(req, res); if (!t) return;
    if (t.tipo === 'pago') return res.status(422).json({ error: 'Los pagos no se publican en GitHub.' });
    const cuerpo = [t.notas, `\n---\nCategoría: ${t.categoria} · Dirección: ${t.area}${t.fecha_limite ? ' · Fecha límite: ' + t.fecha_limite : ''}`].join('\n').trim();
    const l = await gh.crearIssue(req.body?.repo, { titulo: t.titulo, cuerpo });
    await guardarLink(t.id, l); await store.evento(t.id, req.actor, 'github', `Issue ${l.repo}#${l.numero}`);
    res.status(201).json({ link: l });
  });
  api.post('/tasks/:id/links', requiere('editor'), async (req, res) => {
    const t = await cargar(req, res); if (!t) return;
    const l = await gh.obtener(req.body?.repo, Number(req.body?.numero));
    await guardarLink(t.id, l); await store.evento(t.id, req.actor, 'github', `Vinculado ${l.repo}#${l.numero}`);
    res.status(201).json({ link: l });
  });
  api.post('/tasks/:id/links/refresh', requiere('editor'), async (req, res) => {
    const t = await cargar(req, res); if (!t) return;
    for (const l of await linksDe(t.id)) await guardarLink(t.id, await gh.obtener(l.repo, l.numero));
    res.json({ links: await linksDe(t.id) });
  });
  api.delete('/links/:id', requiere('editor'), async (req, res) => { await db.run('DELETE FROM github_links WHERE id = ?', [Number(req.params.id)]); res.status(204).end(); });
  api.get('/github/issues', requiere('editor'), async (req, res) => {
    const lista = await gh.listarAbiertos(req.query.repo);
    const ya = new Set((await db.all('SELECT repo, tipo, numero FROM github_links')).map(l => `${l.repo}/${l.tipo}/${l.numero}`));
    res.json({ issues: lista.map(i => ({ ...i, importado: ya.has(`${i.repo}/${i.tipo}/${i.numero}`) })) });
  });
  api.post('/github/import', requiere('owner'), async (req, res) => {
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
