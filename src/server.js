import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { crearApp, hacerBackup } from './app.js';

const cfg = loadConfig();
const db = await openDb({ url: cfg.dbUrl, authToken: cfg.dbAuthToken });
const app = crearApp({ cfg, db });
const server = app.listen(cfg.port, () => console.log(JSON.stringify({ level: 'info', msg: `LIVA escuchando en :${cfg.port}` })));

let timer;
if (cfg.backupDir && db.local) {
  const run = () => hacerBackup(db, cfg.backupDir, cfg.backupKeep).catch(e => console.error(JSON.stringify({ level: 'error', msg: 'backup falló: ' + e.message })));
  run(); timer = setInterval(run, cfg.backupEveryHours * 3600000);
}
const cerrar = () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 8000).unref(); };
process.on('SIGTERM', cerrar); process.on('SIGINT', cerrar);
