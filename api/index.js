// Entrada serverless de Vercel. La base (Turso/libSQL) se abre y migra una sola vez por instancia.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { crearApp } from '../src/app.js';

let app;
async function iniciar() {
  const cfg = loadConfig();
  return crearApp({ cfg, db: await openDb({ url: cfg.dbUrl, authToken: cfg.dbAuthToken }) });
}
let cargando;
export default async function handler(req, res) {
  try {
    cargando ??= iniciar();
    app = await cargando;
  } catch (e) {
    cargando = undefined;
    console.error(JSON.stringify({ level: 'error', msg: 'arranque falló: ' + e.message }));
    res.statusCode = 503; res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'El servicio no está configurado correctamente. Revisa las variables de entorno.' }));
  }
  return app(req, res);
}
