import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { crearApp } from './app.js';
import { sembrarAdmin } from './users.js';

const cfg = loadConfig();
const db = await openDb({ url: cfg.dbUrl });
await sembrarAdmin(db, cfg);
const app = crearApp({ cfg, db });
const server = app.listen(cfg.port, () => console.log(JSON.stringify({ level: 'info', msg: `LIVA escuchando en :${cfg.port}` })));

const cerrar = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 8000).unref(); };
process.on('SIGTERM', cerrar); process.on('SIGINT', cerrar);
