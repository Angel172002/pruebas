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

Node 22+. Base de datos **PostgreSQL**: en local usa PGlite (Postgres embebido, sin instalar nada, datos en `./data/pglite`); en producción, Neon u otro Postgres vía `DATABASE_URL`. Migraciones automáticas en `migrations/`.

## Acceso, roles y seguridad

Cada persona entra con **su propio correo y clave**. El administrador crea y gestiona al equipo en la pestaña **Usuarios**.

| Rol | Ve | Puede |
|---|---|---|
| **admin** | Todo: todas las direcciones, pagos, *Por confirmar*, usuarios, datos | Todo, incluido crear usuarios, restablecer claves, eliminar, importar/exportar |
| **miembro** | Solo el panel de **su dirección** (y lo marcado "Todos", en lectura) | Crear, editar y cerrar actividades de su dirección; vincular issues de GitHub |
| **lector** | Solo el panel de su dirección | Nada de escritura |

- Las reglas se aplican **en el servidor**: lo de otra dirección se comporta como si no existiera (404) y un miembro no puede crear ni mover tareas a otra dirección. Los pagos nunca se envían a quien no es admin.
- Claves con hash **scrypt**; la clave temporal que entrega el admin obliga a cambiarla en el primer ingreso; restablecer, desactivar o cambiar de dirección a un usuario **cierra sus sesiones** de inmediato.
- Bloqueo tras intentos fallidos (por correo y por IP, guardado en base de datos, vale entre instancias serverless). Mensajes de error genéricos.
- Sesión en cookie `HttpOnly; SameSite=Strict` firmada (12 h), cabecera anti-CSRF, CSP estricto, validación de esquema, dinero como entero (COP), versión optimista y auditoría con el **usuario real** de cada cambio.
- **Primer administrador**: se crea al arrancar con `ADMIN_EMAIL` y, como clave temporal, `OWNER_TOKEN` (debes cambiarla al entrar). `OWNER_TOKEN` no vuelve a usarse como clave de acceso.
- **Recuperación** si el admin pierde su clave: define `ADMIN_RECOVERY=true` (con `ADMIN_EMAIL` y `OWNER_TOKEN`), despliega, ingresa con `OWNER_TOKEN`, cambia la clave y **quita `ADMIN_RECOVERY`**.

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

## Desplegar en Vercel + Neon

Vercel es serverless (disco efímero), por eso en producción la base es **Neon** (Postgres gestionado, plan gratuito disponible).

1. **Importar el repo** en [vercel.com/new](https://vercel.com/new) (Framework: *Other*; no hay build). Rama de producción: `main`.
2. **Base de datos**: en el proyecto de Vercel → *Storage* → *Create Database* → **Neon** (Marketplace). Conéctala al proyecto:
   Vercel define `DATABASE_URL` automáticamente (usa la cadena *pooled*, con `-pooler`). Alternativa manual: crea el proyecto en
   [neon.tech](https://neon.tech) y copia la *Connection string* pooled.
3. **Variables de entorno** (Project → Settings → Environment Variables):

   | Variable | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | la pone la integración de Neon |
   | `ADMIN_EMAIL` | correo del administrador |
   | `OWNER_TOKEN` | clave **inicial** del admin (≥ 12); se te pedirá cambiarla al entrar |
   | `SESSION_SECRET` | aleatorio (≥ 16): `openssl rand -hex 32` |
   | `GITHUB_TOKEN`, `GITHUB_REPOS` | opcionales (ver GitHub) |
4. Despliega. Comprueba `https://<tu-app>.vercel.app/readyz`. Las migraciones se aplican solas en el primer arranque.

Respaldo: Neon ofrece restauración a un punto en el tiempo y *branches*; guarda además copias con *Exportar JSON*.
Usa un *branch* de Neon distinto para *preview deployments* si no quieres que los PR toquen los datos reales.

## Otras opciones

- **Docker / Render / Fly.io**: `docker build -t liva . && docker run -p 3000:3000 -e NODE_ENV=production -e DATABASE_URL=… -e ADMIN_EMAIL=… -e OWNER_TOKEN=… -e SESSION_SECRET=… liva`.
  `render.yaml` incluye un Blueprint (sin disco: la base es Neon).
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
test/        node:test (API, usuarios y aislamiento por dirección, recurrencia, importación, GitHub simulado); con `TEST_DATABASE_URL` corre contra Postgres real
```

## Fuera de alcance por ahora

Recordatorios por correo/push, edición masiva, SSO/MFA, autoservicio de "olvidé mi clave" por correo, entidad Reunión propia,
adjuntos/comprobantes de pago.
