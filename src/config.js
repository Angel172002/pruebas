import { randomBytes } from 'node:crypto';

export const AREAS_INTERNAS = ['Dirección General', 'Dirección Comercial', 'Dirección Tecnológica', 'Dirección Jurídica'];
export const AREAS_EXTERNAS = ['Dirección FIVA (Datos)', 'Dirección SEMAFORA (Trafficker)'];
export const TODOS = 'Todos';
export const AREAS = [TODOS, ...AREAS_INTERNAS, ...AREAS_EXTERNAS];
export const GENERAL = 'Dirección General';
export const CATEGORIAS = ['urgente', 'prioritario', 'importante'];
export const ESCALA_DIAS = 2;
export const TZ = 'America/Bogota';

// Alias de nombres antiguos del artifact original → nombre vigente.
export const AREA_ALIAS = {
  General: 'Dirección General', Legal: 'Dirección Jurídica', Jurídico: 'Dirección Jurídica',
  Programación: 'Dirección Tecnológica', Tecnológico: 'Dirección Tecnológica',
  Estratégica: 'Dirección Comercial', Comercial: 'Dirección Comercial',
  SEMAFORA: 'Dirección SEMAFORA (Trafficker)', 'SEMAFORA (Trafficker)': 'Dirección SEMAFORA (Trafficker)',
  'FIVA (Datos)': 'Dirección FIVA (Datos)'
};

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const ownerToken = env.OWNER_TOKEN || '';
  if (prod && ownerToken.length < 12) {
    throw new Error('OWNER_TOKEN es obligatorio en producción (mínimo 12 caracteres).');
  }
  return {
    prod,
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || './data/app.db',
    ownerToken,
    editorToken: env.EDITOR_TOKEN || '',
    viewerToken: env.VIEWER_TOKEN || '',
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    githubToken: env.GITHUB_TOKEN || '',
    githubRepos: (env.GITHUB_REPOS || '').split(',').map(s => s.trim()).filter(Boolean),
    backupDir: env.BACKUP_DIR || '',
    backupEveryHours: Number(env.BACKUP_EVERY_HOURS || 24),
    backupKeep: Number(env.BACKUP_KEEP || 7)
  };
}
