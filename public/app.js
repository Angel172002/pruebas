import { api, ApiError } from './api.js';

const CATS = {
  urgente:     { nombre: 'Urgente',     regla: 'Mismo día, máximo 2 días',              ayuda: 'Lo resuelves hoy o, a más tardar, en 2 días.' },
  prioritario: { nombre: 'Prioritario', regla: 'Se gestiona con el equipo, 3 a 5 días', ayuda: 'Lo trabajas junto con un área y haces seguimiento en la daily o el comité.' },
  importante:  { nombre: 'Importante',  regla: 'Se delega, 3 a 5 días',                 ayuda: 'Lo entregas a un área y verificas que cierre en 3 a 5 días.' }
};
const ORDEN = ['urgente', 'prioritario', 'importante'];
const TODOS = 'Todos', GENERAL = 'Dirección General';
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const $ = s => document.querySelector(s);

const S = { rol: null, cfg: null, tasks: [], props: [], resumen: null, cargado: false, error: '',
  ui: { tab: 'actividades', dir: 'todas', estado: 'abiertas', q: '' }, abiertas: new Set() };
try { S.ui.dir = localStorage.getItem('liva-dir') || 'todas'; } catch {}

/* ---------- utilidades ---------- */
function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of hijos.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const pesos = n => COP.format(n || 0);
const fmtFecha = f => new Date(f + 'T12:00:00Z').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
function fechaTxt(t) {
  const n = t.dias; if (n === null || n === undefined) return '';
  if (n < -1) return `Venció hace ${-n} días`;
  if (n === -1) return 'Venció ayer'; if (n === 0) return 'Vence hoy'; if (n === 1) return 'Vence mañana';
  return n < 7 ? `Vence en ${n} días` : 'Vence ' + fmtFecha(t.fecha_limite);
}
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const soloDigitos = v => { const s = String(v).replace(/\./g, '').replace(/[\s$]/g, ''); return /^\d{1,13}$/.test(s) ? Number(s) : (s === '' ? null : NaN); };

/* ---------- toasts con deshacer ---------- */
function toast(msg, deshacer) {
  const cont = $('#toasts');
  const t = h('div', { class: 'toast' }, h('span', { text: msg }));
  let timer;
  const quitar = () => { clearTimeout(timer); t.remove(); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(quitar, deshacer ? 9000 : 6000); };
  if (deshacer) t.append(h('button', { type: 'button', text: 'Deshacer', onclick: async () => { quitar(); try { await deshacer(); } catch (e) { fallo(e); } } }));
  t.append(h('button', { type: 'button', 'aria-label': 'Cerrar aviso', text: '✕', onclick: quitar }));
  t.addEventListener('mouseenter', () => clearTimeout(timer)); t.addEventListener('mouseleave', arm);
  t.addEventListener('focusin', () => clearTimeout(timer)); t.addEventListener('focusout', arm);
  cont.append(t); while (cont.children.length > 4) cont.firstChild.remove(); arm();
}
function fallo(e) {
  if (e instanceof ApiError && e.status === 401) { S.rol = null; return mostrar(); }
  toast(e.message || 'No se pudo completar la acción.');
}

/* ---------- carga de datos ---------- */
async function cargar() {
  try {
    const [t, r] = await Promise.all([api.get('/tasks'), api.get('/summary')]);
    S.tasks = t.tasks; S.resumen = r;
    S.props = S.rol === 'owner' ? (await api.get('/proposals')).tasks : [];
    S.error = ''; S.cargado = true;
  } catch (e) {
    if (e.status === 401) { S.rol = null; return mostrar(); }
    S.error = 'No se pudo actualizar desde el servidor. Mostrando los últimos datos.'; S.cargado = true;
  }
  render();
}
async function arrancar() {
  try {
    const s = await api.get('/session');
    S.cfg = s; S.rol = s.rol;
    if (S.rol) poblarSelects();
  } catch { S.error = 'No hay conexión con el servidor.'; }
  mostrar();
  if (S.rol) { render(); await cargar(); }
}
function mostrar() {
  $('#login').hidden = Boolean(S.rol); $('#app').hidden = !S.rol;
  $('#bSalir').hidden = !S.rol || false;
  if (!S.rol) $('#lClave').focus();
}

/* ---------- filtros ---------- */
const pasaDir = t => S.ui.dir === 'todas' || t.area === S.ui.dir || t.area === TODOS;
function pasaBusqueda(t) {
  const q = S.ui.q.trim().toLowerCase(); if (!q) return true;
  return [t.titulo, t.notas, t.origen, t.responsable].some(x => String(x || '').toLowerCase().includes(q));
}
function pasaEstado(t) {
  const e = S.ui.estado;
  if (e === 'cerradas') return t.estado === 'cerrada';
  if (e === 'todas') return true;
  if (t.estado !== 'pendiente') return false;
  if (e === 'vencidas') return t.vencida;
  if (e === 'semana') return t.dias !== null && t.dias <= 7;
  return true;
}
const visibles = tipo => S.tasks.filter(t => t.tipo === tipo && pasaDir(t) && pasaBusqueda(t) && pasaEstado(t));
const esEscritor = () => S.rol === 'owner' || S.rol === 'editor';

/* ---------- render ---------- */
function render() {
  if (!S.rol) return;
  const foco = document.activeElement?.dataset?.id && { id: document.activeElement.dataset.id, act: document.activeElement.dataset.act };
  $('#hoy').textContent = new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }).replace(/^./, c => c.toUpperCase());
  const owner = S.rol === 'owner';
  for (const id of ['pagos', 'confirmar', 'datos']) $('#tab-' + id).hidden = !owner;
  if (!owner && S.ui.tab !== 'actividades') S.ui.tab = 'actividades';
  document.querySelectorAll('.tab').forEach(t => { const sel = t.dataset.tab === S.ui.tab; t.setAttribute('aria-selected', String(sel)); t.tabIndex = sel ? 0 : -1; });
  for (const id of ['actividades', 'pagos', 'confirmar', 'datos']) $('#pan-' + id).hidden = S.ui.tab !== id;
  $('#nAct').textContent = S.tasks.filter(t => t.tipo === 'actividad' && t.estado === 'pendiente' && pasaDir(t)).length;
  $('#nPag').textContent = S.tasks.filter(t => t.tipo === 'pago' && t.estado === 'pendiente' && pasaDir(t)).length;
  const nc = S.props.filter(t => t.estado === 'propuesta').length;
  $('#nConf').textContent = nc; $('#nConf').classList.toggle('hay', nc > 0);
  document.querySelectorAll('[data-escribe]').forEach(b => { b.hidden = !esEscritor() || (b.dataset.tipo === 'pago' && !owner); });
  const av = $('#aviso'); av.hidden = !S.error; av.replaceChildren(h('span', { text: S.error }), h('button', { class: 'btn sm', type: 'button', text: 'Reintentar', onclick: cargar }));
  $('#bSalir').hidden = false;
  if (S.ui.tab === 'actividades') renderAct(); else if (S.ui.tab === 'pagos') renderPag(); else if (S.ui.tab === 'confirmar') renderConf(); else renderDatos();
  if (foco) document.querySelector(`[data-id="${CSS.escape(foco.id)}"][data-act="${CSS.escape(foco.act)}"]`)?.focus();
}

function renderAct() {
  const a = S.resumen?.actividades;
  $('#resAct').replaceChildren(...(!S.cargado || !a ? [h('li', { text: 'Cargando…' })] : [
    h('li', {}, h('strong', { text: a.abiertas }), 'abiertas'),
    h('li', { class: a.vencidas ? 'rojo' : '' }, h('strong', { text: a.vencidas }), 'vencidas'),
    h('li', {}, h('strong', { text: a.vencenHoy }), 'vencen hoy'),
    h('li', {}, h('strong', { text: a.pctDelegado + '%' }), 'en manos de un área'),
    h('li', {}, h('strong', { text: a.cerradas7d }), 'cerradas en 7 días')]));
  $('#board').replaceChildren(...tablero('actividad'));
}
function renderPag() {
  const p = S.resumen?.pagos;
  $('#resPag').replaceChildren(...(!S.cargado || !p ? [h('li', { text: 'Cargando…' })] : [
    h('li', { class: p.vencidos.n ? 'rojo' : '' }, h('strong', { text: pesos(p.vencidos.total) }), `vencido (${p.vencidos.n})`),
    h('li', {}, h('strong', { text: pesos(p.semana.total) }), `esta semana (${p.semana.n})`),
    h('li', {}, h('strong', { text: pesos(p.proximos30.total) }), 'por pagar en 30 días'),
    h('li', {}, h('strong', { text: pesos(p.pagadosMes) }), 'pagado este mes'),
    ...(p.sinFecha ? [h('li', { class: 'rojo' }, h('strong', { text: p.sinFecha }), 'sin fecha')] : [])]));
  $('#boardPag').replaceChildren(...tablero('pago'));
}

function tablero(tipo) {
  const pago = tipo === 'pago';
  const vis = visibles(pago ? 'pago' : 'actividad');
  return ORDEN.map(cat => {
    const c = CATS[cat];
    const items = vis.filter(t => t.categoria_efectiva === cat);
    const abiertas = items.filter(t => t.estado === 'pendiente');
    let cuerpo;
    if (!S.cargado) cuerpo = [h('div', { class: 'skeleton', 'aria-hidden': 'true' }), h('div', { class: 'skeleton', 'aria-hidden': 'true' })];
    else if (!items.length) cuerpo = [h('p', { class: 'empty', text: S.ui.q || S.ui.estado !== 'abiertas' ? 'Nada con estos filtros.' : pago ? 'Sin pagos en esta categoría.' : cat === 'urgente' ? 'Nada para hoy. Revisa lo que viene en Prioritario.' : cat === 'prioritario' ? 'Nada en gestión con el equipo.' : 'Nada delegado por ahora.' })];
    else if (S.ui.dir === 'todas') {
      const areas = [...new Set(items.map(t => t.area))].sort((a, b) => S.cfg.areas.indexOf(a) - S.cfg.areas.indexOf(b));
      cuerpo = areas.flatMap(a => { const g = items.filter(t => t.area === a); return [h('p', { class: 'sub', text: `${a} (${g.filter(t => t.estado === 'pendiente').length})` }), h('div', { class: 'list' }, g.map(tarjeta))]; });
    } else cuerpo = [h('div', { class: 'list' }, items.map(tarjeta))];
    return h('section', { class: 'col', 'data-cat': cat, 'aria-labelledby': `h-${tipo}-${cat}` },
      h('header', { class: 'col-h' },
        h('div', {}, h('h2', { class: 'cat', id: `h-${tipo}-${cat}` }, c.nombre, h('span', { class: 'n', text: abiertas.length })),
          h('p', { class: 'regla', text: c.regla }),
          pago ? h('p', { class: 'col-total', text: pesos(abiertas.reduce((s, t) => s + (t.monto || 0), 0)) }) : h('p', { class: 'help', text: c.ayuda })),
        esEscritor() && (!pago || S.rol === 'owner') ? h('button', { class: 'add', type: 'button', 'data-act': 'new', 'data-tipo': tipo, 'data-cat': cat, 'aria-label': `Añadir ${pago ? 'pago' : 'actividad'} a ${c.nombre}`, text: '+' }) : null),
      h('div', { class: 'col-b' }, cuerpo));
  });
}

function tarjeta(t) {
  const pago = t.tipo === 'pago', cerrada = t.estado === 'cerrada';
  const fCls = t.dias === null ? '' : t.dias < 0 ? 'tarde' : t.dias <= 2 ? 'pronto' : '';
  const accion = pago ? (cerrada ? 'Marcar como pendiente' : 'Marcar como pagado') : (cerrada ? 'Reabrir' : 'Marcar como hecha');
  return h('article', { class: `card ${cerrada ? 'hecha' : ''} ${t.escalada ? 'escalada' : ''}` },
    h('button', { class: 'check', type: 'button', 'data-act': 'toggle', 'data-id': t.id, disabled: !esEscritor(), 'aria-label': `${accion}: ${t.titulo}` },
      svgCheck()),
    h('div', {},
      h('h3', {}, h('button', { type: 'button', 'data-act': 'edit', 'data-id': t.id, text: t.titulo })),
      h('p', { class: 'meta' },
        pago ? h('span', { class: 'monto', text: t.monto ? pesos(t.monto) : 'Sin valor' }) : null,
        t.area === TODOS ? h('span', { class: 'tag todos', text: 'Todos' }) : S.ui.dir === 'todas' ? null : h('span', { text: t.area }),
        t.fecha_limite ? h('span', { class: `fecha ${fCls}`, text: cerrada ? 'Cerrada' : fechaTxt(t) }) : h('span', { text: 'Sin fecha' }),
        t.responsable ? h('span', { text: '👤 ' + t.responsable }) : null,
        t.recurrente === 'mensual' ? h('span', { class: 'tag', text: 'Cada mes' }) : null,
        t.n_links ? h('span', { class: 'tag', text: `GitHub ×${t.n_links}` }) : null),
      t.escalada ? h('p', { class: 'origen', text: t.escalada === 'vencida' ? `Escaló: vencida (era ${CATS[t.categoria].nombre})` : `Escaló: vence pronto (era ${CATS[t.categoria].nombre})` }) : null));
}
function svgCheck() {
  const ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('fill', 'none'); s.setAttribute('stroke-width', '2'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M2 6.5l2.5 2.5L10 3.5'); s.append(p); return s;
}

/* Por confirmar */
function renderConf() {
  const ps = S.props.filter(t => t.estado === 'propuesta');
  if (!ps.length) { $('#inbox').replaceChildren(h('div', { class: 'vacio' }, h('p', {}, h('strong', { text: 'No hay nada por confirmar.' })), h('p', { text: 'Las propuestas (reuniones procesadas, issues importados de GitHub) aparecen aquí, agrupadas por origen. Tu equipo no las ve hasta que las confirmes.' }))); return; }
  const grupos = new Map();
  ps.forEach(t => { const k = t.origen || 'Sin origen'; (grupos.get(k) || grupos.set(k, []).get(k)).push(t); });
  $('#inbox').replaceChildren(h('section', { class: 'inbox', 'aria-label': 'Por confirmar' },
    h('div', { class: 'inbox-h' }, h('h2', { text: `Por confirmar (${ps.length})` }), h('p', { text: 'Revisa y confirma. Lo descartado se puede restaurar desde la pestaña Datos.' })),
    [...grupos].map(([org, lista], i) => {
      lista.sort((a, b) => ORDEN.indexOf(a.categoria) - ORDEN.indexOf(b.categoria));
      const d = h('details', { class: 'reu', 'data-origen': org, open: S.abiertas.has(org) || (i === 0 && !S.abiertas.size) },
        h('summary', {}, h('span', { class: 'reu-t', text: org }), h('span', { class: 'reu-n', text: plural(lista.length, 'elemento', 'elementos') })),
        h('div', { class: 'reu-list' }, lista.map(t => h('div', { class: 'pr' },
          h('div', {}, h('h3', { text: t.titulo }), h('p', { class: 'meta' },
            h('span', { class: `chip ${t.categoria}`, text: CATS[t.categoria].nombre }), h('span', { class: 'tag', text: t.tipo === 'pago' ? 'Pago' : 'Actividad' }),
            t.tipo === 'pago' && t.monto ? h('span', { class: 'monto', text: pesos(t.monto) }) : null, h('span', { text: t.area }), h('span', { text: t.fecha_limite ? fechaTxt(t) : 'Sin fecha' }))),
          h('div', { class: 'pr-acts' },
            h('button', { class: 'btn sm primary', type: 'button', 'data-act': 'confirmar', 'data-id': t.id, text: 'Confirmar' }),
            h('button', { class: 'btn sm', type: 'button', 'data-act': 'edit', 'data-id': t.id, text: 'Revisar' }),
            h('button', { class: 'btn sm quiet', type: 'button', 'data-act': 'descartar', 'data-id': t.id, text: 'Descartar' }))))),
        lista.length > 1 ? h('div', { class: 'reu-f' }, h('button', { class: 'btn sm', type: 'button', 'data-act': 'confirmarTodas', 'data-origen': org, text: 'Confirmar todas las de este origen' })) : null);
      d.addEventListener('toggle', () => d.open ? S.abiertas.add(org) : S.abiertas.delete(org));
      return d;
    })));
}

/* Datos y GitHub */
function renderDatos() {
  const descartadas = S.props.filter(t => t.estado === 'descartada');
  const gh = S.cfg.github;
  const sel = h('select', { id: 'ghRepo', 'aria-label': 'Repositorio' }, gh.repos.map(r => h('option', { text: r })));
  $('#datos').replaceChildren(
    h('div', { class: 'panel' }, h('h2', { text: 'Respaldo y migración' }),
      h('p', { text: 'Exporta todo en JSON o importa los datos del tablero anterior (formato {"tareas":[],"pagos":[]}) o un export de esta app. Importar es seguro de repetir: no duplica.' }),
      h('div', { class: 'row-btns' },
        h('a', { class: 'btn', href: '/api/export', download: '', text: 'Exportar JSON' }),
        h('a', { class: 'btn', href: '/api/export.csv?tipo=actividad', download: '', text: 'Actividades CSV' }),
        h('a', { class: 'btn', href: '/api/export.csv?tipo=pago', download: '', text: 'Pagos CSV' }),
        h('label', { class: 'btn', for: 'fileImp', text: 'Importar JSON…' }),
        h('input', { id: 'fileImp', type: 'file', accept: 'application/json,.json', hidden: true, onchange: importar }))),
    h('div', { class: 'panel' }, h('h2', { text: 'GitHub' }),
      !gh.configurado || !gh.repos.length
        ? h('p', { text: 'GitHub no está configurado. Define GITHUB_TOKEN y GITHUB_REPOS (dueño/repo, separados por coma) en el servidor.' })
        : [h('p', { text: 'Trae issues abiertos como propuestas (Por confirmar). Desde cada actividad puedes crear o vincular un issue.' }),
           h('div', { class: 'row-btns' }, sel, h('button', { class: 'btn', type: 'button', text: 'Ver issues abiertos', onclick: () => verIssues(sel.value) })),
           h('div', { id: 'issues' })]),
    h('div', { class: 'panel' }, h('h2', { text: `Descartadas (${descartadas.length})` }),
      descartadas.length ? descartadas.map(t => h('div', { class: 'issue' }, h('span', { text: t.titulo }),
        h('button', { class: 'btn sm', type: 'button', 'data-act': 'restaurar', 'data-id': t.id, text: 'Restaurar' }))) : h('p', { text: 'Nada descartado.' })));
}
async function verIssues(repo) {
  const cont = $('#issues'); cont.replaceChildren(h('p', { text: 'Consultando GitHub…' }));
  try {
    const { issues } = await api.get('/github/issues?repo=' + encodeURIComponent(repo));
    const nuevos = issues.filter(i => i.tipo === 'issue' && !i.importado);
    cont.replaceChildren(...(issues.length ? issues.map(i => h('div', { class: 'issue' },
      h('span', {}, h('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer', text: `#${i.numero}` }), ' ', i.titulo, i.importado ? ' (ya importado)' : '')))
      : [h('p', { text: 'No hay issues abiertos.' })]),
      nuevos.length ? h('button', { class: 'btn primary', type: 'button', text: `Importar ${plural(nuevos.length, 'issue', 'issues')} como propuestas`, onclick: async () => {
        try { const r = await api.post('/github/import', { repo, numeros: nuevos.map(i => i.numero) }); toast(`Se crearon ${r.creadas} propuestas.`); await cargar(); } catch (e) { fallo(e); } } }) : null);
  } catch (e) { cont.replaceChildren(h('p', { class: 'err', text: e.message })); }
}
async function importar(ev) {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try {
    const datos = JSON.parse(await f.text());
    const seco = await api.post('/import?dry=1', datos);
    const rech = seco.rechazos.length ? `\n\nSe omitirán ${seco.rechazos.length}:\n` + seco.rechazos.slice(0, 8).map(r => `• ${r.titulo}: ${r.motivo}`).join('\n') : '';
    if (!confirm(`Se importarán ${seco.validas} elementos.${rech}\n\n¿Continuar?`)) return;
    const r = await api.post('/import', datos);
    toast(`Importadas ${r.nuevas}. Ya existían ${r.existentes}.`); await cargar();
  } catch (e) { fallo(e instanceof SyntaxError ? new Error('El archivo no es un JSON válido.') : e); }
}

/* ---------- acciones ---------- */
async function transicion(id, accion, msg, deshacer) {
  const r = await api.post(`/tasks/${id}/transition`, { accion });
  await cargar();
  toast(r.siguiente ? `${msg} Quedó programado el del próximo mes.` : msg, deshacer && (() => transicion(id, deshacer, 'Revertido.')));
}
document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const { act, id, tipo } = b.dataset;
  if (act === 'new') return abrir(tipo, null, b.dataset.cat);
  if (act === 'edit') return abrir(null, id);
  b.disabled = true;
  try {
    const t = id && (S.tasks.find(x => x.id === id) || S.props.find(x => x.id === id));
    if (act === 'toggle') {
      const cerrada = t.estado === 'cerrada';
      await transicion(id, cerrada ? 'reabrir' : 'cerrar', cerrada ? 'Reabierta.' : (t.tipo === 'pago' ? 'Marcado como pagado.' : 'Marcada como hecha.'), cerrada ? 'cerrar' : 'reabrir');
    } else if (act === 'confirmar') await transicion(id, 'confirmar', 'Confirmado.');
    else if (act === 'descartar') await transicion(id, 'descartar', 'Descartado.', 'restaurar');
    else if (act === 'restaurar') await transicion(id, 'restaurar', 'Restaurado.');
    else if (act === 'confirmarTodas') {
      const r = await api.post('/meetings/confirm', { origen: b.dataset.origen === 'Sin origen' ? '' : b.dataset.origen });
      await cargar(); toast(r.requierenRevision.length ? `Confirmé ${r.confirmadas}. ${r.requierenRevision.length} necesitan revisión antes de entrar.` : `Confirmé ${r.confirmadas}.`);
    }
  } catch (e) { fallo(e); if (e.status === 409) cargar(); } finally { b.disabled = false; }
});

/* ---------- diálogo ---------- */
const dlg = $('#dlg');
const D = { tipo: 'actividad', id: null, cat: 'urgente', version: undefined, disparador: null, armado: false };
function pintarSeg() {
  document.querySelectorAll('#iCat button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === D.cat)));
  $('#catHint').textContent = `${CATS[D.cat].regla}. ${CATS[D.cat].ayuda}`;
}
function desarmar() { D.armado = false; const b = $('#bEliminar'); b.textContent = 'Eliminar'; b.classList.remove('confirmando'); }
function abrir(tipo, id, cat) {
  const t = id ? (S.tasks.find(x => x.id === id) || S.props.find(x => x.id === id)) : null;
  D.tipo = t ? t.tipo : tipo; D.id = t?.id || null; D.cat = t?.categoria || cat || 'urgente'; D.version = t?.version; D.disparador = document.activeElement;
  const pago = D.tipo === 'pago', editable = esEscritor() && !(t?.estado === 'propuesta' && S.rol !== 'owner');
  $('#dlgTitle').textContent = !t ? (pago ? 'Nuevo pago' : 'Nueva actividad') : t.estado === 'propuesta' ? 'Revisar antes de confirmar' : editable ? (pago ? 'Editar pago' : 'Editar actividad') : 'Detalle';
  $('#lTitulo').textContent = pago ? 'Concepto del pago' : 'Qué hay que hacer'; $('#lFecha').textContent = pago ? 'Fecha de pago' : 'Fecha límite';
  $('#wPago').hidden = !pago;
  $('#iTitulo').value = t?.titulo || ''; $('#iDir').value = t?.area || GENERAL; $('#iFecha').value = t?.fecha_limite || '';
  $('#iMonto').value = t?.monto ? new Intl.NumberFormat('es-CO').format(t.monto) : ''; $('#iRec').value = t?.recurrente || 'no'; $('#iRec').disabled = Boolean(t);
  $('#iResp').value = t?.responsable || ''; $('#iOrigen').value = t?.origen || ''; $('#iNotas').value = t?.notas || '';
  $('#dlgErr').textContent = ''; dlg.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid'));
  desarmar();
  dlg.querySelectorAll('#dlgForm input,#dlgForm select,#dlgForm textarea,#iCat button').forEach(el => { el.disabled = !editable; });
  if (t) $('#iRec').disabled = true;
  $('#bGuardar').hidden = !editable; $('#bGuardar').textContent = t?.estado === 'propuesta' ? 'Confirmar' : 'Guardar';
  $('#bEliminar').hidden = !t || S.rol !== 'owner'; $('#bDescartar').hidden = !t || S.rol !== 'owner' || t.estado === 'descartada';
  pintarSeg(); pintarGit(t); pintarHist(t);
  dlg.showModal(); if (editable) $('#iTitulo').focus();
}
async function pintarHist(t) {
  const w = $('#wHist'); w.hidden = !t; w.open = false; $('#hist').replaceChildren(); if (!t) return;
  try { const { events } = await api.get(`/tasks/${t.id}/events`);
    $('#hist').replaceChildren(...events.map(e => h('li', { text: `${new Date(e.at).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' })} · ${e.accion}${e.detalle ? ': ' + e.detalle : ''}` }))); } catch {}
}
async function pintarGit(t) {
  const w = $('#wGit'); const gh = S.cfg.github;
  w.hidden = !t || t.tipo === 'pago' || t.estado === 'propuesta'; w.replaceChildren(); if (w.hidden) return;
  let links = []; try { links = (await api.get(`/tasks/${t.id}/links`)).links; } catch {}
  const repoSel = h('select', { 'aria-label': 'Repositorio' }, gh.repos.map(r => h('option', { text: r })));
  const num = h('input', { type: 'number', min: '1', 'aria-label': 'Número de issue o PR', placeholder: '#' });
  w.append(h('h3', { text: 'GitHub' }),
    ...links.map(l => h('div', { class: 'issue' }, h('span', {}, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', text: `${l.repo}#${l.numero}` }), ` ${l.tipo === 'pr' ? 'PR' : 'issue'} · ${l.estado}`),
      esEscritor() ? h('button', { class: 'btn sm quiet', type: 'button', text: 'Quitar', onclick: async () => { try { await api.del(`/links/${l.id}`); pintarGit(t); cargar(); } catch (e) { fallo(e); } } }) : null)),
    links.length ? h('button', { class: 'btn sm', type: 'button', text: 'Actualizar estado', onclick: async () => { try { await api.post(`/tasks/${t.id}/links/refresh`); pintarGit(t); } catch (e) { fallo(e); } } }) : null,
    esEscritor() && gh.configurado && gh.repos.length ? h('div', { class: 'row-btns' }, repoSel,
      h('button', { class: 'btn sm', type: 'button', text: 'Crear issue', onclick: async () => { try { await api.post(`/tasks/${t.id}/issue`, { repo: repoSel.value }); toast('Issue creado.'); pintarGit(t); cargar(); } catch (e) { fallo(e); } } }),
      num, h('button', { class: 'btn sm', type: 'button', text: 'Vincular', onclick: async () => { try { await api.post(`/tasks/${t.id}/links`, { repo: repoSel.value, numero: Number(num.value) }); pintarGit(t); cargar(); } catch (e) { fallo(e); } } }))
      : h('p', { class: 'hint', text: gh.configurado ? '' : 'GitHub no está configurado en el servidor.' }));
}
function marcarInvalido(el, msg) { $('#dlgErr').textContent = msg; if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } }
$('#dlgForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#bGuardar'); if (btn.disabled) return;
  dlg.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid')); $('#dlgErr').textContent = '';
  const pago = D.tipo === 'pago';
  const body = { tipo: D.tipo, titulo: $('#iTitulo').value.trim(), categoria: D.cat, area: $('#iDir').value, fecha_limite: $('#iFecha').value || null,
    responsable: $('#iResp').value.trim(), origen: $('#iOrigen').value.trim(), notas: $('#iNotas').value.trim() };
  if (!body.titulo) return marcarInvalido($('#iTitulo'), 'Escribe qué hay que hacer.');
  if (pago) {
    const m = soloDigitos($('#iMonto').value);
    if (Number.isNaN(m)) return marcarInvalido($('#iMonto'), 'El valor debe ser un número entero de pesos, sin decimales.');
    body.monto = m; body.recurrente = $('#iRec').value;
    if (!body.fecha_limite) return marcarInvalido($('#iFecha'), 'Asigna la fecha de pago para que el tablero te avise.');
  }
  if (D.cat === 'prioritario' && body.area === GENERAL) return marcarInvalido($('#iDir'), 'Lo Prioritario se gestiona con el equipo: elige una dirección o Todos.');
  if (D.cat === 'importante' && body.area === GENERAL) return marcarInvalido($('#iDir'), 'Lo Importante se delega: elige otra dirección o Todos.');
  btn.disabled = true;
  try {
    const t = D.id && (S.tasks.find(x => x.id === D.id) || S.props.find(x => x.id === D.id));
    if (D.id) {
      const { tipo, recurrente, ...cambios } = body;
      await api.patch(`/tasks/${D.id}`, { ...cambios, ...(pago ? { monto: body.monto } : {}), version: D.version });
      if (t.estado === 'propuesta') await api.post(`/tasks/${D.id}/transition`, { accion: 'confirmar' });
      toast(t.estado === 'propuesta' ? 'Confirmado.' : 'Cambios guardados.');
    } else { await api.post('/tasks', body); toast(pago ? 'Pago registrado.' : 'Actividad guardada.'); }
    dlg.close(); await cargar();
  } catch (e) {
    if (e.status === 409) { $('#dlgErr').textContent = e.message; cargar(); } else if (e.status === 401) fallo(e); else $('#dlgErr').textContent = e.message;
  } finally { btn.disabled = false; }
});
document.querySelectorAll('#iCat button').forEach(b => b.addEventListener('click', () => { D.cat = b.dataset.v; pintarSeg(); }));
$('#bCancelar').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => { desarmar(); D.disparador?.isConnected && D.disparador.focus(); });
$('#bDescartar').addEventListener('click', async () => { try { await transicion(D.id, 'descartar', 'Descartado.', 'restaurar'); dlg.close(); } catch (e) { $('#dlgErr').textContent = e.message; } });
$('#bEliminar').addEventListener('click', async () => {
  const b = $('#bEliminar');
  if (!D.armado) { D.armado = true; b.textContent = 'Confirmar eliminación'; b.classList.add('confirmando'); $('#dlgErr').textContent = 'Esta acción no se puede deshacer (queda registrada en la auditoría). Pulsa de nuevo para eliminar.'; setTimeout(desarmar, 6000); return; }
  b.disabled = true;
  try { await api.del(`/tasks/${D.id}`); dlg.close(); toast('Eliminado.'); await cargar(); } catch (e) { $('#dlgErr').textContent = e.message; } finally { b.disabled = false; desarmar(); }
});
$('#iMonto').addEventListener('input', e => { const n = soloDigitos(e.target.value); e.target.value = n && !Number.isNaN(n) ? new Intl.NumberFormat('es-CO').format(n) : e.target.value.replace(/[^\d.]/g, ''); });

/* ---------- pestañas, filtros, sesión ---------- */
function poblarSelects() {
  const areas = S.cfg.areas, opt = a => h('option', { value: a, text: a === TODOS ? 'Todos (equipo completo)' : a });
  $('#fDir').replaceChildren(h('option', { value: 'todas', text: 'Ver todo el tablero' }), ...areas.map(opt));
  $('#iDir').replaceChildren(...areas.map(opt));
  if (S.ui.dir !== 'todas' && !areas.includes(S.ui.dir)) S.ui.dir = 'todas';
  $('#fDir').value = S.ui.dir;
}
function irPestana(id) { S.ui.tab = id; render(); }
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => irPestana(t.dataset.tab)));
$('.tabs').addEventListener('keydown', e => {
  const vis = [...document.querySelectorAll('.tab')].filter(t => !t.hidden); let i = vis.findIndex(t => t.dataset.tab === S.ui.tab);
  if (e.key === 'ArrowRight') i = (i + 1) % vis.length; else if (e.key === 'ArrowLeft') i = (i - 1 + vis.length) % vis.length;
  else if (e.key === 'Home') i = 0; else if (e.key === 'End') i = vis.length - 1; else return;
  e.preventDefault(); irPestana(vis[i].dataset.tab); vis[i].focus();
});
$('#fDir').addEventListener('change', e => { S.ui.dir = e.target.value; try { localStorage.setItem('liva-dir', S.ui.dir); } catch {} render(); });
$('#fEstado').addEventListener('change', e => { S.ui.estado = e.target.value; render(); });
let debounce; $('#fBuscar').addEventListener('input', e => { clearTimeout(debounce); debounce = setTimeout(() => { S.ui.q = e.target.value; render(); }, 150); });
$('#bTema').addEventListener('click', () => {
  const r = document.documentElement, oscuro = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = oscuro ? 'light' : 'dark'; try { localStorage.setItem('liva-tema', r.dataset.theme); } catch {}
});
$('#bSalir').addEventListener('click', async () => { try { await api.post('/logout'); } catch {} S.rol = null; S.tasks = []; S.props = []; mostrar(); });
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#lErr').textContent = '';
  try { await api.post('/login', { token: $('#lClave').value }); $('#lClave').value = ''; await arrancar(); } catch (err) { $('#lErr').textContent = err.message; }
});
$('#bResumen').addEventListener('click', async () => {
  const a = S.tasks.filter(t => t.tipo === 'actividad' && t.estado === 'pendiente' && pasaDir(t));
  const linea = t => `• ${t.titulo} — ${t.area}${t.responsable ? ' (' + t.responsable + ')' : ''}${t.fecha_limite ? ' · ' + fechaTxt(t).toLowerCase() : ''}`;
  const grupo = (tit, l) => l.length ? `${tit} (${l.length})\n${l.map(linea).join('\n')}\n` : '';
  const texto = `Resumen LIVA – ${$('#hoy').textContent}\n\n` + grupo('VENCIDAS', a.filter(t => t.vencida)) + grupo('VENCEN HOY', a.filter(t => t.dias === 0)) + grupo('PRÓXIMOS 7 DÍAS', a.filter(t => t.dias > 0 && t.dias <= 7));
  try { await navigator.clipboard.writeText(texto); toast('Resumen copiado.'); } catch { toast('No se pudo copiar automáticamente.'); }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'n' || dlg.open || e.metaKey || e.ctrlKey || e.altKey || !esEscritor()) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
  e.preventDefault(); abrir(S.ui.tab === 'pagos' && S.rol === 'owner' ? 'pago' : 'actividad', null, 'urgente');
});
document.body.append(h('button', { class: 'fab', type: 'button', 'aria-label': 'Nueva actividad', text: '+', onclick: () => esEscritor() && !dlg.open && abrir(S.ui.tab === 'pagos' && S.rol === 'owner' ? 'pago' : 'actividad', null, 'urgente') }));

// Sincronización: al volver a la pestaña y cada 30 s; también refresca el "hoy" tras medianoche.
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.rol && !dlg.open) cargar(); });
setInterval(() => { if (S.rol && !document.hidden && !dlg.open) cargar(); }, 30000);
arrancar();
