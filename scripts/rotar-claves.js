// Re-cifra los datos personales de la cartera con la clave vigente.
//   1) Genera una clave nueva:            openssl rand -hex 32
//   2) Pasa la actual a DATA_KEY_PREV y pon la nueva en DATA_KEY
//   3) node scripts/rotar-claves.js       (con DATABASE_URL, DATA_KEY y DATA_KEY_PREV en el entorno)
//   4) Cuando termine, quita DATA_KEY_PREV. NO borres la clave antigua de tu gestor de secretos hasta verificar la app.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { crearCifrador } from '../src/crypto.js';
import { crearAuditoria } from '../src/audit.js';
import { crearCartera } from '../src/cartera.js';

const cfg = loadConfig();
if (!cfg.dataKeyPrev) { console.error('Falta DATA_KEY_PREV (la clave anterior). Nada que rotar.'); process.exit(1); }
const db = await openDb({ url: cfg.dbUrl });
const auditoria = crearAuditoria(db);
const cartera = crearCartera({ db, cifrador: crearCifrador({ dataKey: cfg.dataKey, dataKeyPrev: cfg.dataKeyPrev }), auditoria });
const n = await cartera.rotarClaves();
await auditoria.registrar({ actor: 'sistema', accion: 'rotar_claves', entidad: 'cliente', detalle: `${n} registros re-cifrados` });
console.log(`Listo: ${n} registros re-cifrados con la clave vigente.`);
await db.close();
