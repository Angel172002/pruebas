import express from 'express';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
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
  app.get('/readyz', (_req, res) => { try { db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });

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
  const cargar = (req, res) => {
    const t = store.get(req.params.id);
    if (!visible(req, t)) { res.status(404).json({ error: 'No existe.' }); return null; }
    return t;
  };

  api.get('/tasks', (req, res) => res.json({ tasks: store.listar({ incluirPagos: esOwner(req) }) }));
  api.get('/summary', (req, res) => res.json(store.resumen(esOwner(req))));
  api.get('/tasks/:id/events', (req, res) => { if (cargar(req, res)) res.json({ events: store.eventos(req.params.id) }); });

  api.post('/tasks', requiere('editor'), (req, res) => {
    const tipo = req.body?.tipo === 'pago' ? 'pago' : 'actividad';
    if (tipo === 'pago' && !esOwner(req)) return res.status(403).json({ error: 'Solo el owner gestiona pagos.' });
    const { error, valor } = validarTarea(req.body || {}, { tipo });
    if (error) return res.status(422).json({ error });
    res.status(201).json({ task: store.crear(req.actor, valor, { tipo }) });
  });
  api.patch('/tasks/:id', requiere('editor'), (req, res) => {
    const t = cargar(req, res); if (!t) return;
    if (t.estado === 'propuesta' && !esOwner(req)) return res.status(403).json({ error: 'Sin permiso.' });
    const { error, valor } = validarTarea(req.body || {}, { tipo: t.tipo, parcial: true });
    if (error) return res.status(422).json({ error });
    res.json({ task: store.actualizar(req.actor, t.id, valor, Number.isInteger(req.body.version) ? req.body.version : undefined) });
  });
  api.post('/tasks/:id/transition', requiere('editor'), (req, res) => {
    const t = cargar(req, res); if (!t) return;
    const accion = req.body?.accion;
    if (['descartar', 'restaurar', 'confirmar'].includes(accion) && !esOwner(req)) return res.status(403).json({ error: 'Solo el owner puede hacer esto.' });
    res.json(store.transicion(req.actor, t.id, accion));
  });
  api.delete('/tasks/:id', requiere('owner'), (req, res) => { store.eliminar(req.actor, req.params.id); res.status(204).end(); });
  api.post('/meetings/confirm', requiere('owner'), (req, res) => res.json(store.confirmarReunion(req.actor, String(req.body?.origen ?? ''))));

  // ---- Bandeja: propuestas (solo owner) y su alta manual
  api.get('/proposals', requiere('owner'), (_req, res) => res.json({ tasks: store.listar({ incluirPagos: true }).filter(t => t.estado === 'propuesta' || t.estado === 'descartada') }));
  api.post('/proposals', requiere('owner'), (req, res) => {
    const out = [];
    for (const x of Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : []) {
      const tipo = x.tipo === 'pago' ? 'pago' : 'actividad';
      const { error, valor } = validarTarea(x, { tipo });
      if (error) return res.status(422).json({ error: `${x.titulo || '(sin título)'}: ${error}` });
      out.push({ tipo, valor });
    }
    db.transaction(() => out.forEach(o => store.crear(req.actor, o.valor, { tipo: o.tipo, estado: 'propuesta' })))();
    res.status(201).json({ creadas: out.length });
  });

  // ---- Exportar / importar / backup
  api.get('/export', requiere('owner'), (_req, res) => res.set('Content-Disposition', 'attachment; filename="liva-export.json"').json(exportar(db)));
  api.get('/export.csv', requiere('owner'), (req, res) => {
    const tipo = req.query.tipo === 'pago' ? 'pago' : 'actividad';
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="liva-${tipo}s.csv"`)
      .send(aCsv(store.listar({ incluirPagos: true }).filter(t => t.tipo === tipo && t.estado !== 'propuesta')));
  });
  api.post('/import', requiere('owner'), (req, res) => {
    const r = normalizarImport(req.body);
    if (r.error) return res.status(422).json({ error: r.error });
    if (req.query.dry === '1') return res.json({ validas: r.filas.length, rechazos: r.rechazos });
    res.json({ ...importar(db, r.filas), rechazos: r.rechazos });
  });

  // ---- GitHub
  const guardarLink = (taskId, l) => db.prepare(`INSERT INTO github_links(task_id,repo,tipo,numero,titulo,url,estado,synced_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(repo,tipo,numero) DO UPDATE SET titulo=excluded.titulo, estado=excluded.estado, synced_at=excluded.synced_at`)
    .run(taskId, l.repo, l.tipo, l.numero, l.titulo, l.url, l.estado, new Date().toISOString());
  api.get('/tasks/:id/links', (req, res) => { if (cargar(req, res)) res.json({ links: db.prepare('SELECT * FROM github_links WHERE task_id = ?').all(req.params.id) }); });
  api.post('/tasks/:id/issue', requiere('editor'), wrap(async (req, res) => {
    const t = cargar(req, res); if (!t) return;
    if (t.tipo === 'pago') return res.status(422).json({ error: 'Los pagos no se publican en GitHub.' });
    const cuerpo = [t.notas, `\n---\nCategoría: ${t.categoria} · Dirección: ${t.area}${t.fecha_limite ? ' · Fecha límite: ' + t.fecha_limite : ''}`].join('\n').trim();
    const l = await gh.crearIssue(req.body?.repo, { titulo: t.titulo, cuerpo });
    guardarLink(t.id, l); store.evento(t.id, req.actor, 'github', `Issue ${l.repo}#${l.numero}`);
    res.status(201).json({ link: l });
  }));
  api.post('/tasks/:id/links', requiere('editor'), wrap(async (req, res) => {
    const t = cargar(req, res); if (!t) return;
    const l = await gh.obtener(req.body?.repo, Number(req.body?.numero));
    guardarLink(t.id, l); store.evento(t.id, req.actor, 'github', `Vinculado ${l.repo}#${l.numero}`);
    res.status(201).json({ link: l });
  }));
  api.post('/tasks/:id/links/refresh', requiere('editor'), wrap(async (req, res) => {
    const t = cargar(req, res); if (!t) return;
    const links = db.prepare('SELECT * FROM github_links WHERE task_id = ?').all(t.id);
    for (const l of links) guardarLink(t.id, await gh.obtener(l.repo, l.numero));
    res.json({ links: db.prepare('SELECT * FROM github_links WHERE task_id = ?').all(t.id) });
  }));
  api.delete('/links/:id', requiere('editor'), (req, res) => { db.prepare('DELETE FROM github_links WHERE id = ?').run(Number(req.params.id)); res.status(204).end(); });
  api.get('/github/issues', requiere('editor'), wrap(async (req, res) => {
    const lista = await gh.listarAbiertos(req.query.repo);
    const ya = new Set(db.prepare('SELECT repo, tipo, numero FROM github_links').all().map(l => `${l.repo}/${l.tipo}/${l.numero}`));
    res.json({ issues: lista.map(i => ({ ...i, importado: ya.has(`${i.repo}/${i.tipo}/${i.numero}`) })) });
  }));
  api.post('/github/import', requiere('owner'), wrap(async (req, res) => {
    const lista = (await gh.listarAbiertos(req.body?.repo)).filter(i => i.tipo === 'issue' && (!req.body?.numeros || req.body.numeros.includes(i.numero)));
    let creadas = 0;
    for (const i of lista) {
      if (db.prepare('SELECT 1 FROM github_links WHERE repo=? AND tipo=? AND numero=?').get(i.repo, i.tipo, i.numero)) continue;
      const t = store.crear(req.actor, { titulo: i.titulo || `${i.repo}#${i.numero}`, categoria: 'prioritario', area: 'Todos', origen: `GitHub ${i.repo}` }, { tipo: 'actividad', estado: 'propuesta' });
      guardarLink(t.id, i); creadas++;
    }
    res.json({ creadas });
  }));

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

/** Copia consistente de la base con rotación. */
export async function hacerBackup(db, dir, keep) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `liva-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await db.backup(f);
  const viejos = readdirSync(dir).filter(n => /^liva-.*\.db$/.test(n)).map(n => [n, statSync(join(dir, n)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(keep);
  viejos.forEach(([n]) => unlinkSync(join(dir, n)));
  return f;
}
