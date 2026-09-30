# Gestor Directivo – LIVA

Web app para gestionar **actividades** y **pagos** de la dirección con escalamiento automático por fecha
(Urgente / Prioritario / Importante), bandeja "Por confirmar" para lo extraído de reuniones, historial de cambios
y vínculo con issues de GitHub. Evolución del artifact original (`legacy/gestor-directivo-artifact.html`).

## Ejecutar

```bash
npm install
cp .env.example .env      # opcional; sin claves y fuera de producción corre en modo desarrollo (owner)
npm start                 # http://localhost:3000
npm test
```

Node 22+. Base de datos libSQL (compatible con SQLite): archivo local por defecto (`DB_PATH`) o Turso en la nube (`DATABASE_URL`). Migraciones automáticas en `migrations/`.

## Roles y seguridad

| Rol | Clave | Puede |
|---|---|---|
| owner | `OWNER_TOKEN` | Todo: pagos, Por confirmar, eliminar, importar/exportar, importar issues |
| editor | `EDITOR_TOKEN` | Crear/editar/cerrar actividades, vincular GitHub. No ve pagos ni propuestas |
| viewer | `VIEWER_TOKEN` | Solo lectura de actividades |

Los permisos se aplican **en el servidor**; los pagos nunca se envían a quien no es owner. Sesión en cookie
`HttpOnly; SameSite=Strict` firmada, cabecera anti-CSRF, CSP estricto, validación de esquema, dinero como entero (COP),
versión optimista contra ediciones concurrentes, y auditoría de cada cambio (incluso eliminaciones).
En producción `OWNER_TOKEN` es obligatorio.

## Reglas de negocio

- Fechas de negocio = `YYYY-MM-DD` en zona `America/Bogota` (sin desfases por DST/zona del navegador).
- Escalamiento **derivado**, no se sobrescribe la categoría: una tarea no urgente con ≤ 2 días (o vencida) se muestra en Urgente indicando el motivo.
- Prioritario e Importante no pueden quedar en Dirección General. Los pagos exigen fecha.
- Pago mensual: el siguiente se crea al marcar pagado, conservando el día ancla (31 ene → 28 feb → 31 mar) y de forma idempotente.

## Migrar desde el artifact

En **Datos y GitHub → Importar JSON** sube un archivo `{"tareas":[…],"pagos":[…]}` (la colección de `window.claude.db`).
Se muestra una vista previa con lo rechazado (p. ej. montos ambiguos como `1.500,50`) y repetirlo no duplica.

## GitHub

Configura en el servidor `GITHUB_TOKEN` (fine-grained PAT, solo los repos necesarios: Issues read/write, Pull requests read)
y `GITHUB_REPOS=dueño/repo,otro/repo` (lista permitida). Desde una actividad puedes **crear un issue**, **vincular** uno existente
y **actualizar su estado**; desde *Datos y GitHub* importas issues abiertos como propuestas. El token nunca llega al navegador.

## Desplegar en Vercel

Vercel es serverless (disco efímero), por eso en producción la base es **Turso** (libSQL, plan gratuito disponible).

1. **Base de datos**: crea una en [turso.tech](https://turso.tech) y obtén la URL y un token:
   `turso db create liva && turso db show liva --url && turso db tokens create liva`
2. **Importar el repo** en [vercel.com/new](https://vercel.com/new) (Framework: *Other*; no hay build). Rama de producción: `main`.
3. **Variables de entorno** (Project → Settings → Environment Variables):

   | Variable | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `libsql://…turso.io` |
   | `DATABASE_AUTH_TOKEN` | token de Turso |
   | `OWNER_TOKEN` | clave larga (≥ 12) |
   | `SESSION_SECRET` | aleatorio (≥ 16): `openssl rand -hex 32` |
   | `EDITOR_TOKEN`, `VIEWER_TOKEN` | opcionales |
   | `GITHUB_TOKEN`, `GITHUB_REPOS` | opcionales (ver GitHub) |
4. Despliega. Comprueba `https://<tu-app>.vercel.app/readyz`. Las migraciones se aplican solas en el primer arranque.

Notas: el límite de intentos de login es por instancia (en serverless es una protección básica; usa claves largas).
Los backups los gestiona Turso; guarda además copias con *Exportar JSON*.

## Otras opciones

- **Docker / Render / Fly.io**: `docker build -t liva . && docker run -p 3000:3000 -v liva-data:/data -e NODE_ENV=production -e OWNER_TOKEN=… -e SESSION_SECRET=… liva`.
  `render.yaml` incluye un Blueprint con disco persistente (plan de pago). Copias automáticas en `BACKUP_DIR` para bases locales.
- `/healthz` y `/readyz` para health checks. Logs JSON a stdout.

## Flujo de trabajo del repositorio

- `main` es la rama de producción (Vercel despliega cada push a `main` y crea *preview deployments* por PR).
- Cambios por Pull Request, con el CI en verde (`npm run check`, `npm test`, `npm audit`, build de Docker) y revisión.
- Commits descriptivos; Dependabot propone actualizaciones semanales.

## Estructura

```
api/         entrada serverless de Vercel
src/         server, app (rutas), store (lógica transaccional), domain (reglas), auth, portability, services/github
public/      frontend (módulos ES, sin build, sin innerHTML con datos)
migrations/  SQL versionado (tabla schema_migrations)
test/        node:test (API, roles, recurrencia, importación, GitHub simulado)
```

## Fuera de alcance por ahora

Recordatorios por correo/push, edición masiva, usuarios individuales con SSO/MFA (hoy: claves por rol), entidad Reunión propia,
adjuntos/comprobantes de pago.
