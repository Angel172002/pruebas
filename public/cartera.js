import { api, ApiError } from './api.js';

/* Cartera · interfaz. Todo se construye con nodos DOM y textContent (nada de innerHTML con datos). */
const NF = new Intl.NumberFormat('es-CO');
const pesos = n => (n < 0 ? '-' : '') + '$ ' + NF.format(Math.abs(Math.round(n || 0)));
const mill = n => !n ? '$ 0' : (n < 0 ? '-' : '') + '$ ' + (Math.abs(n || 0) / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M';
const pct = n => Math.round((n || 0) * 100) + ' %';
const fdate = s => (s ? s.split('-').reverse().join('/') : '—');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const SVGNS = 'http://www.w3.org/2000/svg';
const ALERTA = { al_dia: ['ok', 'Al día'], mora: ['mora', 'En mora'], mora_grave: ['grave', 'Mora grave'], sin_pago: ['grave', 'Sin pago'], finalizado: ['fin', 'Finalizado'] };

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
function sv(tag, attrs = {}, ...hijos) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of hijos.flat()) if (c) el.append(c);
  return el;
}
const ICONOS = {
  inicio: [['path', { d: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' }]],
  clientes: [['circle', { cx: 9, cy: 8, r: 3.5 }], ['path', { d: 'M2.5 20c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6M16 4.6a3.5 3.5 0 0 1 0 6.8M18.2 14.4c2 .7 3.3 2.6 3.3 5.6' }]],
  cobranza: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5.5l3 2' }]],
  flujo: [['path', { d: 'M4 20V11M10 20V4M16 20v-7M22 20H2' }]],
  asesores: [['rect', { x: 3, y: 7, width: 18, height: 13, rx: 2 }], ['path', { d: 'M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2' }]],
  importar: [['path', { d: 'M12 16V4M7 9l5-5 5 5M4 20h16' }]],
  auditoria: [['path', { d: 'M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z' }]],
  mas: [['path', { d: 'M12 5v14M5 12h14' }]],
  buscar: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-3.5-3.5' }]],
  chev: [['path', { d: 'M9 6l6 6-6 6' }]]
};
const ico = (n, cls) => sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', class: cls }, ICONOS[n].map(([t, a]) => sv(t, a)));
const iniciales = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
const tono = n => 'h' + (1 + ([...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 5));
const avatar = (n, big) => h('span', { class: `ct-av ${tono(n)} ${big ? 'big' : ''}`, 'aria-hidden': 'true', text: iniciales(n) });
const pill = a => { const [k, t] = ALERTA[a] || ['fin', a]; return h('span', { class: `ct-pill ${k}`, text: t }); };

const AYUDA = {
  recibido: 'Suma de todos los pagos registrados. Los pagos anulados no cuentan.',
  saldo: 'Lo que falta para completar el total de los contratos. Incluye lo vencido y lo que aún no vence.',
  mora: 'Dinero de cuotas que ya venció y todavía no se ha pagado.',
  utilidad: 'Lo que le quedaría a la firma si se cobra todo: total del contrato menos honorarios, bonificación, gastos y pago al centro de conciliación.',
  egresos: 'Costos que traen los contratos: honorarios del abogado, bonificación del asesor, gastos, adquisición del cliente y pago al centro de conciliación.',
  antiguedad: 'Cuánto lleva atrasado cada cliente. Se calcula como 30 días por cada cuota vencida sin pagar.',
  proyeccion: 'Cuotas que vencen en los próximos meses y que todavía no están cubiertas por pagos adelantados. Es lo que debería entrar si todos pagan a tiempo.',
  avance: 'Qué parte del total del contrato ya se pagó.'
};

export function montarCartera(raiz, { user, cfg, toast, fallo }) {
  const nivel = user.rol === 'admin' ? 'total' : user.acceso_cartera;
  const admin = user.rol === 'admin', escribe = user.rol !== 'lector' && nivel !== 'ninguno', total = nivel === 'total';
  const S = { vista: 'inicio', id: null, lista: [], resumen: null, fAl: 'todos', fAs: '', orden: 'urgentes', q: '', revelar: false, tab: 'moras' };
  raiz.classList.add('ct');

  const side = h('aside', { class: 'ct-side', 'aria-label': 'Secciones de cartera' });
  const barra = h('div', { class: 'ct-bar' });
  const vista = h('div', { class: 'ct-view', 'aria-live': 'polite' });
  raiz.replaceChildren(side, h('div', { class: 'ct-main' }, barra, vista));

  const poner = (el, ...n) => el.replaceChildren(...n.flat().filter(x => x != null && x !== false));
  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { fallo(e); } };
  const cerrarPops = () => raiz.querySelectorAll('.ct-pop').forEach(p => { p.previousSibling?.setAttribute?.('aria-expanded', 'false'); p.remove(); });
  document.addEventListener('click', e => { if (!e.target.closest('.ct-hw')) cerrarPops(); if (!e.target.closest('.ct-more')) raiz.querySelectorAll('.ct-more .menu').forEach(m => m.remove()); if (!e.target.closest('.ct-search')) hideDrop(); });

  function ayuda(clave) {
    const b = h('button', { type: 'button', class: 'ct-help', 'aria-label': 'Qué significa esto', 'aria-expanded': 'false', text: '?' });
    const w = h('span', { class: 'ct-hw' }, b);
    b.addEventListener('click', e => { e.stopPropagation(); const abierto = b.getAttribute('aria-expanded') === 'true'; cerrarPops(); if (!abierto) { b.setAttribute('aria-expanded', 'true'); w.append(h('div', { class: 'ct-pop', role: 'note', text: AYUDA[clave] })); } });
    return w;
  }
  const skeleton = () => poner(vista, h('div', { class: 'ct-skel ct-skel-h', 'aria-busy': 'true' }), h('div', { class: 'ct-kpis' }, [0, 1, 2, 3].map(() => h('div', { class: 'ct-skel' }))));

  /* ---------- navegación ---------- */
  const NAV = [['inicio', 'Inicio'], ['clientes', 'Clientes'], ['cobranza', 'Cobranza'], ['flujo', 'Flujo de caja'], ...(total ? [['asesores', 'Asesores']] : [])];
  const NAVADM = [['importar', 'Importar'], ['auditoria', 'Auditoría']];
  function pintarNav() {
    const btn = ([k, t]) => h('button', { type: 'button', class: 'ct-nav', 'aria-current': String(S.vista === k || (k === 'clientes' && S.vista === 'ficha')) === 'true' ? 'page' : null, onclick: () => { if (k === 'clientes') S.q = ''; ir(k); } },
      ico(k, ''), h('span', { text: t }), k === 'cobranza' && S.resumen ? insignia() : null);
    poner(side, h('span', { class: 'lbl', text: 'Cartera' }), ...NAV.map(btn), ...(admin ? [h('span', { class: 'lbl', text: 'Administración' }), ...NAVADM.map(btn)] : []),
      S.resumen ? h('span', { class: 'fecha', text: 'Datos al ' + fdate(S.resumen.hoy) }) : null);
  }
  const insignia = () => { const n = S.resumen.alertas.mora + S.resumen.alertas.mora_grave + S.resumen.alertas.sin_pago; return n ? h('span', { class: 'n', text: String(n), title: `${plural(n, 'cliente', 'clientes')} con cuotas vencidas` }) : null; };
  async function ir(v, id = null) {
    S.vista = v; S.id = id; cerrarPops(); pintarNav(); skeleton();
    await guard(VISTAS[v])(); pintarNav();
    window.scrollTo({ top: 0 });
  }
  const resumen = async (fresco = true) => { if (fresco || !S.resumen) S.resumen = await api.get('/cartera/resumen'); return S.resumen; };

  /* ---------- barra superior: búsqueda por cédula + registrar pago ---------- */
  const inBuscar = h('input', { type: 'search', placeholder: 'Buscar por cédula o nombre…', 'aria-label': 'Buscar cliente por cédula o nombre', autocomplete: 'off', inputmode: 'search', 'aria-controls': 'ct-drop' });
  const drop = h('div', { class: 'ct-drop', id: 'ct-drop', role: 'listbox', hidden: true });
  const hideDrop = () => { drop.hidden = true; };
  let deb;
  inBuscar.addEventListener('input', () => {
    clearTimeout(deb); const q = inBuscar.value.trim();
    if (q.length < 3) return hideDrop();
    deb = setTimeout(guard(async () => {
      const r = (await api.get('/cartera/clientes?q=' + encodeURIComponent(q))).clientes.slice(0, 6);
      poner(drop, ...(r.length ? r.map(c => h('button', { type: 'button', role: 'option', onclick: () => { hideDrop(); inBuscar.value = ''; ir('ficha', c.id); } }, avatar(c.nombre),
        h('span', {}, h('span', { class: 't', text: c.nombre }), h('span', { class: 's', text: `CC ${c.cedula} · ${c.asesor}` })), pill(c.alerta))) : [h('p', { text: 'No encontramos a nadie con eso. Pruebe con la cédula completa o parte del nombre.' })]));
      drop.hidden = false;
    }), 250);
  });
  inBuscar.addEventListener('keydown', e => { if (e.key === 'Escape') { hideDrop(); inBuscar.blur(); } if (e.key === 'Enter') { S.q = inBuscar.value.trim(); hideDrop(); ir('clientes'); } });
  document.addEventListener('keydown', e => { if (e.key === '/' && raiz.isConnected && !raiz.closest('[hidden]') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) { e.preventDefault(); inBuscar.focus(); } });
  poner(barra, h('div', { class: 'ct-search' }, ico('buscar'), inBuscar, drop), escribe ? h('button', { type: 'button', class: 'ct-btn pri', onclick: () => modalPago(null) }, ico('mas'), 'Registrar pago') : null);

  /* ---------- componentes ---------- */
  const encabezado = (titulo, sub, ...acciones) => h('div', { class: 'ct-head' }, h('div', {}, h('h1', { text: titulo }), sub ? h('p', { text: sub }) : null), h('div', { class: 'ct-acts' }, acciones));
  const kpi = (l, v, c, cls = '', clave) => h('div', { class: `ct-card ct-kpi ${cls}` }, h('span', { class: 'l' }, l, clave ? ayuda(clave) : null), h('span', { class: 'v', text: v }), h('span', { class: 'c', text: c }));
  const vacio = (t, s) => h('div', { class: 'ct-empty' }, h('b', { text: t }), s ? h('span', { text: s }) : null);
  const itemCliente = (c, meta, monto, pie) => h('button', { type: 'button', class: 'ct-item', onclick: () => ir('ficha', c.id) }, avatar(c.nombre),
    h('span', { class: 'tx' }, h('span', { class: 'nm', text: c.nombre }), h('span', { class: 'mt', text: meta })), monto ? h('span', { class: 'am', text: monto }) : null, pie || null, ico('chev', 'chev'));

  function nice(m) { if (m <= 0) return 1e6; const p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  /** Barras: v = valor, e = esperado (marca), cls = estilo, etq = valor visible sobre la barra. */
  function grafico(datos, { alto = 240, descripcion }) {
    const W = 480, L = 44, B = 28, T = 24, iw = W - L - 6, ih = alto - B - T;
    const top = nice(Math.max(...datos.flatMap(d => [d.v, d.e || 0]), 1));
    const g = sv('svg', { viewBox: `0 0 ${W} ${alto}`, class: 'ct-chart', role: 'img', 'aria-label': descripcion });
    for (let i = 0; i <= 4; i++) { const y = T + ih - (ih * i) / 4; g.append(sv('line', { class: 'gl', x1: L, x2: W - 6, y1: y, y2: y }), Object.assign(sv('text', { x: L - 8, y: y + 4, 'text-anchor': 'end' }), { textContent: i ? ((top * i) / 4 / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M' : '0' })); }
    const bw = iw / datos.length;
    datos.forEach((d, i) => {
      const x = L + i * bw, bh = (ih * d.v) / top, y = T + ih - bh;
      g.append(sv('rect', { class: `bar ${d.cls || ''}`, x: x + bw * 0.2, y, width: bw * 0.6, height: Math.max(0, bh), rx: 6 }, Object.assign(sv('title'), { textContent: `${d.l}: ${pesos(d.v)}${d.e !== undefined ? ` · esperado ${pesos(d.e)}` : ''}` })));
      if (d.e) { const ye = T + ih - (ih * d.e) / top; g.append(sv('line', { class: 'mk', x1: x + bw * 0.1, x2: x + bw * 0.9, y1: ye, y2: ye })); }
      if (d.etq && d.v) g.append(Object.assign(sv('text', { class: 'val', x: x + bw / 2, y: y - 7, 'text-anchor': 'middle' }), { textContent: (d.v / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) }));
      g.append(Object.assign(sv('text', { x: x + bw / 2, y: alto - 8, 'text-anchor': 'middle' }), { textContent: d.l }));
    });
    return g;
  }
  const filaBarra = (t, valor, ancho, cls, sub) => { const i = h('i', { class: cls || '' }); i.style.width = Math.max(ancho > 0 ? 3 : 0, Math.round(ancho * 100)) + '%'; return h('div', { class: 'ct-brow' }, h('div', { class: 't' }, h('span', { text: t }), h('b', { text: valor })), h('div', { class: 'ct-track' }, i), sub ? h('small', { text: sub }) : null); };
  const anillo = p => { const R = 60, C = 2 * Math.PI * R; return h('div', { class: 'ct-ring', role: 'img', 'aria-label': `${pct(p)} recuperado` }, sv('svg', { viewBox: '0 0 148 148' }, sv('circle', { class: 'tr', cx: 74, cy: 74, r: R, 'stroke-width': 14 }), sv('circle', { class: 'fg', cx: 74, cy: 74, r: R, 'stroke-width': 14, 'stroke-dasharray': `${Math.max(0.01, p) * C} ${C}` })), h('div', { class: 'tx' }, h('b', { text: pct(p) }), h('span', { text: 'recuperado' }))); };

  /* ---------- INICIO ---------- */
  async function vInicio(cache = false) {
    const r = await resumen(!cache), t = r.totales, al = r.alertas;
    const graves = al.mora_grave + al.sin_pago, moraPct = t.total_contrato ? t.valor_en_mora / t.total_contrato : 0;
    const nivelE = !t.valor_en_mora ? 'ok' : (graves === 0 && moraPct < 0.05) ? 'ok' : (graves / Math.max(1, t.activos) < 0.25 && moraPct < 0.15) ? 'mora' : 'grave';
    const titulo = { ok: !t.valor_en_mora ? 'La cartera está al día' : 'La cartera está sana', mora: 'La cartera necesita atención', grave: 'La cartera está en riesgo' }[nivelE];
    const estado = { ok: 'Todo en orden', mora: 'Atención', grave: 'En riesgo' }[nivelE];
    const frase = t.clientes === 0 ? 'Todavía no hay clientes. Cree el primero o importe su matriz desde Administración.'
      : `Se ha recuperado el ${pct(t.recuperacion)} de lo contratado (${mill(t.recibido)} de ${mill(t.total_contrato)}). ` +
        (t.con_mora ? `Hay ${plural(t.con_mora, 'cliente', 'clientes')} con cuotas vencidas por ${mill(t.valor_en_mora)}${graves ? `, y ${graves} de ellos en situación grave` : ''}.` : 'Nadie tiene cuotas vencidas.');
    const seg = [['ok', 'Al día', al.al_dia], ['mora', 'En mora', al.mora], ['grave', 'Mora grave o sin pago', graves], ['fin', 'Finalizados', al.finalizado]];
    const apilada = h('div', { class: 'ct-stack', role: 'img', 'aria-label': 'Clientes por estado' }, seg.filter(s => s[2]).map(([k, n, c]) => { const i = h('i', { class: k, title: `${n}: ${c}` }); i.style.flexGrow = String(c); return i; }));
    const ahoraMes = Number(r.hoy.slice(5, 7)) - 1;
    const graf1 = grafico(r.mensual.map((m, i) => ({ l: MESES[i], v: m.recibido, e: m.esperado, cls: i === ahoraMes ? 'now' : '', etq: i === ahoraMes })), { descripcion: `Recaudo mensual ${r.anio}` });
    const proy = r.proyeccion, totProy = proy.reduce((a, p) => a + p.esperado, 0);
    const graf2 = grafico(proy.map((p, i) => ({ l: MESES[Number(p.mes.slice(5)) - 1], v: p.esperado, cls: 'fut', etq: true })), { alto: 240, descripcion: 'Cobros esperados en los próximos 6 meses' });
    const maxEd = Math.max(1, ...r.edades.map(e => e.valor)), egr = r.egresos;
    const partes = [['Honorarios del abogado', egr.honorarios], ['Bonificación de asesores', egr.bonificacion], ['Gastos admin. y notariales', egr.gastos_admin], ['Adquisición de clientes', egr.gastos_adq], ['Centro de conciliación', egr.pago_centro]];
    const a = r.atencion;
    const lista = S.tab === 'moras' ? a.mayores_moras.map(c => itemCliente(c, `${c.asesor.split(' ')[0]} · ${plural(c.cuotas, 'cuota', 'cuotas')} · ≈ ${c.dias} días`, pesos(c.valor)))
      : a.vencen_semana.map(c => itemCliente(c, `${c.asesor} · vence el ${fdate(c.fecha)}`, pesos(c.valor)));
    const caja = h('div', {});
    const pintarLista = () => poner(caja, ...(lista.length ? lista : [vacio(S.tab === 'moras' ? 'Nadie con cuotas vencidas' : 'Sin vencimientos esta semana', S.tab === 'moras' ? 'Buen momento para revisar los próximos cobros.' : 'No hay cuotas por vencer en los próximos 7 días.')]));
    pintarLista();
    const tabs = h('div', { class: 'ct-tabs', role: 'group', 'aria-label': 'Tipo de lista' }, [['moras', 'Mayores moras'], ['semana', 'Vencen esta semana']].map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(S.tab === k), text: t, onclick: () => { S.tab = k; vInicio(true); } })));
    let visto = false; try { visto = localStorage.getItem('ct_guia') === '1'; } catch {}
    const guia = visto ? null : h('div', { class: 'ct-tip', role: 'note' }, h('span', {}, h('b', { text: 'Primera vez aquí? ' }), 'Toque el ', h('b', { text: '?' }), ' junto a cada término para ver qué significa en palabras simples. Con la tecla ', h('b', { text: '/' }), ' busca a un cliente por cédula.'),
      h('button', { type: 'button', 'aria-label': 'Cerrar la guía', text: '×', onclick: e => { try { localStorage.setItem('ct_guia', '1'); } catch {} e.currentTarget.parentElement.remove(); } }));
    const hora = Number(new Date().toLocaleString('es-CO', { hour: 'numeric', hour12: false, timeZone: 'America/Bogota' }));
    poner(vista, 
      encabezado(`${hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches'}, ${user.nombre.split(' ')[0]}`, new Date(r.hoy + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^./, c => c.toUpperCase()) + (total ? ' · toda la cartera' : ' · sus clientes')),
      guia,
      h('section', { class: 'ct-card ct-hero', 'aria-label': 'Estado de la cartera' }, h('div', {}, h('span', { class: `est ${nivelE}`, text: estado }), h('h2', { text: titulo }), h('p', { text: frase })), t.clientes ? anillo(t.recuperacion) : null,
        t.clientes ? h('div', { class: 'ct-health' }, apilada, h('div', { class: 'ct-leg' }, seg.map(([k, n, c]) => h('span', {}, h('i', { class: k }), n + ' ', h('b', { text: String(c) }))))) : null),
      h('div', { class: 'ct-kpis' }, kpi('Ya recibimos', mill(t.recibido), `${pct(t.recuperacion)} de lo contratado`, 'pos', 'recibido'), kpi('Falta por cobrar', mill(t.saldo), 'lo vencido y lo que aún no vence', '', 'saldo'),
        kpi('Vencido sin pagar', mill(t.valor_en_mora), t.con_mora ? plural(t.con_mora, 'cliente', 'clientes') : 'nadie atrasado', t.valor_en_mora ? 'bad' : '', 'mora'), kpi('Utilidad esperada', mill(t.utilidad_esperada), `${pct(t.total_contrato ? t.utilidad_esperada / t.total_contrato : 0)} del total contratado`, t.utilidad_esperada < 0 ? 'bad' : '', 'utilidad')),
      h('div', { class: 'ct-grid2' },
        h('section', { class: 'ct-card' }, h('h3', {}, 'Recaudo por mes'), h('p', { class: 'sub', text: 'Lo que entró cada mes frente a lo que debía entrar.' }), h('div', { class: 'ct-legend' }, h('span', {}, h('i', { class: 'a' }), 'Recibido'), h('span', {}, h('i', { class: 'b' }), 'Esperado')), graf1),
        h('section', { class: 'ct-card' }, h('h3', {}, 'Lo que viene', ayuda('proyeccion')), h('p', { class: 'sub', text: 'Cobros esperados en los próximos 6 meses.' }), h('div', { class: 'ct-total', text: mill(totProy) }), graf2,
          t.valor_en_mora ? h('p', { class: 'ct-cap mut', text: `Además hay ${mill(t.valor_en_mora)} vencidos por recuperar.` }) : null)),
      h('div', { class: 'ct-grid3 w' },
        h('section', { class: 'ct-card' }, h('h3', {}, 'Mora por antigüedad', ayuda('antiguedad')), h('p', { class: 'sub', text: 'Cuánto dinero está atrasado y desde hace cuánto.' }),
          r.edades.some(e => e.valor) ? h('div', { class: 'ct-bars' }, r.edades.map((e, i) => filaBarra(e.rango, mill(e.valor), e.valor / maxEd, 'l' + (i + 1), plural(e.clientes, 'cliente', 'clientes')))) : vacio('Nadie atrasado', 'No hay cuotas vencidas sin pagar.')),
        h('section', { class: 'ct-card' }, h('h3', {}, 'Requiere atención'), h('p', { class: 'sub', text: 'Toque un cliente para ver su ficha.' }), tabs, caja),
        h('section', { class: 'ct-card' }, h('h3', {}, 'A dónde va el dinero', ayuda('egresos')), h('p', { class: 'sub', text: `Costos de los contratos: ${mill(egr.total)}` }), h('div', { class: 'ct-bars' }, partes.map(([n, v]) => filaBarra(n, mill(v), egr.total ? v / egr.total : 0, '', pct(egr.total ? v / egr.total : 0) + ' del total'))))));
  }

  /* ---------- CLIENTES ---------- */
  const FILTROS = [['todos', 'Todos', () => true], ['ok', 'Al día', c => c.alerta === 'al_dia'], ['mora', 'En mora', c => c.alerta === 'mora'], ['grave', 'Mora grave', c => c.alerta === 'mora_grave' || c.alerta === 'sin_pago'], ['fin', 'Finalizados', c => c.alerta === 'finalizado']];
  const ORDENES = { urgentes: ['Más urgentes primero', (a, b) => b.dias_mora - a.dias_mora || b.valor_en_mora - a.valor_en_mora || a.numero - b.numero], nombre: ['Nombre A–Z', (a, b) => a.nombre.localeCompare(b.nombre, 'es')], saldo: ['Mayor saldo', (a, b) => b.saldo - a.saldo], avance: ['Mayor avance', (a, b) => b.cumplimiento - a.cumplimiento] };
  async function vClientes() {
    S.lista = (await api.get('/cartera/clientes' + (S.q ? '?q=' + encodeURIComponent(S.q) : ''))).clientes;
    const cont = h('div', {});
    const pintar = () => {
      const base = S.lista.filter(c => !S.fAs || c.asesor_id === S.fAs), act = FILTROS.find(f => f[0] === S.fAl)[2];
      const filas = base.filter(act).sort(ORDENES[S.orden][1]);
      poner(cont, 
        h('div', { class: 'ct-filters' }, h('div', { class: 'ct-chips', role: 'group', 'aria-label': 'Filtrar por estado' }, FILTROS.map(([k, t, f]) => h('button', { type: 'button', class: 'ct-chip', 'aria-pressed': String(S.fAl === k), onclick: () => { S.fAl = k; pintar(); } }, t, h('b', { text: String(base.filter(f).length) })))),
          total && asesores.length > 1 ? (() => { const s = h('select', { class: 'ct-sel', 'aria-label': 'Filtrar por asesor' }, h('option', { value: '', text: 'Todos los asesores' }), asesores.map(([id, n]) => h('option', { value: id, text: n }))); s.value = S.fAs; s.addEventListener('change', () => { S.fAs = s.value; pintar(); }); return s; })() : null,
          (() => { const s = h('select', { class: 'ct-sel', 'aria-label': 'Ordenar por' }, Object.entries(ORDENES).map(([k, [t]]) => h('option', { value: k, text: t }))); s.value = S.orden; s.addEventListener('change', () => { S.orden = s.value; pintar(); }); return s; })()),
        h('div', { class: 'ct-card ct-list' }, filas.length ? [h('div', { class: 'ct-lh', 'aria-hidden': 'true' }, h('span', { text: 'Cliente' }), h('span', { text: 'Asesor' }), h('span', { text: 'Avance del contrato' }), h('span', { text: 'Saldo' }), h('span', { text: 'Estado' }), h('span')),
          ...filas.map(c => { const i = h('i'); i.style.width = Math.round(c.cumplimiento * 100) + '%';
            return h('button', { type: 'button', class: 'ct-ro', onclick: () => ir('ficha', c.id), 'aria-label': `Abrir ${c.nombre}` },
              h('span', { class: 'who' }, avatar(c.nombre), h('span', { style: null }, h('span', { class: 'nm', text: c.nombre }), h('span', { class: 'mt', text: `CC ${c.cedula} · ${c.estado_proceso}` }))),
              h('span', { class: 'as', text: c.asesor }), h('span', { class: 'pg' }, h('span', { class: 'ct-track' }, i), h('span', { text: pct(c.cumplimiento) })),
              h('span', { class: 'sd' }, h('b', { text: pesos(c.saldo) }), h('small', { class: c.valor_en_mora ? 'neg' : '', text: c.valor_en_mora ? `Vencido ${pesos(c.valor_en_mora)}` : 'Sin vencidos' })), h('span', { class: 'es' }, pill(c.alerta)), ico('chev', 'chev')); })]
          : [vacio(S.lista.length ? 'Ningún cliente coincide con este filtro' : 'Todavía no hay clientes', S.lista.length ? 'Pruebe con otro estado o quite el filtro de asesor.' : escribe ? 'Cree el primero con «Nuevo cliente».' : 'Cuando haya clientes en su cartera aparecerán aquí.')]));
    };
    const asesores = [...new Map(S.lista.map(c => [c.asesor_id, c.asesor]))];
    poner(vista, encabezado('Clientes', S.q ? `Resultados para «${S.q}»` : `${plural(S.lista.length, 'persona', 'personas')} en su cartera. Busque por cédula arriba.`,
      S.q ? h('button', { type: 'button', class: 'ct-btn', onclick: () => { S.q = ''; ir('clientes'); }, text: 'Quitar búsqueda' }) : null,
      escribe ? h('button', { type: 'button', class: 'ct-btn', onclick: guard(() => formCliente(null)), text: 'Nuevo cliente' }) : null,
      admin || (total && escribe) ? h('a', { class: 'ct-btn', href: '/api/cartera/export.csv', download: 'cartera.csv', text: 'Exportar CSV' }) : null), cont);
    pintar();
  }

  /* ---------- FICHA ---------- */
  async function vFicha() {
    const { cliente: c } = await api.get(`/cartera/clientes/${S.id}`);
    const cuotas = Array.from({ length: c.n_cuotas }, (_, k) => {
      const est = k < c.cuotas_pagadas ? 'paga' : k < c.cuotas_esperadas ? 'mora' : '';
      return h('span', { class: `ct-step ${est}`, title: `Cuota ${k + 1}: ${est === 'paga' ? 'pagada' : est === 'mora' ? 'vencida sin pagar' : 'por vencer'}`, 'aria-label': `Cuota ${k + 1}: ${est === 'paga' ? 'pagada' : est === 'mora' ? 'vencida' : 'por vencer'}` }, String(k + 1));
    });
    const wa = c.telefono ? `https://wa.me/57${c.telefono}?text=${encodeURIComponent(`Hola ${c.nombre.split(' ')[0]}, le recordamos su cuota pendiente de ${pesos(c.valor_en_mora)}.`)}` : null;
    const ced = h('span', { class: 'num', text: S.revelar ? c.cedula : '••••' + c.cedula.slice(-4) });
    const i = h('i'); i.style.width = Math.round(c.cumplimiento * 100) + '%';
    const proximo = c.alerta === 'finalizado' ? [h('span', { class: 'ct-pill ok', text: 'Proceso completado' }), h('p', { class: 'ct-cap', text: 'El cliente pagó el total del contrato.' })]
      : c.cuotas_en_mora ? [h('span', { class: 'v neg', text: pesos(c.valor_en_mora) }), h('p', { class: 'ct-cap', text: `${plural(c.cuotas_en_mora, 'cuota vencida', 'cuotas vencidas')} sin pagar · ≈ ${c.dias_mora} días de atraso.` }),
        h('div', { class: 'ct-acts' }, c.telefono ? h('a', { class: 'ct-btn sm', href: 'tel:' + c.telefono, text: 'Llamar' }) : null, wa ? h('a', { class: 'ct-btn sm', href: wa, target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp' }) : null)]
      : [h('span', { class: 'v', text: c.proximo_vencimiento ? fdate(c.proximo_vencimiento) : '—' }), h('p', { class: 'ct-cap', text: c.proximo_vencimiento ? `Cuota de ${pesos(c.cuota_mensual)}. Va al día.` : 'No quedan cuotas por vencer.' })];
    const menu = () => { const w = raiz.querySelector('.ct-more'); if (w.querySelector('.menu')) return w.querySelector('.menu').remove();
      w.append(h('div', { class: 'menu', role: 'menu' }, h('button', { type: 'button', role: 'menuitem', text: c.estado === 'activo' ? 'Cerrar el proceso' : 'Reabrir el proceso', onclick: guard(async () => { await api.patch(`/cartera/clientes/${c.id}`, { estado: c.estado === 'activo' ? 'cerrado' : 'activo', version: c.version }); toast('Estado actualizado.'); S.resumen = null; vFicha(); }) }),
        h('button', { type: 'button', role: 'menuitem', text: 'Ver historial de auditoría', onclick: () => ir('auditoria', c.id) }), h('button', { type: 'button', class: 'd', role: 'menuitem', text: 'Anonimizar (derecho de supresión)', onclick: () => modalAnonimizar(c) }))); };
    poner(vista, 
      h('button', { type: 'button', class: 'ct-btn ghost sm ct-back', onclick: () => ir('clientes'), text: '← Volver a clientes' }),
      h('div', { class: 'ct-fh' }, avatar(c.nombre, true), h('div', { class: 'id' }, h('h1', { text: c.nombre }),
        h('div', { class: 'meta' }, h('span', {}, 'CC ', ced, ' ', h('button', { type: 'button', class: 'ct-link', text: S.revelar ? 'Ocultar' : 'Mostrar', onclick: () => { S.revelar = !S.revelar; vFicha(); } })), h('span', { text: `N.° ${String(c.numero).padStart(3, '0')}` }), h('span', { text: 'Asesor: ' + c.asesor }), h('span', { class: 'ct-pill info', text: c.estado_proceso }), pill(c.alerta), c.estado === 'cerrado' ? h('span', { class: 'ct-pill fin', text: 'Cerrado' }) : null)),
        h('div', { class: 'ct-acts' }, escribe ? h('button', { type: 'button', class: 'ct-btn pri', onclick: () => modalPago(c), text: 'Registrar pago' }) : null, escribe ? h('button', { type: 'button', class: 'ct-btn', onclick: guard(() => formCliente(c)), text: 'Editar' }) : null,
          admin ? h('span', { class: 'ct-more' }, h('button', { type: 'button', class: 'ct-btn', 'aria-haspopup': 'menu', onclick: e => { e.stopPropagation(); menu(); }, text: 'Más…' })) : null)),
      c.avisos.length ? h('div', { class: 'ct-warn', role: 'note' }, h('span', { text: 'Revise estos datos: ' + c.avisos.join(' · ') + '.' })) : null,
      h('div', { class: 'ct-sum' },
        h('section', { class: 'ct-card' }, h('h3', {}, 'Saldo por cobrar', ayuda('saldo')), h('div', { class: 'ct-big', text: pesos(c.saldo) }), h('div', { class: 'ct-track' }, i), h('p', { class: 'ct-cap', text: `Ha pagado ${pesos(c.recibido)} de ${pesos(c.total_contrato)} (${pct(c.cumplimiento)}).` })),
        h('section', { class: 'ct-card' }, h('div', { class: 'ct-next' }, h('h3', {}, c.cuotas_en_mora ? 'Vencido sin pagar' : 'Próxima cuota', c.cuotas_en_mora ? ayuda('mora') : null), ...proximo)),
        h('section', { class: 'ct-card' }, h('h3', {}, 'Plan de pagos'), h('div', { class: 'ct-steps' }, cuotas), h('p', { class: 'ct-cap', text: `${c.cuotas_pagadas} de ${c.n_cuotas} cuotas pagadas${c.fecha_fin ? ' · termina hacia ' + fdate(c.fecha_fin) : ''}. Verde: pagada · rojo: vencida · gris: por vencer.` }))),
      h('section', { class: 'ct-card' }, h('h3', { text: 'Pagos' }), h('p', { class: 'sub', text: c.pagos.length ? 'Del más reciente al más antiguo.' : '' }),
        ...(c.pagos.length ? c.pagos.map(p => h('div', { class: `ct-pay ${p.anulado ? 'x' : ''}` }, h('span', {}, h('span', { class: 'd', text: fdate(p.fecha) }), h('span', { class: 'k', text: `${p.concepto}${p.nota ? ' · ' + p.nota : ''}${p.anulado ? ' · ANULADO: ' + p.motivo_anulacion : ''}` })),
          h('span', { class: 'ct-acts' }, h('span', { class: 'a', text: pesos(p.valor) }), admin && !p.anulado ? h('button', { type: 'button', class: 'ct-btn sm ghost', text: 'Anular', onclick: () => modalAnular(p) }) : null))) : [vacio('Aún no hay pagos', escribe ? 'Registre el primero con el botón «Registrar pago».' : '')])),
      h('details', { class: 'ct-dt' }, h('summary', { text: 'Contrato y deuda' }), h('div', { class: 'in' }, h('div', { class: 'ct-fields' }, campo('Fecha de ingreso', fdate(c.fecha_ingreso)), campo('Inicio de pagos', fdate(c.inicio_pagos)), campo('Deuda declarada', pesos(c.deuda_declarada)), campo('Deuda priorizada', pesos(c.deuda_priorizada)), campo('Cuotas', `${c.n_cuotas} × ${pesos(c.cuota_mensual)}`), campo('Total del contrato', pesos(c.total_contrato)), campo('Sede', c.sede || '—')))),
      h('details', { class: 'ct-dt' }, h('summary', { text: 'Costos y utilidad' }), h('div', { class: 'in' }, h('div', { class: 'ct-fields' }, campo('Honorarios del abogado', pesos(c.honorarios)), campo('Bonificación del asesor', pesos(c.bonificacion)), campo('Gastos admin. y notariales', pesos(c.gastos_admin)), campo('Adquisición del cliente', pesos(c.gastos_adq)), campo('Centro de conciliación', pesos(c.pago_centro)), campo('Costos totales', pesos(c.costos + c.pago_centro)), campo('Utilidad esperada', pesos(c.utilidad_esperada), c.utilidad_esperada < 0)))),
      c.notas ? h('details', { class: 'ct-dt' }, h('summary', { text: 'Notas' }), h('div', { class: 'in' }, h('p', { text: c.notas }))) : null);
  }
  const campo = (l, v, neg) => h('div', { class: 'ct-fld' }, h('small', { text: l }), h('b', { class: neg ? 'neg' : '', text: v }));

  /* ---------- COBRANZA ---------- */
  const RANGOS = [['todos', 'Todos', () => true], ['1', '1–30 días', c => c.dias_mora <= 30], ['2', '31–60 días', c => c.dias_mora > 30 && c.dias_mora <= 60], ['3', '61–90 días', c => c.dias_mora > 60 && c.dias_mora <= 90], ['4', 'Más de 90', c => c.dias_mora > 90]];
  let rangoSel = 'todos';
  async function vCobranza() {
    const base = (await api.get('/cartera/clientes')).clientes.filter(c => c.valor_en_mora > 0).sort((a, b) => b.dias_mora - a.dias_mora || b.valor_en_mora - a.valor_en_mora);
    const cont = h('div', {});
    const pintar = () => {
      const f = RANGOS.find(r => r[0] === rangoSel)[2], filas = base.filter(f);
      poner(cont, h('div', { class: 'ct-seg', role: 'group', 'aria-label': 'Antigüedad de la mora' }, RANGOS.map(([k, t, fn]) => { const x = base.filter(fn); return h('button', { type: 'button', 'aria-pressed': String(rangoSel === k), onclick: () => { rangoSel = k; pintar(); } }, t, h('small', { text: `${plural(x.length, 'cliente', 'clientes')} · ${mill(x.reduce((a, c) => a + c.valor_en_mora, 0))}` })); })),
        h('div', { class: 'ct-card' }, ...(filas.length ? filas.map(c => itemCliente(c, `${c.asesor} · ${plural(c.cuotas_en_mora, 'cuota vencida', 'cuotas vencidas')} · ≈ ${c.dias_mora} días`, pesos(c.valor_en_mora), pill(c.alerta))) : [vacio('Nadie en este rango', 'No hay clientes con cuotas vencidas aquí.')])));
    };
    poner(vista, encabezado('Cobranza', 'Quién tiene cuotas vencidas y desde hace cuánto. Abra un cliente para llamarle o escribirle por WhatsApp.'), cont);
    pintar();
  }

  /* ---------- FLUJO DE CAJA ---------- */
  async function vFlujo() {
    const [r, { filas }] = await Promise.all([resumen(false), api.get('/cartera/flujo')]);
    const mes = Number(r.hoy.slice(5, 7)) - 1, tot = Array(12).fill(0); filas.forEach(f => f.meses.forEach((v, i) => { tot[i] += v; }));
    const mx = Math.max(1, ...filas.flatMap(f => f.meses));
    const celda = (v, n, m) => { const td = h('td', { class: 'hm', title: `${n} · ${MESES[m]}: ${pesos(v)}`, text: v ? (v / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) : '' }); if (v) td.style.background = `color-mix(in srgb, var(--acc) ${Math.round(14 + (v / mx) * 66)}%, transparent)`; return td; };
    poner(vista, encabezado('Flujo de caja', 'Lo que ha entrado este año y lo que se espera que entre.'),
      h('div', { class: 'ct-grid2' },
        h('section', { class: 'ct-card' }, h('h3', { text: `Recibido en ${r.anio}` }), h('p', { class: 'sub', text: 'Pagos que entraron cada mes frente a lo que debía entrar.' }), h('div', { class: 'ct-total', text: mill(r.mensual.reduce((a, m) => a + m.recibido, 0)) }), grafico(r.mensual.map((m, i) => ({ l: MESES[i], v: m.recibido, e: m.esperado, cls: i === mes ? 'now' : '' })), { descripcion: 'Recibido por mes' })),
        h('section', { class: 'ct-card' }, h('h3', {}, 'Próximos 6 meses', ayuda('proyeccion')), h('p', { class: 'sub', text: 'Cobros esperados si todos pagan a tiempo.' }), h('div', { class: 'ct-total', text: mill(r.proyeccion.reduce((a, p) => a + p.esperado, 0)) }), grafico(r.proyeccion.map(p => ({ l: MESES[Number(p.mes.slice(5)) - 1], v: p.esperado, cls: 'fut', etq: true })), { descripcion: 'Cobros esperados por mes' }))),
      h('details', { class: 'ct-dt' }, h('summary', { text: 'Ver lo recibido por cliente y por mes' }), h('div', { class: 'in' }, h('div', { class: 'ct-tw' }, h('table', { class: 'ct-tbl' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Cliente' }), MESES.map(m => h('th', { scope: 'col', text: m })), h('th', { scope: 'col', text: 'Total' }))),
        h('tbody', {}, filas.map(f => h('tr', {}, h('td', {}, h('button', { type: 'button', class: 'nm', text: f.nombre, onclick: () => ir('ficha', f.id) })), f.meses.map((v, i) => celda(v, f.nombre, i)), h('td', { text: mill(f.total) }))),
          h('tr', { class: 'tot' }, h('td', { text: 'Total' }), tot.map((v, i) => celda(v, 'Total', i)), h('td', { text: mill(tot.reduce((a, b) => a + b, 0)) }))))), h('p', { class: 'ct-cap', text: 'Valores en millones de pesos. Más oscuro = mayor valor.' }))));
  }

  /* ---------- ASESORES ---------- */
  async function vAsesores() {
    const r = await resumen(false);
    poner(vista, encabezado('Asesores', 'Cómo va la cartera de cada asesor.'),
      h('div', { class: 'ct-grid3' }, r.por_asesor.map(a => { const i = h('i'); i.style.width = Math.round(a.recuperacion * 100) + '%';
        return h('section', { class: 'ct-card ct-as' }, h('div', { class: 'top' }, avatar(a.nombre), h('div', {}, h('b', { text: a.nombre }), h('span', { text: plural(a.clientes, 'cliente', 'clientes') }))),
          h('div', {}, h('div', { class: 'ct-brow' }, h('div', { class: 't' }, h('span', { text: 'Recuperado del contrato' }), h('b', { text: pct(a.recuperacion) })), h('div', { class: 'ct-track' }, i))),
          h('div', { class: 'stats' }, h('div', {}, h('small', { text: 'Recibido' }), h('b', { text: mill(a.recibido) })), h('div', {}, h('small', { text: 'Falta' }), h('b', { text: mill(a.saldo) })), h('div', {}, h('small', { text: 'Vencido' }), h('b', { class: a.valor_en_mora ? 'neg' : '', text: mill(a.valor_en_mora) }))),
          h('button', { type: 'button', class: 'ct-btn sm', onclick: () => { S.fAs = a.id; S.fAl = 'todos'; ir('clientes'); }, text: 'Ver sus clientes' })); })));
  }

  /* ---------- IMPORTAR (admin) ---------- */
  function vImportar() {
    const arch = h('input', { type: 'file', accept: '.csv,text/csv', id: 'imF' }), sal = h('div', { class: 'ct-stackv' });
    let csv = '';
    const aplicar = h('button', { type: 'button', class: 'ct-btn pri', text: 'Aplicar importación', hidden: true });
    const parcial = h('input', { type: 'checkbox', id: 'imP' });
    const campoK = (l, v) => campo(l, v);
    const informe = r => {
      aplicar.hidden = false; aplicar.disabled = !((r.rechazos.length === 0) || parcial.checked) || r.validas === 0;
      poner(sal, h('div', { class: 'ct-kpis' }, kpi('Filas leídas', String(r.leidas), ''), kpi('Válidas', String(r.validas), 'listas para importar', 'pos'), kpi('Rechazadas', String(r.rechazos.length), 'hay que corregirlas', r.rechazos.length ? 'bad' : ''), kpi('Ya existían', String(r.omitidas.length), 'no se modifican')),
        h('section', { class: 'ct-card' }, h('h3', { text: 'Conciliación con su hoja' }), h('p', { class: 'sub', text: 'Compare estos totales con el PANEL FINANCIERO de la hoja. Deben coincidir.' }), h('div', { class: 'ct-fields' }, campoK('Clientes', String(r.conciliacion.clientes)), campoK('Deuda declarada', pesos(r.conciliacion.deuda_declarada)), campoK('Total a cobrar', pesos(r.conciliacion.total_contrato)), campoK('Total recibido', pesos(r.conciliacion.recibido)), campoK('Saldo por cobrar', pesos(r.conciliacion.saldo)), campoK('Mora', pesos(r.conciliacion.valor_en_mora)))),
        r.rechazos.length ? h('section', { class: 'ct-card' }, h('h3', { text: 'Filas rechazadas' }), h('p', { class: 'sub', text: 'Corríjalas en la hoja y repita la simulación.' }), h('ul', { class: 'ct-list2' }, r.rechazos.map(x => h('li', { text: `Fila ${x.fila}: ${x.motivo}` })))) : null,
        r.n_avisos ? h('section', { class: 'ct-card' }, h('h3', { text: `Avisos de calidad de datos (${r.n_avisos})` }), h('ul', { class: 'ct-list2' }, r.avisos.slice(0, 60).map(x => h('li', { text: `Fila ${x.fila}: ${x.aviso}` })))) : null,
        r.omitidas.length ? h('section', { class: 'ct-card' }, h('h3', { text: 'Omitidas' }), h('ul', { class: 'ct-list2' }, r.omitidas.slice(0, 60).map(x => h('li', { text: `Fila ${x.fila}: ${x.motivo}` })))) : null,
        h('p', { class: 'ct-cap', text: 'El informe no muestra nombres ni cédulas: solo el número de fila.' }));
    };
    const simular = guard(async () => { if (!csv) return toast('Elija un archivo CSV.'); informe(await api.post('/cartera/import?dry=1', { csv })); });
    arch.addEventListener('change', () => { const f = arch.files[0]; if (!f) return; if (f.size > 2_000_000) return toast('El archivo supera 2 MB.'); const rd = new FileReader(); rd.onload = () => { csv = String(rd.result); simular(); }; rd.readAsText(f, 'utf-8'); });
    parcial.addEventListener('change', () => simular());
    aplicar.addEventListener('click', guard(async () => { aplicar.disabled = true; const r = await api.post('/cartera/import' + (parcial.checked ? '?parcial=1' : ''), { csv }); S.resumen = null; toast(`Importación completa: ${plural(r.creados, 'cliente creado', 'clientes creados')}.`); informe(r); }));
    poner(vista, encabezado('Importar la matriz', 'Se simula primero: no se guarda nada hasta que usted aplique.'),
      h('section', { class: 'ct-card' }, h('ol', { class: 'ct-steps2' }, h('li', { text: 'Cree antes a los asesores en Usuarios, con el mismo nombre que aparece en la columna ASESOR.' }), h('li', { text: 'En Google Sheets: pestaña MATRIZ CLIENTES → Archivo → Descargar → CSV. Agregue la cédula (por ejemplo «María Pérez – 52123456») o una columna CÉDULA.' }),
        h('li', { text: 'Suba el archivo. Corrija lo rechazado y repita hasta que no haya rechazos.' }), h('li', { text: 'Compare la conciliación con el PANEL FINANCIERO de la hoja y, si cuadra, aplique.' })),
        h('div', { class: 'ct-fld2' }, h('label', { for: 'imF', text: 'Archivo CSV (máximo 2 MB)' }), arch), h('label', { class: 'ct-check', for: 'imP' }, parcial, 'Permitir importación parcial (omite las filas rechazadas)'), h('div', { class: 'ct-acts' }, aplicar)), sal);
  }

  /* ---------- AUDITORÍA (admin) ---------- */
  async function vAuditoria() {
    const { eventos } = await api.get('/cartera/auditoria?limite=200' + (S.id ? `&entidad_id=${encodeURIComponent(S.id)}` : ''));
    const res = h('span', { role: 'status' });
    poner(vista, encabezado('Auditoría', S.id ? 'Historial de este cliente.' : 'Quién vio o cambió qué, y cuándo. No guarda datos personales.',
      S.id ? h('button', { type: 'button', class: 'ct-btn', text: 'Ver todo', onclick: () => ir('auditoria') }) : null,
      h('button', { type: 'button', class: 'ct-btn', text: 'Verificar integridad', onclick: guard(async () => { const v = await api.get('/cartera/auditoria/verificar'); res.className = v.ok ? 'ct-ok' : 'ct-no'; res.textContent = v.ok ? `✔ Cadena íntegra (${v.filas} registros)` : `✖ Alteración detectada en el registro ${v.rotoEn}`; }) }), res),
      h('div', { class: 'ct-card' }, h('div', { class: 'ct-tw' }, h('table', { class: 'ct-tbl' }, h('thead', {}, h('tr', {}, ['Fecha', 'Usuario', 'Acción', 'Detalle', 'IP'].map(t => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, eventos.map(e => h('tr', {}, h('td', { text: new Date(e.at).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'medium' }) }), h('td', { text: e.actor }), h('td', { text: e.accion }), h('td', { class: 'mut', text: e.detalle }), h('td', { class: 'mut', text: e.ip }))))))));
  }

  /* ---------- diálogos ---------- */
  function modal(titulo, lead, ...cuerpo) {
    const d = h('dialog', { class: 'ct-dlg', 'aria-labelledby': 'ct-dt' }, h('div', { class: 'in' }, h('h2', { id: 'ct-dt', text: titulo }), lead ? h('p', { class: 'lead', text: lead }) : null, ...cuerpo));
    d.addEventListener('close', () => d.remove()); d.addEventListener('click', e => { if (e.target === d) d.close(); });
    raiz.append(d); d.showModal(); d.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea')?.focus(); return d;
  }
  const fld = (id, etiqueta, el) => h('div', { class: 'ct-fld2' }, h('label', { for: id, text: etiqueta }), el);
  const numero = (id, v) => { const i = h('input', { id, inputmode: 'numeric', autocomplete: 'off', value: v ? String(v) : '' }); i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); }); return i; };
  const botones = (getD, ok) => h('div', { class: 'foot' }, h('button', { type: 'button', class: 'ct-btn', text: 'Cancelar', onclick: () => getD().close() }), ok);
  const tras = id => { S.resumen = null; if (S.vista === 'ficha' && S.id === id) return vFicha(); return ir('ficha', id); };

  function modalPago(c) {
    const cuerpo = h('div', {});
    const d = modal('Registrar un pago', c ? `Cliente: ${c.nombre}` : 'Busque al cliente por cédula o nombre.', cuerpo);
    const formulario = cl => {
      const idem = crypto.randomUUID(); // un doble clic reenvía la misma clave: el servidor no duplica el pago
      const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
      const fecha = h('input', { id: 'pgF', type: 'date', value: hoy, max: hoy, required: true }), valor = numero('pgV', cl.cuota_mensual);
      const concepto = h('select', { id: 'pgC' }, [['cuota', 'Cuota'], ['anticipo', 'Anticipo'], ['honorarios', 'Honorarios'], ['otro', 'Otro']].map(([v, t]) => h('option', { value: v, text: t })));
      const nota = h('input', { id: 'pgN', maxlength: '300', autocomplete: 'off', placeholder: 'Opcional' }), err = h('p', { class: 'ct-err', role: 'alert' }), ok = h('button', { type: 'submit', class: 'ct-btn pri', text: 'Registrar pago' });
      poner(cuerpo, h('p', { class: 'mut', text: `${cl.nombre} · saldo ${pesos(cl.saldo)}${cl.valor_en_mora ? ' · vencido ' + pesos(cl.valor_en_mora) : ''}` }), h('form', { novalidate: true, onsubmit: async e => {
        e.preventDefault(); if (ok.disabled) return; err.textContent = '';
        if (!valor.value || Number(valor.value) <= 0) return (err.textContent = 'Escriba el valor del pago.');
        ok.disabled = true;
        try { await api.post(`/cartera/clientes/${cl.id}/pagos`, { fecha: fecha.value, valor: valor.value, concepto: concepto.value, nota: nota.value, idem }); d.close(); toast('Pago registrado.'); await tras(cl.id); }
        catch (x) { if (x instanceof ApiError && x.status === 401) { d.close(); fallo(x); } else err.textContent = x.message; } finally { ok.disabled = false; }
      } }, h('div', { class: 'ct-fgrid' }, fld('pgF', 'Fecha del pago', fecha), fld('pgV', 'Valor (pesos, sin decimales)', valor), fld('pgC', 'Concepto', concepto), fld('pgN', 'Nota', nota)), err, botones(() => d, ok)));
      valor.focus(); valor.select();
    };
    if (c) return formulario(c);
    const q = h('input', { id: 'pkQ', type: 'search', placeholder: 'Cédula o nombre…', autocomplete: 'off', inputmode: 'search' }), lista = h('div', { class: 'ct-pick', hidden: true });
    let t2; q.addEventListener('input', () => { clearTimeout(t2); const v = q.value.trim(); if (v.length < 3) { lista.hidden = true; return; }
      t2 = setTimeout(guard(async () => { const r = (await api.get('/cartera/clientes?q=' + encodeURIComponent(v))).clientes.filter(x => x.estado === 'activo').slice(0, 8);
        poner(lista, ...(r.length ? r.map(x => h('button', { type: 'button', onclick: () => formulario(x) }, avatar(x.nombre), h('span', {}, h('b', { text: x.nombre }), h('br'), h('small', { class: 'mut', text: `CC ${x.cedula} · saldo ${pesos(x.saldo)}` })))) : [h('p', { class: 'mut', text: 'No encontramos clientes activos con eso.' })])); lista.hidden = false; }), 250); });
    poner(cuerpo, fld('pkQ', 'Cliente', q), lista, botones(() => d, null));
  }
  function modalAnular(p) {
    const motivo = h('input', { id: 'anM', maxlength: '300', autocomplete: 'off', required: true }), err = h('p', { class: 'ct-err', role: 'alert' });
    const d = modal(`Anular el pago de ${pesos(p.valor)}`, 'Los pagos no se borran: la anulación queda en el historial y en la auditoría.', h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault(); err.textContent = ''; try { await api.post(`/cartera/pagos/${p.id}/anular`, { motivo: motivo.value }); d.close(); toast('Pago anulado. Queda registrado.'); S.resumen = null; vFicha(); } catch (x) { err.textContent = x.message; }
    } }, fld('anM', 'Motivo de la anulación', motivo), err, botones(() => d, h('button', { type: 'submit', class: 'ct-btn danger', text: 'Anular pago' }))));
  }
  function modalAnonimizar(c) {
    const conf = h('input', { id: 'anC', autocomplete: 'off' }), err = h('p', { class: 'ct-err', role: 'alert' });
    const d = modal('Anonimizar a este cliente', 'Se borran nombre, cédula, teléfono, correo y notas. El libro de pagos se conserva para la contabilidad. No se puede deshacer.', h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault(); if (conf.value !== 'ANONIMIZAR') return (err.textContent = 'Escriba ANONIMIZAR para confirmar.');
      try { await api.post(`/cartera/clientes/${c.id}/anonimizar`); d.close(); toast('Datos personales eliminados.'); S.resumen = null; ir('clientes'); } catch (x) { err.textContent = x.message; }
    } }, fld('anC', 'Escriba ANONIMIZAR', conf), err, botones(() => d, h('button', { type: 'submit', class: 'ct-btn danger', text: 'Anonimizar' }))));
  }
  async function formCliente(c) {
    const nuevo = !c; let ases = [];
    if (admin) ases = (await api.get('/cartera/asesores')).asesores;
    const t = (id, v, extra = {}) => h('input', { id, value: v ?? '', autocomplete: 'off', ...extra });
    const f = { nombre: t('cNom', c?.nombre, { maxlength: '120' }), cedula: t('cCed', nuevo ? '' : c.cedula, { inputmode: 'numeric' }), telefono: t('cTel', c?.telefono, { inputmode: 'tel' }), correo: t('cCor', c?.correo, { type: 'email' }),
      fecha_ingreso: h('input', { id: 'cFi', type: 'date', value: c?.fecha_ingreso || '' }), inicio_pagos: h('input', { id: 'cIp', type: 'date', value: c?.inicio_pagos || '' }), n_cuotas: numero('cNc', c?.n_cuotas || 1), sede: t('cSed', c?.sede, { maxlength: '80' }) };
    const dinero = [['deuda_declarada', 'Deuda declarada'], ['deuda_priorizada', 'Deuda priorizada (30 %)'], ['cuota_mensual', 'Cuota mensual del proceso'], ['total_contrato', 'Total del contrato'], ['pago_centro', 'Pago al centro de conciliación'], ['honorarios', 'Honorarios del abogado'], ['bonificacion', 'Bonificación del asesor'], ['gastos_admin', 'Gastos admin. y notariales'], ['gastos_adq', 'Adquisición del cliente']];
    dinero.forEach(([k]) => { f[k] = numero('c_' + k, c?.[k]); });
    const estado = h('select', { id: 'cEst' }, cfg.cartera.estados.map(e => h('option', { value: e, text: e }))); estado.value = c?.estado_proceso || 'A. Inicio';
    const sel = admin ? h('select', { id: 'cAs' }, ases.map(a => h('option', { value: a.id, text: a.nombre }))) : null; if (sel && c) sel.value = c.asesor_id;
    const notas = h('textarea', { id: 'cNot', maxlength: '2000' }); notas.value = c?.notas || '';
    const err = h('p', { class: 'ct-err', role: 'alert' }), ok = h('button', { class: 'ct-btn pri', type: 'submit', text: nuevo ? 'Crear cliente' : 'Guardar cambios' });
    const d = modal(nuevo ? 'Nuevo cliente' : 'Editar cliente', nuevo ? 'La cédula es obligatoria: con ella se busca al cliente.' : c.nombre, h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault(); if (ok.disabled) return; err.textContent = ''; ok.disabled = true;
      const body = { nombre: f.nombre.value, cedula: f.cedula.value, telefono: f.telefono.value, correo: f.correo.value, notas: notas.value, estado_proceso: estado.value, fecha_ingreso: f.fecha_ingreso.value || null, inicio_pagos: f.inicio_pagos.value || null,
        n_cuotas: Number(f.n_cuotas.value || 1), sede: f.sede.value, ...Object.fromEntries(dinero.map(([k]) => [k, f[k].value || '0'])) };
      if (sel) body.asesor_id = sel.value;
      try { if (nuevo) { const r = await api.post('/cartera/clientes', body); d.close(); toast('Cliente creado.'); S.resumen = null; ir('ficha', r.cliente.id); } else { await api.patch(`/cartera/clientes/${c.id}`, { ...body, version: c.version }); d.close(); toast('Cambios guardados.'); S.resumen = null; vFicha(); } }
      catch (x) { if (x instanceof ApiError && x.status === 401) { d.close(); fallo(x); } else err.textContent = x.message; } finally { ok.disabled = false; }
    } }, h('div', { class: 'ct-sec', text: 'Datos personales' }), h('div', { class: 'ct-fgrid' }, fld('cNom', 'Nombre completo', f.nombre), fld('cCed', 'Cédula', f.cedula), fld('cTel', 'Teléfono', f.telefono), fld('cCor', 'Correo', f.correo)),
    h('div', { class: 'ct-sec', text: 'Proceso' }), h('div', { class: 'ct-fgrid' }, sel ? fld('cAs', 'Asesor', sel) : null, fld('cEst', 'Estado del proceso', estado), fld('cFi', 'Fecha de ingreso', f.fecha_ingreso), fld('cIp', 'Inicio de pagos', f.inicio_pagos), fld('cSed', 'Sede o entidad', f.sede)),
    h('div', { class: 'ct-sec', text: 'Contrato y deuda' }), h('div', { class: 'ct-fgrid' }, fld('cNc', 'N.° de cuotas', f.n_cuotas), ...dinero.slice(0, 4).map(([k, tt]) => fld('c_' + k, tt, f[k]))),
    h('div', { class: 'ct-sec', text: 'Costos' }), h('div', { class: 'ct-fgrid' }, ...dinero.slice(4).map(([k, tt]) => fld('c_' + k, tt, f[k]))), fld('cNot', 'Notas', notas), err, botones(() => d, ok)));
  }

  const VISTAS = { inicio: vInicio, clientes: vClientes, ficha: vFicha, cobranza: vCobranza, flujo: vFlujo, asesores: vAsesores, importar: vImportar, auditoria: vAuditoria };
  pintarNav();
  return { abrir: () => ir(S.vista, S.id), olvidar: () => { S.lista = []; S.resumen = null; S.revelar = false; poner(vista); } };
}
