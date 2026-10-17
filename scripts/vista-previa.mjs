// Genera una vista previa interactiva de la interfaz de Cartera, en UN solo archivo HTML, con datos de prueba FICTICIOS.
// Usa el motor real (cálculos, permisos por asesor) para producir los datos; el HTML resultante no necesita servidor.
//   node scripts/vista-previa.mjs [salida.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { crearApp } from '../src/app.js';
import { sembrarAdmin } from '../src/users.js';
import { ESTADOS_PROCESO } from '../src/cartera-domain.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = process.argv[2] || 'vista-previa.html';
const cfg = loadConfig({ OWNER_TOKEN: 'inicial-segura-123', ADMIN_EMAIL: 'admin@demo.co', SESSION_SECRET: 'vista-previa-secret-123', DATA_KEY: 'ab'.repeat(32) });
const db = await openDb({ url: 'pglite:memory' });
await sembrarAdmin(db, cfg);
const server = crearApp({ cfg, db }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const H = { 'content-type': 'application/json', 'x-requested-with': 'liva' };
const call = (c, m, p, b) => fetch(base + p, { method: m, headers: { ...H, ...(c ? { cookie: c } : {}) }, body: b ? JSON.stringify(b) : undefined });
const ck = r => r.headers.get('set-cookie').split(';')[0];
async function activar(email, temp, nueva) { const r = await call(null, 'POST', '/api/login', { email, password: temp }); return ck(await call(ck(r), 'POST', '/api/me/password', { actual: temp, nueva })); }
const PASS = 'Clave-demo-segura-9';
const admin = await activar('admin@demo.co', 'inicial-segura-123', PASS);

const ases = {}, sesiones = { admin };
for (const [k, n] of [['a1', 'Laura Méndez'], ['a2', 'Carlos Rojas'], ['a3', 'Diana Pardo']]) {
  const r = await (await call(admin, 'POST', '/api/users', { email: `${k}@demo.co`, nombre: n, rol: 'miembro', area: 'Dirección Comercial', acceso_cartera: 'propia' })).json();
  ases[k] = r.usuario.id; sesiones[k] = await activar(`${k}@demo.co`, r.temporal, PASS);
}
// Clientes de prueba (ficticios). "Hoy" es la fecha real; los vencimientos se calculan respecto a hoy.
const hoy = new Date(), iso = d => d.toISOString().slice(0, 10);
const mesesAtras = (n, dia) => new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - n, dia));
const DEMO = [
  ['Marta Quintero', 'a1', 6, 1230000, 11000000, 5, 'ok'], ['Julián Cárdenas', 'a2', 5, 1760000, 11000000, 5, 'gravisimo'], ['Sofía Beltrán', 'a2', 15, 860000, 15000000, 4, 'nada'],
  ['Andrés Pineda', 'a3', 8, 900000, 9000000, 4, 'adelantado'], ['Luisa Moreno', 'a3', 10, 1100000, 12000000, 4, 'una'], ['Hernán Acosta', 'a1', 6, 700000, 7500000, 3, 'ok'],
  ['Paola Rincón', 'a1', 12, 950000, 13000000, 4, 'dos'], ['Camilo Vargas', 'a2', 5, 1100000, 5500000, 6, 'completo'], ['Daniela Ortiz', 'a3', 12, 1000000, 14000000, 4, 'ok'],
  ['Fabián Suárez', 'a1', 6, 800000, 6200000, 4, 'nada'], ['Natalia Gómez', 'a2', 10, 1250000, 14000000, 2, 'ok'], ['Ricardo Peña', 'a3', 5, 520000, 6000000, 1, 'ok']];
const cedulas = {};
for (const [i, [nombre, a, n, cuota, contrato, atras, perfil]] of DEMO.entries()) {
  const ini = mesesAtras(atras - 1, 15), ced = String(52100000 + i * 137311);
  const r = await call(admin, 'POST', '/api/cartera/clientes', { nombre, cedula: ced, telefono: '3' + String(105000000 + i * 3711111).slice(0, 9), asesor_id: ases[a], estado_proceso: ESTADOS_PROCESO[i % 3],
    fecha_ingreso: iso(mesesAtras(atras + 3, 5)), inicio_pagos: iso(ini), deuda_declarada: Math.round((45 + i * 17) * 1e6), deuda_priorizada: Math.round((45 + i * 17) * 3e5), n_cuotas: n, cuota_mensual: cuota, total_contrato: contrato,
    pago_centro: [2225000, 3000000, 5000000][i % 3], honorarios: 1200000, bonificacion: 300000, gastos_admin: 200000, gastos_adq: 500000, sede: ['Sede Centro', 'Sede Norte', 'Sede Sur'][i % 3] });
  const c = (await r.json()).cliente; cedulas[c.id] = ced;
  const pagar = k => call(admin, 'POST', `/api/cartera/clientes/${c.id}/pagos`, { valor: String(cuota), fecha: iso(new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth() + k, 15))) < iso(hoy) ? iso(new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth() + k, 15))) : iso(hoy), concepto: 'cuota' });
  const veces = { ok: atras, gravisimo: 0, nada: 0, adelantado: atras + 1, una: Math.max(0, atras - 1), dos: Math.max(0, atras - 2), completo: n }[perfil];
  if (perfil === 'gravisimo') await call(admin, 'POST', `/api/cartera/clientes/${c.id}/pagos`, { valor: '1500000', fecha: iso(mesesAtras(atras + 2, 10)), concepto: 'anticipo' });
  for (let k = 0; k < Math.min(veces, n); k++) await pagar(k);
}

const snap = async cookie => {
  const get = async p => (await call(cookie, 'GET', p)).json();
  const lista = (await get('/api/cartera/clientes')).clientes, det = {};
  for (const c of lista) det[c.id] = (await get(`/api/cartera/clientes/${c.id}`)).cliente;
  return { sesion: await get('/api/session'), resumen: await get('/api/cartera/resumen'), clientes: lista, detalle: det, flujo: await get('/api/cartera/flujo'),
    ...(cookie === admin ? { asesores: await get('/api/cartera/asesores'), auditoria: await get('/api/cartera/auditoria?limite=60'), integridad: await get('/api/cartera/auditoria/verificar') } : {}) };
};
const DATOS = { admin: await snap(admin), laura: await snap(sesiones.a1) };
server.close(); await db.close();

// Una sola página: se incrusta la interfaz real (public/cartera.js + cartera.css) con una API simulada de solo lectura.
const css = readFileSync(join(RAIZ, 'public/cartera.css'), 'utf8').replace(/@font-face\{[^}]*\}/, '');
let js = readFileSync(join(RAIZ, 'public/cartera.js'), 'utf8').replace(/^import .*api\.js';\n/m, '').replace('export function montarCartera', 'function montarCartera');
const html = `<title>Cartera Demo</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap">
<style>
:root{--pbg:#f4f6f4;--pcard:#fff;--pink:#12201c;--pink2:#4b5b56;--pline:#e3e8e5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--pbg:#0d1412;--pcard:#141d1a;--pink:#e8efec;--pink2:#a4b4af;--pline:#233029;color-scheme:dark}}
:root[data-theme="dark"]{--pbg:#0d1412;--pcard:#141d1a;--pink:#e8efec;--pink2:#a4b4af;--pline:#233029;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--pbg);color:var(--pink);font-family:"Manrope",system-ui,sans-serif;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:0 24px}
.top{max-width:1240px;margin:0 auto;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:space-between;padding:16px 0 18px;border-bottom:1px solid var(--pline);margin-bottom:22px}
.top b{font-size:17px;letter-spacing:-.01em}.top small{display:block;color:var(--pink2);font-size:13px;margin-top:2px}
.top label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--pink2);font-weight:600}
.top select{font:inherit;font-weight:600;color:var(--pink);background:var(--pcard);border:1px solid var(--pline);border-radius:10px;min-height:42px;padding:0 12px}
#raiz{max-width:1240px;margin:0 auto}
#toasts{position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:90;display:grid;gap:8px}
.toast{background:#12201c;color:#fff;border-radius:12px;padding:12px 18px;font-weight:600;font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.3);max-width:86vw}
${css}
</style>
<div class="top"><div><b>Cartera · vista previa</b><small>Datos de prueba, ficticios. Es solo para ver el diseño: no se guarda nada.</small></div>
<label>Ver como<select id="rol" aria-label="Ver la cartera según el rol"><option value="admin">Administración (ve toda la cartera)</option><option value="laura">Laura Méndez · asesora (solo sus clientes)</option></select></label></div>
<div id="raiz"></div><div id="toasts" role="status" aria-live="polite"></div>
<script type="module">
const DATOS = ${JSON.stringify(DATOS).replace(/</g, '\\u003c')};
const CED = ${JSON.stringify(cedulas)};
class ApiError extends Error { constructor(m, status, code) { super(m); this.status = status; this.code = code; } }
let ROL = 'admin';
const api = {
  async get(p) {
    const D = DATOS[ROL], [ruta, qs] = p.split('?'), q = new URLSearchParams(qs || '');
    if (ruta === '/cartera/resumen') return D.resumen;
    if (ruta === '/cartera/flujo') return D.flujo;
    if (ruta === '/cartera/asesores') return D.asesores;
    if (ruta === '/cartera/auditoria') return D.auditoria;
    if (ruta === '/cartera/auditoria/verificar') return D.integridad;
    if (ruta === '/cartera/clientes') { const t = (q.get('q') || '').toLowerCase(), d = t.replace(/\\D/g, '');
      return { clientes: !t ? D.clientes : D.clientes.filter(c => c.nombre.toLowerCase().includes(t) || (d.length >= 4 && (CED[c.id] || '').includes(d))) }; }
    const m = /^\\/cartera\\/clientes\\/([\\w-]+)$/.exec(ruta); if (m && D.detalle[m[1]]) return { cliente: D.detalle[m[1]] };
    throw new ApiError('No existe.', 404);
  },
  async post() { throw new ApiError('Esto es una vista previa: los cambios no se guardan. En la aplicación real el pago quedaría registrado.', 403); },
  async patch() { return api.post(); }, async del() { return api.post(); }
};
${js}
const toast = t => { const e = document.createElement('div'); e.className = 'toast'; e.textContent = t; document.getElementById('toasts').append(e); setTimeout(() => e.remove(), 4500); };
const montar = () => {
  const s = DATOS[ROL].sesion, u = s.user;
  const m = montarCartera(document.getElementById('raiz'), { user: u, cfg: s, toast, fallo: e => toast(e.message || 'No se pudo completar la acción.') });
  m.abrir();
};
document.getElementById('rol').addEventListener('change', e => { ROL = e.target.value; montar(); });
montar();
</script>`;
writeFileSync(SALIDA, html);
console.log(`Vista previa escrita en ${SALIDA} (${(html.length / 1024).toFixed(0)} KB)`);
