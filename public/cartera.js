import { api, ApiError } from './api.js';

/* Módulo Cartera (matriz financiera). Sin innerHTML: todo se construye con nodos DOM y textContent. */
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const pesos = n => COP.format(n || 0);
const pct = n => ((n || 0) * 100).toFixed(1).replace('.', ',') + '%';
const fdate = s => (s ? s.split('-').reverse().join('/') : '—');
const MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const ALERTA = { al_dia: ['ok', '🟢 Al día'], mora: ['warn', '🟡 En mora'], mora_grave: ['bad', '🔴 Mora grave'], sin_pago: ['bad', '🔴 Sin pago'], finalizado: ['fin', 'Finalizado'] };
const SVGNS = 'http://www.w3.org/2000/svg';

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
const chip = a => { const [k, t] = ALERTA[a] || ['fin', a]; return h('span', { class: `ct-chip ${k}`, text: t }); };
const kpi = (l, v, sub = '', cls = '') => h('div', { class: `ct-kpi ${cls}` }, h('small', { text: l }), h('b', { text: v }), sub ? h('em', { text: sub }) : null);
const fld = (l, v, cls = '') => h('div', { class: 'ct-f' }, h('small', { text: l }), h('b', { class: cls, text: v }));
const barra = (v, cls = '') => { const i = h('i'); i.style.width = Math.round(Math.min(1, v) * 100) + '%'; return h('div', { class: `ct-prog ${cls}` }, i); };
const leyenda = items => h('div', { class: 'ct-legend' }, items.map(([c, t]) => h('span', { class: c, text: t })));

/** Gráfico de barras (recibido) con marcas (esperado). Accesible: <title> por barra + resumen en aria-label. */
function graficoMensual(meses, alto = 200) {
  const W = 640, L = 46, B = 24, T = 10, iw = W - L - 6, ih = alto - B - T;
  const max = Math.max(1, ...meses.flatMap(m => [m.recibido, m.esperado]));
  const paso = Math.pow(10, Math.floor(Math.log10(max))), top = Math.ceil(max / paso) * paso;
  const g = sv('svg', { viewBox: `0 0 ${W} ${alto}`, class: 'ct-chart', role: 'img', 'aria-label': `Recaudo mensual: ${pesos(meses.reduce((a, m) => a + m.recibido, 0))} recibidos en el año` });
  for (let i = 0; i <= 3; i++) {
    const y = T + ih - (ih * i) / 3;
    g.append(sv('line', { class: 'gl', x1: L, x2: W - 6, y1: y, y2: y }), Object.assign(sv('text', { x: L - 6, y: y + 4, 'text-anchor': 'end' }), { textContent: ((top * i) / 3 / 1e6).toFixed(top >= 3e6 ? 0 : 1) + ' M' }));
  }
  const bw = iw / meses.length;
  meses.forEach((m, i) => {
    const x = L + i * bw, bh = (ih * m.recibido) / top;
    g.append(sv('rect', { class: 'bar', x: x + bw * 0.22, y: T + ih - bh, width: bw * 0.56, height: Math.max(0, bh), rx: 4 }, Object.assign(sv('title'), { textContent: `${MES[i]}: recibido ${pesos(m.recibido)} · esperado ${pesos(m.esperado)}` })));
    if (m.esperado) { const y = T + ih - (ih * m.esperado) / top; g.append(sv('line', { class: 'mk', x1: x + bw * 0.1, x2: x + bw * 0.9, y1: y, y2: y })); }
    g.append(Object.assign(sv('text', { x: x + bw / 2, y: alto - 7, 'text-anchor': 'middle' }), { textContent: MES[i] }));
  });
  return g;
}

export function montarCartera(raiz, { user, cfg, toast, fallo }) {
  const nivel = user.rol === 'admin' ? 'total' : user.acceso_cartera;
  const admin = user.rol === 'admin', escribe = user.rol !== 'lector' && nivel !== 'ninguno', total = nivel === 'total';
  const C = { vista: 'resumen', id: null, lista: [], resumen: null, flujo: null, q: '', fAs: '', fAl: '', orden: { k: 'numero', d: 1 }, revelar: false };
  const VISTAS = [['resumen', 'Resumen'], ['clientes', 'Clientes'], ['cobranza', 'Cobranza'], ['flujo', 'Flujo anual'],
    ...(total ? [['asesores', 'Asesores']] : []), ...(admin ? [['importar', 'Importar'], ['auditoria', 'Auditoría']] : [])];
  const nav = h('nav', { class: 'ct-nav', 'aria-label': 'Secciones de cartera' });
  const cont = h('div', { class: 'ct-body' });
  raiz.replaceChildren(nav, cont);

  const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { fallo(e); } };
  const pintarNav = () => nav.replaceChildren(...VISTAS.map(([k, t]) => h('button', { type: 'button', class: 'ct-tab', 'aria-current': String((C.vista === k) || (k === 'clientes' && C.vista === 'ficha')), text: t, onclick: () => ir(k) })));
  async function ir(v, id = null) { C.vista = v; C.id = id; pintarNav(); cont.replaceChildren(h('p', { class: 'ct-vacio', text: 'Cargando…' })); await guard(PINTAR[v])(); }

  /* ---------- Resumen ---------- */
  async function vResumen() {
    const [r, l] = await Promise.all([api.get('/cartera/resumen'), api.get('/cartera/clientes')]);
    C.resumen = r; C.lista = l.clientes;
    const t = r.totales, mayores = [...C.lista].filter(c => c.valor_en_mora > 0).sort((a, b) => b.valor_en_mora - a.valor_en_mora).slice(0, 5);
    const seg = [['al_dia', 'Al día', 'ok'], ['mora', 'En mora', 'warn'], ['mora_grave', 'Mora grave', 'bad'], ['sin_pago', 'Sin pago', 'bad'], ['finalizado', 'Finalizados', 'fin']];
    const apilada = h('div', { class: 'ct-stack', role: 'img', 'aria-label': 'Distribución de la cartera por estado' });
    seg.forEach(([k, n, c]) => { if (r.alertas[k]) { const i = h('i', { class: c, title: `${n}: ${r.alertas[k]}` }); i.style.flexGrow = String(r.alertas[k]); apilada.append(i); } });
    cont.replaceChildren(
      h('div', { class: 'ct-kpis' }, kpi('Clientes activos', String(t.activos), `de ${t.clientes} en cartera`), kpi('Total a cobrar', pesos(t.total_contrato), 'contratos'),
        kpi('Recibido', pesos(t.recibido), pct(t.recuperacion) + ' recuperado', 'ok'), kpi('Saldo por cobrar', pesos(t.saldo)),
        kpi('Mora acumulada', pesos(t.valor_en_mora), `${t.con_mora} cliente(s)`, t.valor_en_mora ? 'bad' : ''), kpi('Utilidad esperada', pesos(t.utilidad_esperada), 'contrato − costos − centro')),
      h('div', { class: 'ct-grid' },
        h('section', { class: 'ct-card' }, h('h3', { text: `Recaudo mensual ${r.anio}` }), leyenda([['c1', 'Recibido'], ['c2', 'Esperado (cuotas del mes)']]), graficoMensual(r.mensual)),
        h('section', { class: 'ct-card' }, h('h3', { text: 'Salud de la cartera' }), apilada,
          ...seg.map(([k, n, c]) => h('div', { class: 'ct-row' }, h('span', { class: `ct-chip ${c}`, text: n }), h('b', { text: String(r.alertas[k]) })))),
        total ? h('section', { class: 'ct-card' }, h('h3', { text: 'Recaudo por asesor' }), ...r.por_asesor.map(a => h('div', { class: 'ct-asr' }, h('div', { class: 'ct-row' }, h('span', { text: a.nombre }), h('b', { text: pesos(a.recibido) })), barra(a.recuperacion)))) : null,
        h('section', { class: 'ct-card' }, h('h3', { text: 'Mayores moras' }),
          ...(mayores.length ? mayores.map(c => h('button', { type: 'button', class: 'ct-row ct-link', onclick: () => ir('ficha', c.id) }, h('span', {}, c.nombre, h('small', { text: ` · ${c.cuotas_en_mora} cuota(s)` })), h('b', { class: 'neg', text: pesos(c.valor_en_mora) }))) : [h('p', { class: 'ct-vacio', text: 'Sin mora.' })]))));
  }

  /* ---------- Clientes ---------- */
  const COLS = [['numero', 'N°'], ['nombre', 'Cliente'], ['asesor', 'Asesor'], ['estado_proceso', 'Estado'], ['total_contrato', 'Contrato', 1], ['recibido', 'Recibido', 1], ['saldo', 'Saldo', 1], ['cumplimiento', '% Cumpl.', 1], ['valor_en_mora', 'En mora', 1], ['alerta', 'Alerta']];
  function filtrada() {
    const o = C.orden;
    return C.lista.filter(c => (!C.fAs || c.asesor_id === C.fAs) && (!C.fAl || c.alerta === C.fAl))
      .sort((a, b) => { const x = a[o.k], y = b[o.k]; return (x > y ? 1 : x < y ? -1 : 0) * o.d; });
  }
  function tabla() {
    const l = filtrada();
    return h('div', { class: 'ct-tw' }, h('table', { class: 'ct-table' },
      h('thead', {}, h('tr', {}, COLS.map(([k, t, r]) => h('th', { class: r ? 'r' : '', scope: 'col', 'aria-sort': C.orden.k === k ? (C.orden.d > 0 ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: 'ct-th', text: t + (C.orden.k === k ? (C.orden.d > 0 ? ' ▲' : ' ▼') : ''), onclick: () => { C.orden = { k, d: C.orden.k === k ? -C.orden.d : 1 }; repintarTabla(); } }))))),
      h('tbody', {}, l.length ? l.map(c => h('tr', {},
        h('td', { class: 'mut', text: String(c.numero).padStart(3, '0') }),
        h('td', {}, h('button', { type: 'button', class: 'ct-link-t', text: c.nombre, onclick: () => ir('ficha', c.id) }), h('small', { class: 'mut', text: 'CC ' + c.cedula })),
        h('td', { text: c.asesor }), h('td', { text: c.estado_proceso }), h('td', { class: 'r', text: pesos(c.total_contrato) }), h('td', { class: 'r', text: pesos(c.recibido) }), h('td', { class: 'r', text: pesos(c.saldo) }),
        h('td', { class: 'r' }, h('div', { class: 'ct-pc' }, barra(c.cumplimiento), h('span', { text: pct(c.cumplimiento) }))),
        h('td', { class: `r ${c.valor_en_mora ? 'neg' : 'mut'}`, text: c.valor_en_mora ? pesos(c.valor_en_mora) : '—' }), h('td', {}, chip(c.alerta))))
        : [h('tr', {}, h('td', { colspan: 10, class: 'ct-vacio', text: 'Sin resultados.' }))])));
  }
  let tablaEl;
  const repintarTabla = () => { const n = tabla(); tablaEl.replaceWith(n); tablaEl = n; };
  async function vClientes() {
    const l = await api.get('/cartera/clientes' + (C.q ? '?q=' + encodeURIComponent(C.q) : ''));
    C.lista = l.clientes;
    const asesores = [...new Map(C.lista.map(c => [c.asesor_id, c.asesor]))];
    let deb;
    const buscar = h('input', { type: 'search', class: 'ct-input', placeholder: 'Buscar por cédula o nombre…', 'aria-label': 'Buscar cliente por cédula o nombre', value: C.q, autocomplete: 'off', inputmode: 'search' });
    buscar.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(guard(async () => { C.q = buscar.value.trim(); const r = await api.get('/cartera/clientes' + (C.q ? '?q=' + encodeURIComponent(C.q) : '')); C.lista = r.clientes; repintarTabla(); }), 250); });
    const selAs = h('select', { class: 'ct-input', 'aria-label': 'Filtrar por asesor' }, h('option', { value: '', text: 'Todos los asesores' }), asesores.map(([id, n]) => h('option', { value: id, text: n })));
    selAs.value = C.fAs; selAs.addEventListener('change', () => { C.fAs = selAs.value; repintarTabla(); });
    const selAl = h('select', { class: 'ct-input', 'aria-label': 'Filtrar por alerta' }, h('option', { value: '', text: 'Todas las alertas' }), Object.entries(ALERTA).map(([k, [, t]]) => h('option', { value: k, text: t })));
    selAl.value = C.fAl; selAl.addEventListener('change', () => { C.fAl = selAl.value; repintarTabla(); });
    tablaEl = tabla();
    cont.replaceChildren(h('div', { class: 'ct-bar' }, buscar, selAs, selAl,
      escribe ? h('button', { type: 'button', class: 'btn primary', text: 'Nuevo cliente', onclick: () => formCliente(null) }) : null,
      admin || (total && escribe) ? h('a', { class: 'btn', href: '/api/cartera/export.csv', download: 'cartera.csv', text: 'Exportar CSV' }) : null), tablaEl,
      h('p', { class: 'hint', text: 'La cédula completa solo se muestra dentro de la ficha del cliente, y cada consulta queda registrada.' }));
    buscar.focus();
  }

  /* ---------- Ficha ---------- */
  async function vFicha() {
    const { cliente: c } = await api.get(`/cartera/clientes/${C.id}`);
    const ancla = c.inicio_pagos ? Number(c.inicio_pagos.slice(8)) : 1;
    const cuotas = Array.from({ length: c.n_cuotas }, (_, k) => {
      const est = k < c.cuotas_pagadas ? 'paga' : k < c.cuotas_esperadas ? 'mora' : '';
      return h('span', { class: `ct-q ${est}`, title: `Cuota ${k + 1}: ${est === 'paga' ? 'pagada' : est === 'mora' ? 'en mora' : 'pendiente'}`, text: String(k + 1) });
    });
    const meses = Array.from({ length: 12 }, () => ({ recibido: 0, esperado: 0 })), anio = new Date().getFullYear();
    c.pagos.filter(p => !p.anulado && p.fecha.startsWith(String(anio))).forEach(p => { meses[Number(p.fecha.slice(5, 7)) - 1].recibido += p.valor; });
    const cedula = h('b', { class: 'ct-ced', text: C.revelar ? c.cedula : c.cedula });
    cedula.textContent = C.revelar ? c.cedula : '••••' + c.cedula.slice(-4);
    const verCed = h('button', { type: 'button', class: 'btn sm quiet', text: C.revelar ? 'Ocultar' : 'Mostrar cédula', onclick: () => { C.revelar = !C.revelar; vFicha(); } });
    const wa = c.telefono ? `https://wa.me/57${c.telefono}?text=${encodeURIComponent(`Hola ${c.nombre.split(' ')[0]}, le recordamos su cuota pendiente de ${pesos(c.valor_en_mora)}.`)}` : null;
    cont.replaceChildren(
      h('button', { type: 'button', class: 'btn sm quiet', text: '← Clientes', onclick: () => ir('clientes') }),
      h('div', { class: 'ct-head' }, h('div', {}, h('h2', { text: c.nombre }), h('p', { class: 'hint' }, 'CC ', cedula, ' ', verCed, ` · N° ${String(c.numero).padStart(3, '0')} · Asesor: ${c.asesor}`),
        c.telefono ? h('p', { class: 'hint' }, `Tel. ${c.telefono} `, h('a', { href: 'tel:' + c.telefono, text: 'Llamar' }), ' · ', h('a', { href: wa, target: '_blank', rel: 'noopener noreferrer', text: 'WhatsApp' })) : null),
        h('div', { class: 'ct-acts' }, h('span', { class: 'ct-chip info', text: c.estado_proceso }), chip(c.alerta), c.estado === 'cerrado' ? h('span', { class: 'ct-chip fin', text: 'Cerrado' }) : null,
          escribe ? h('button', { type: 'button', class: 'btn primary', text: '+ Pago', onclick: () => formPago(c) }) : null,
          escribe ? h('button', { type: 'button', class: 'btn', text: 'Editar', onclick: () => formCliente(c) }) : null)),
      c.avisos.length ? h('div', { class: 'ct-aviso', role: 'note' }, h('b', { text: 'Revisar datos: ' }), c.avisos.join(' · ')) : null,
      h('div', { class: 'ct-kpis' }, kpi('Total contrato', pesos(c.total_contrato), `${c.n_cuotas} cuotas de ${pesos(c.cuota_mensual)}`), kpi('Recibido', pesos(c.recibido), pct(c.cumplimiento) + ' del contrato', 'ok'),
        kpi('Saldo por cobrar', pesos(c.saldo), `${c.cuotas_restantes} cuotas restantes`), kpi('En mora', pesos(c.valor_en_mora), c.cuotas_en_mora ? `${c.cuotas_en_mora} cuota(s) · ≈${c.dias_mora} días` : 'Al día', c.valor_en_mora ? 'bad' : '')),
      barra(c.cumplimiento, 'big'),
      h('div', { class: 'ct-grid' },
        h('section', { class: 'ct-card' }, h('h3', { text: 'Calendario de cuotas' }), leyenda([['c3', 'Pagada'], ['c4', 'En mora'], ['c5', 'Pendiente']]), h('div', { class: 'ct-cuotas' }, cuotas),
          h('p', { class: 'hint', text: `Inicio de pagos ${fdate(c.inicio_pagos)} (día ${ancla}) · Finalización estimada ${fdate(c.fecha_fin)}` + (c.proximo_vencimiento ? ` · Próximo vencimiento ${fdate(c.proximo_vencimiento)}` : '') })),
        h('section', { class: 'ct-card' }, h('h3', { text: `Pagos recibidos ${anio}` }), graficoMensual(meses, 170)),
        h('section', { class: 'ct-card' }, h('h3', { text: 'Historial de pagos' }),
          ...(c.pagos.length ? c.pagos.map(p => h('div', { class: `ct-row ${p.anulado ? 'anulado' : ''}` }, h('span', {}, fdate(p.fecha), h('small', { text: ` · ${p.concepto}${p.nota ? ' · ' + p.nota : ''}${p.anulado ? ' · ANULADO: ' + p.motivo_anulacion : ''}` })),
            h('span', { class: 'ct-acts' }, h('b', { text: pesos(p.valor) }), admin && !p.anulado ? h('button', { type: 'button', class: 'btn sm quiet', text: 'Anular', onclick: () => formAnular(p) }) : null))) : [h('p', { class: 'ct-vacio', text: 'Aún sin pagos.' })])),
        h('section', { class: 'ct-card' }, h('h3', { text: 'Proceso y deuda' }), h('div', { class: 'ct-fg' }, fld('Fecha de ingreso', fdate(c.fecha_ingreso)), fld('Deuda declarada', pesos(c.deuda_declarada)), fld('Deuda priorizada', pesos(c.deuda_priorizada)), fld('Pago centro conciliación', pesos(c.pago_centro)), fld('Sede', c.sede || '—'), fld('Cuotas pagadas', `${c.cuotas_pagadas} / ${c.n_cuotas}`)),
          h('h3', { class: 'ct-sp', text: 'Costos y rentabilidad' }), h('div', { class: 'ct-fg' }, fld('Honorarios abogado', pesos(c.honorarios)), fld('Bonificación asesor', pesos(c.bonificacion)), fld('Gastos admin', pesos(c.gastos_admin)), fld('Gastos adquisición', pesos(c.gastos_adq)), fld('Costos totales', pesos(c.costos)), fld('Utilidad esperada', pesos(c.utilidad_esperada), c.utilidad_esperada < 0 ? 'neg' : ''))),
        c.notas ? h('section', { class: 'ct-card' }, h('h3', { text: 'Notas' }), h('p', { class: 'ct-notas', text: c.notas })) : null,
        admin ? h('section', { class: 'ct-card' }, h('h3', { text: 'Administración' }), h('div', { class: 'ct-acts' },
          h('button', { type: 'button', class: 'btn', text: c.estado === 'activo' ? 'Cerrar proceso' : 'Reabrir proceso', onclick: guard(async () => { await api.patch(`/cartera/clientes/${c.id}`, { estado: c.estado === 'activo' ? 'cerrado' : 'activo', version: c.version }); toast('Estado actualizado.'); vFicha(); }) }),
          h('button', { type: 'button', class: 'btn', text: 'Ver auditoría', onclick: () => ir('auditoria', c.id) }),
          h('button', { type: 'button', class: 'btn danger', text: 'Anonimizar (derecho de supresión)', onclick: () => formAnonimizar(c) }))) : null));
  }

  /* ---------- diálogos ---------- */
  function dialogo(titulo, cuerpo) {
    const d = h('dialog', { class: 'ct-dlg', 'aria-label': titulo }, h('div', { class: 'dlg' }, h('h2', { text: titulo }), cuerpo));
    d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal(); d.querySelector('input:not([type=hidden]),select,textarea')?.focus();
    return d;
  }
  const campo = (id, etiqueta, el) => h('div', { class: 'field' }, h('label', { for: id, text: etiqueta }), el);
  const numero = (id, v) => { const i = h('input', { id, inputmode: 'numeric', autocomplete: 'off', value: v ? String(v) : '' }); i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); }); return i; };

  function formPago(c) {
    const idem = crypto.randomUUID(); // un doble clic reenvía la misma clave: el servidor no duplica el pago
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const fecha = h('input', { id: 'pgF', type: 'date', value: hoy, required: true }), valor = numero('pgV', c.cuota_mensual);
    const concepto = h('select', { id: 'pgC' }, ['cuota', 'anticipo', 'honorarios', 'otro'].map(x => h('option', { value: x, text: x[0].toUpperCase() + x.slice(1) })));
    const nota = h('input', { id: 'pgN', maxlength: '300', autocomplete: 'off' }), err = h('p', { class: 'err', role: 'alert' }), ok = h('button', { class: 'btn primary', type: 'submit', text: 'Registrar pago' });
    const d = dialogo(`Registrar pago · ${c.nombre}`, h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault(); if (ok.disabled) return; err.textContent = '';
      if (!valor.value || Number(valor.value) <= 0) return (err.textContent = 'Escribe el valor del pago.');
      ok.disabled = true;
      try { await api.post(`/cartera/clientes/${c.id}/pagos`, { fecha: fecha.value, valor: valor.value, concepto: concepto.value, nota: nota.value, idem }); d.close(); toast('Pago registrado.'); vFicha(); }
      catch (x) { if (x instanceof ApiError && x.status === 401) { d.close(); fallo(x); } else err.textContent = x.message; } finally { ok.disabled = false; }
    } }, campo('pgF', 'Fecha del pago', fecha), campo('pgV', 'Valor (COP, sin decimales)', valor), campo('pgC', 'Concepto', concepto), campo('pgN', 'Nota (opcional)', nota), err,
    h('div', { class: 'dlg-f' }, h('div'), h('div', {}, h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => d.close() }), ok))));
  }
  function formAnular(p) {
    const motivo = h('input', { id: 'anM', maxlength: '300', autocomplete: 'off', required: true }), err = h('p', { class: 'err', role: 'alert' });
    const d = dialogo(`Anular pago de ${pesos(p.valor)}`, h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault(); err.textContent = '';
      try { await api.post(`/cartera/pagos/${p.id}/anular`, { motivo: motivo.value }); d.close(); toast('Pago anulado (queda registrado).'); vFicha(); } catch (x) { err.textContent = x.message; }
    } }, h('p', { class: 'hint', text: 'Los pagos no se borran: la anulación queda en el historial y en la auditoría.' }), campo('anM', 'Motivo de la anulación', motivo), err,
    h('div', { class: 'dlg-f' }, h('div'), h('div', {}, h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => d.close() }), h('button', { class: 'btn primary', type: 'submit', text: 'Anular pago' })))));
  }
  function formAnonimizar(c) {
    const conf = h('input', { id: 'anC', autocomplete: 'off' }), err = h('p', { class: 'err', role: 'alert' });
    const d = dialogo('Anonimizar cliente', h('form', { novalidate: true, onsubmit: async e => {
      e.preventDefault(); if (conf.value !== 'ANONIMIZAR') return (err.textContent = 'Escribe ANONIMIZAR para confirmar.');
      try { await api.post(`/cartera/clientes/${c.id}/anonimizar`); d.close(); toast('Datos personales eliminados.'); ir('clientes'); } catch (x) { err.textContent = x.message; }
    } }, h('p', { text: 'Se borran el nombre, la cédula, el teléfono, el correo y las notas. El libro de pagos se conserva para la contabilidad. No se puede deshacer.' }),
    campo('anC', 'Escribe ANONIMIZAR', conf), err, h('div', { class: 'dlg-f' }, h('div'), h('div', {}, h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => d.close() }), h('button', { class: 'btn danger confirmando', type: 'submit', text: 'Anonimizar' })))));
  }
  async function formCliente(c) {
    const nuevo = !c;
    let asesores = [];
    if (admin) asesores = (await api.get('/cartera/asesores')).asesores;
    const t = (id, v, extra = {}) => h('input', { id, value: v ?? '', autocomplete: 'off', ...extra });
    const f = { nombre: t('cNom', c?.nombre, { maxlength: '120' }), cedula: t('cCed', nuevo ? '' : c.cedula, { inputmode: 'numeric' }), telefono: t('cTel', c?.telefono, { inputmode: 'tel' }), correo: t('cCor', c?.correo, { type: 'email' }),
      fecha_ingreso: h('input', { id: 'cFi', type: 'date', value: c?.fecha_ingreso || '' }), inicio_pagos: h('input', { id: 'cIp', type: 'date', value: c?.inicio_pagos || '' }),
      n_cuotas: numero('cNc', c?.n_cuotas || 1), sede: t('cSed', c?.sede, { maxlength: '80' }) };
    const dinero = [['deuda_declarada', 'Deuda declarada'], ['deuda_priorizada', 'Deuda priorizada (30%)'], ['cuota_mensual', 'Cuota mensual del proceso'], ['total_contrato', 'Total del contrato'], ['pago_centro', 'Pago centro de conciliación'],
      ['honorarios', 'Honorarios abogado'], ['bonificacion', 'Bonificación asesor'], ['gastos_admin', 'Gastos admin / notariales'], ['gastos_adq', 'Gastos adquisición']];
    dinero.forEach(([k]) => { f[k] = numero('c_' + k, c?.[k]); });
    const estado = h('select', { id: 'cEst' }, cfg.cartera.estados.map(e => h('option', { value: e, text: e })));
    estado.value = c?.estado_proceso || 'A. Inicio';
    const ases = admin ? h('select', { id: 'cAs' }, asesores.map(a => h('option', { value: a.id, text: a.nombre }))) : null;
    if (ases && c) ases.value = c.asesor_id;
    const notas = h('textarea', { id: 'cNot', maxlength: '2000' }); notas.value = c?.notas || '';
    const err = h('p', { class: 'err', role: 'alert' }), ok = h('button', { class: 'btn primary', type: 'submit', text: nuevo ? 'Crear cliente' : 'Guardar cambios' });
    const d = dialogo(nuevo ? 'Nuevo cliente' : `Editar · ${c.nombre}`, h('form', { novalidate: true, class: 'ct-form', onsubmit: async e => {
      e.preventDefault(); if (ok.disabled) return; err.textContent = ''; ok.disabled = true;
      const body = { nombre: f.nombre.value, cedula: f.cedula.value, telefono: f.telefono.value, correo: f.correo.value, notas: notas.value, estado_proceso: estado.value, fecha_ingreso: f.fecha_ingreso.value || null,
        inicio_pagos: f.inicio_pagos.value || null, n_cuotas: Number(f.n_cuotas.value || 1), sede: f.sede.value, ...Object.fromEntries(dinero.map(([k]) => [k, f[k].value || '0'])) };
      if (ases) body.asesor_id = ases.value;
      try { if (nuevo) { const r = await api.post('/cartera/clientes', body); d.close(); toast('Cliente creado.'); ir('ficha', r.cliente.id); } else { await api.patch(`/cartera/clientes/${c.id}`, { ...body, version: c.version }); d.close(); toast('Cambios guardados.'); vFicha(); } }
      catch (x) { if (x instanceof ApiError && x.status === 401) { d.close(); fallo(x); } else err.textContent = x.message; } finally { ok.disabled = false; }
    } },
    h('div', { class: 'ct-fgrid' }, campo('cNom', 'Nombre completo', f.nombre), campo('cCed', 'Cédula', f.cedula), campo('cTel', 'Teléfono', f.telefono), campo('cCor', 'Correo', f.correo),
      ases ? campo('cAs', 'Asesor', ases) : null, campo('cEst', 'Estado del proceso', estado), campo('cFi', 'Fecha de ingreso', f.fecha_ingreso), campo('cIp', 'Inicio de pagos', f.inicio_pagos),
      campo('cNc', 'N° de cuotas', f.n_cuotas), campo('cSed', 'Sede / entidad', f.sede), ...dinero.map(([k, t2]) => campo('c_' + k, t2 + ' (COP)', f[k]))),
    campo('cNot', 'Notas', notas), err, h('div', { class: 'dlg-f' }, h('div'), h('div', {}, h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: () => d.close() }), ok))));
  }

  /* ---------- Cobranza ---------- */
  async function vCobranza() {
    C.lista = (await api.get('/cartera/clientes')).clientes;
    const l = C.lista.filter(c => c.valor_en_mora > 0).sort((a, b) => b.dias_mora - a.dias_mora || b.valor_en_mora - a.valor_en_mora);
    const bk = [['1–30 días', c => c.dias_mora <= 30, ''], ['31–60 días', c => c.dias_mora > 30 && c.dias_mora <= 60, ''], ['61–90 días', c => c.dias_mora > 60 && c.dias_mora <= 90, 'bad'], ['Más de 90 días', c => c.dias_mora > 90, 'bad']];
    cont.replaceChildren(h('div', { class: 'ct-kpis' }, bk.map(([t, f, cl]) => { const x = l.filter(f); return kpi(t, pesos(x.reduce((a, c) => a + c.valor_en_mora, 0)), `${x.length} cliente(s)`, cl); })),
      h('div', { class: 'ct-tw' }, h('table', { class: 'ct-table' }, h('thead', {}, h('tr', {}, ['Cliente', 'Asesor', 'Cuotas en mora', 'Valor en mora', 'Días ≈', ''].map((t, i) => h('th', { class: i > 1 && i < 5 ? 'r' : '', scope: 'col', text: t })))),
        h('tbody', {}, l.length ? l.map(c => h('tr', {}, h('td', {}, h('button', { type: 'button', class: 'ct-link-t', text: c.nombre, onclick: () => ir('ficha', c.id) }), h('small', { class: 'mut', text: 'CC ' + c.cedula })), h('td', { text: c.asesor }),
          h('td', { class: 'r', text: String(c.cuotas_en_mora) }), h('td', { class: 'r neg', text: pesos(c.valor_en_mora) }), h('td', { class: 'r', text: String(c.dias_mora) }),
          h('td', {}, h('button', { type: 'button', class: 'btn sm', text: 'Abrir ficha', onclick: () => ir('ficha', c.id) })))) : [h('tr', {}, h('td', { colspan: 6, class: 'ct-vacio', text: 'No hay clientes en mora.' }))]))),
      h('p', { class: 'hint', text: 'Para proteger los datos, el teléfono y el WhatsApp aparecen solo dentro de la ficha del cliente.' }));
  }

  /* ---------- Flujo ---------- */
  async function vFlujo() {
    const { filas } = await api.get('/cartera/flujo');
    const tot = Array(12).fill(0); filas.forEach(f => f.meses.forEach((v, i) => { tot[i] += v; }));
    const mx = Math.max(1, ...filas.flatMap(f => f.meses));
    const celda = (v, nombre, mes) => { const td = h('td', { class: 'hm', title: `${nombre} · ${MES[mes]}: ${pesos(v)}`, text: v ? (v / 1e6).toFixed(1).replace('.', ',') : '' }); if (v) td.style.background = `color-mix(in srgb, var(--ct-s1) ${Math.round(15 + (v / mx) * 70)}%, transparent)`; return td; };
    cont.replaceChildren(h('p', { class: 'hint', text: 'Pagos recibidos por cliente y mes, en millones de pesos. Más oscuro = mayor valor.' }),
      h('div', { class: 'ct-tw' }, h('table', { class: 'ct-table heat' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Cliente' }), MES.map(m => h('th', { scope: 'col', class: 'c', text: m })), h('th', { scope: 'col', class: 'r', text: 'Total' }))),
        h('tbody', {}, filas.map(f => h('tr', {}, h('td', {}, h('button', { type: 'button', class: 'ct-link-t', text: f.nombre, onclick: () => ir('ficha', f.id) })), f.meses.map((v, i) => celda(v, f.nombre, i)), h('td', { class: 'r', text: pesos(f.total) }))),
          h('tr', { class: 'tot' }, h('td', { text: 'TOTAL' }), tot.map((v, i) => celda(v, 'Total', i)), h('td', { class: 'r', text: pesos(tot.reduce((a, b) => a + b, 0)) }))))));
  }

  /* ---------- Asesores ---------- */
  async function vAsesores() {
    const r = await api.get('/cartera/resumen');
    cont.replaceChildren(h('div', { class: 'ct-grid' }, r.por_asesor.map(a => h('section', { class: 'ct-card' }, h('h3', { text: a.nombre }),
      h('div', { class: 'ct-fg' }, fld('Clientes', String(a.clientes)), fld('Contratos', pesos(a.total_contrato)), fld('Recaudado', pesos(a.recibido)), fld('Saldo', pesos(a.saldo)), fld('En mora', pesos(a.valor_en_mora), a.valor_en_mora ? 'neg' : ''), fld('% recuperación', pct(a.recuperacion))),
      barra(a.recuperacion, 'big')))));
  }

  /* ---------- Importar (admin) ---------- */
  function vImportar() {
    const arch = h('input', { type: 'file', accept: '.csv,text/csv', id: 'imF', class: 'ct-input' }), sal = h('div', { class: 'ct-imp' });
    let csv = '';
    const aplicar = h('button', { type: 'button', class: 'btn primary', text: 'Aplicar importación', disabled: true });
    const parcial = h('input', { type: 'checkbox', id: 'imP' });
    const informe = r => {
      const ok = r.rechazos.length === 0;
      aplicar.disabled = !(ok || parcial.checked) || r.validas === 0; aplicar.hidden = false;
      sal.replaceChildren(
        h('div', { class: 'ct-kpis' }, kpi('Filas leídas', String(r.leidas)), kpi('Válidas', String(r.validas), '', 'ok'), kpi('Rechazadas', String(r.rechazos.length), '', r.rechazos.length ? 'bad' : ''), kpi('Ya existían', String(r.omitidas.length))),
        h('section', { class: 'ct-card' }, h('h3', { text: 'Conciliación con la hoja (compare estos totales con el PANEL FINANCIERO)' }), h('div', { class: 'ct-fg' }, fld('Clientes', String(r.conciliacion.clientes)), fld('Deuda declarada', pesos(r.conciliacion.deuda_declarada)), fld('Total a cobrar', pesos(r.conciliacion.total_contrato)),
          fld('Total recibido', pesos(r.conciliacion.recibido)), fld('Saldo por cobrar', pesos(r.conciliacion.saldo)), fld('Mora', pesos(r.conciliacion.valor_en_mora)))),
        r.rechazos.length ? h('section', { class: 'ct-card' }, h('h3', { text: 'Filas rechazadas (corríjalas en la hoja y repita la simulación)' }), h('ul', { class: 'ct-lista' }, r.rechazos.map(x => h('li', { text: `Fila ${x.fila}: ${x.motivo}` })))) : null,
        r.n_avisos ? h('section', { class: 'ct-card' }, h('h3', { text: `Avisos de calidad de datos (${r.n_avisos})` }), h('ul', { class: 'ct-lista' }, r.avisos.slice(0, 60).map(x => h('li', { text: `Fila ${x.fila}: ${x.aviso}` })))) : null,
        r.omitidas.length ? h('section', { class: 'ct-card' }, h('h3', { text: 'Omitidas (no se modifican)' }), h('ul', { class: 'ct-lista' }, r.omitidas.slice(0, 60).map(x => h('li', { text: `Fila ${x.fila}: ${x.motivo}` })))) : null,
        h('p', { class: 'hint', text: 'El informe no muestra nombres ni cédulas: solo el número de fila.' }));
    };
    const simular = guard(async () => { if (!csv) return toast('Elige un archivo CSV.'); informe(await api.post('/cartera/import?dry=1', { csv })); });
    arch.addEventListener('change', () => { const f = arch.files[0]; if (!f) return; if (f.size > 2_000_000) { toast('El archivo supera 2 MB.'); return; } const rd = new FileReader(); rd.onload = () => { csv = String(rd.result); simular(); }; rd.readAsText(f, 'utf-8'); });
    parcial.addEventListener('change', () => simular());
    aplicar.addEventListener('click', guard(async () => {
      aplicar.disabled = true;
      const r = await api.post('/cartera/import' + (parcial.checked ? '?parcial=1' : ''), { csv });
      toast(`Importación completa: ${r.creados} cliente(s) creados.`); informe(r);
    }));
    cont.replaceChildren(h('section', { class: 'ct-card' }, h('h3', { text: 'Migrar la matriz' }),
      h('ol', { class: 'ct-pasos' }, h('li', { text: 'Cree antes los usuarios asesores (Usuarios) con el mismo nombre que figura en la columna ASESOR.' }), h('li', { text: 'En Google Sheets: pestaña MATRIZ CLIENTES → Archivo → Descargar → CSV. Añada la cédula en la columna «NOMBRE CLIENTE / CÉDULA» (por ejemplo «María Pérez – 52123456») o en una columna CÉDULA.' }),
        h('li', { text: 'Suba el archivo: se SIMULA sin guardar nada. Corrija lo rechazado y repita hasta que no haya rechazos.' }), h('li', { text: 'Compare la conciliación con el PANEL FINANCIERO de la hoja y, si cuadra, aplique.' })),
      h('div', { class: 'field' }, h('label', { for: 'imF', text: 'Archivo CSV (máx. 2 MB)' }), arch),
      h('label', { class: 'ct-chk', for: 'imP' }, parcial, ' Permitir importación parcial (omite las filas rechazadas)'), h('div', { class: 'ct-acts' }, aplicar)), sal);
    aplicar.hidden = true;
  }

  /* ---------- Auditoría (admin) ---------- */
  async function vAuditoria() {
    const q = C.id ? `?entidad_id=${encodeURIComponent(C.id)}&limite=200` : '?limite=200';
    const { eventos } = await api.get('/cartera/auditoria' + q);
    const res = h('span', { class: 'ct-verif', role: 'status' });
    cont.replaceChildren(h('div', { class: 'ct-bar' }, h('button', { type: 'button', class: 'btn', text: 'Verificar integridad de la bitácora', onclick: guard(async () => { const v = await api.get('/cartera/auditoria/verificar'); res.className = `ct-verif ${v.ok ? 'ok' : 'bad'}`; res.textContent = v.ok ? `✔ Cadena íntegra (${v.filas} registros)` : `✖ Alteración detectada en el registro ${v.rotoEn}`; }) }), res,
      C.id ? h('button', { type: 'button', class: 'btn quiet', text: 'Ver toda la bitácora', onclick: () => ir('auditoria') }) : null),
      h('div', { class: 'ct-tw' }, h('table', { class: 'ct-table' }, h('thead', {}, h('tr', {}, ['Fecha', 'Usuario', 'Acción', 'Detalle', 'IP'].map(t => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, eventos.map(e => h('tr', {}, h('td', { text: new Date(e.at).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'medium' }) }), h('td', { text: e.actor }), h('td', { text: e.accion }), h('td', { class: 'mut', text: e.detalle }), h('td', { class: 'mut', text: e.ip })))))),
      h('p', { class: 'hint', text: 'La bitácora no guarda datos personales; identifica a los clientes por código interno.' }));
  }

  const PINTAR = { resumen: vResumen, clientes: vClientes, ficha: vFicha, cobranza: vCobranza, flujo: vFlujo, asesores: vAsesores, importar: vImportar, auditoria: vAuditoria };
  pintarNav();
  return { abrir: () => ir(C.vista, C.id), olvidar: () => { C.lista = []; C.resumen = null; C.revelar = false; cont.replaceChildren(); } };
}
