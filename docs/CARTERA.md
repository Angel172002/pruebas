# Cartera · Matriz financiera de insolvencia

Módulo de la app LIVA que reemplaza la hoja `Matriz_Financiera_LeyInsolvencia_2026`. Reutiliza el login, los roles, las sesiones y la auditoría que ya tenía la app, y añade lo que exigen datos de deudores: cifrado de datos personales, permisos por asesor, bitácora inalterable, verificación en dos pasos y una migración que se **simula antes de escribir**.

> **Estado:** construido y probado con datos ficticios. **No hay datos reales cargados.** Antes de migrar, recorra la lista de salida a producción (sección 9).

---

## 1. Qué se ve en la app

| Sección | Para qué sirve | Quién |
|---|---|---|
| **Resumen** | Indicadores de la cartera, recaudo mensual (recibido vs. esperado), salud de la cartera, mayores moras | todos los que tienen acceso (cada uno ve lo suyo) |
| **Clientes** | Buscar por **cédula** o nombre, filtrar por asesor/alerta, ordenar, abrir la ficha | todos |
| **Ficha del cliente** | Cobros y saldos, calendario de cuotas, pagos del año, historial, proceso, costos, utilidad, avisos de calidad de datos, teléfono/WhatsApp | todos (según alcance) |
| **Cobranza** | Mora por antigüedad (1–30, 31–60, 61–90, +90) | todos |
| **Flujo anual** | Mapa de calor cliente × mes | todos |
| **Asesores** | Rendimiento por asesor | admin / acceso total |
| **Importar** | Migrar la matriz desde CSV con simulación y conciliación | admin |
| **Auditoría** | Quién vio/cambió qué, con verificación de integridad | admin |

## 2. Roles y alcance

Un solo punto decide qué ve cada persona (`alcance()` en `src/cartera.js`), usado por **todas** las consultas.

| Rol (app) | Acceso a cartera | Ve | Puede |
|---|---|---|---|
| admin | siempre `total` | Todo | Todo: crear, editar, reasignar, cerrar, anular pagos, anonimizar, exportar, importar, auditoría |
| miembro | `propia` (asesor) | Solo sus clientes | Crear clientes (se le asignan a él), editar, registrar pagos |
| miembro | `total` (coordinación) | Todos | Crear, editar, registrar pagos. No reasigna, no anula, no exporta |
| lector | `propia` / `total` | Su alcance | Solo lectura |
| cualquiera | `ninguno` (por defecto) | Nada (403) | — |

Lo que queda fuera del alcance de un usuario **se comporta como si no existiera** (404, no 403), y buscarlo por cédula no devuelve nada. El acceso a cartera es independiente del panel de actividades: **el mínimo por defecto es "ninguno"**. Cambiar el acceso de alguien cierra sus sesiones al instante.

## 3. Modelo de datos

```
users ──< clientes ──< pagos_cliente          audit_log (encadenada, solo agregar)
 (asesor_id)   │            │
               │            └ anulado_at/por/motivo (nunca se borra)
               └ pii (JSON CIFRADO): nombre, cédula, teléfono, correo, notas
                 cedula_idx (HMAC)  cedula_ult4
```

- **Cifrado de campos** (`src/crypto.js`): AES-256-GCM, IV aleatorio por valor, el id del cliente va como dato autenticado (un texto cifrado copiado a otra fila no descifra). La **cédula** se busca con un **índice ciego** (HMAC-SHA256 con clave derivada): permite encontrar y garantizar unicidad sin guardar la cédula en claro.
- **Dinero**: enteros en pesos (COP), sin decimales; el servidor rechaza decimales, negativos y notación científica.
- **Libro de pagos**: solo se agrega. Un error se corrige **anulando** (queda quién, cuándo y por qué). Un trigger de la base impide editar o borrar pagos aunque alguien tenga acceso directo.
- **Cálculos** (`src/cartera-domain.js`): no se digitan, se derivan de los pagos: recibido, saldo, % cumplimiento, cuotas esperadas/pagadas/en mora, valor y días de mora, fecha de finalización, utilidad esperada.

## 4. Controles de seguridad

| Amenaza | Control | Dónde | Prueba |
|---|---|---|---|
| Robo de la base de datos | Datos personales cifrados (AES-256-GCM); la clave solo vive en el entorno | `src/crypto.js` | `cifrado: la base no contiene nombre ni cédula en claro…` |
| Un asesor ve clientes ajenos (IDOR) | Alcance único en el acceso a datos; 404 fuera de alcance | `src/cartera.js` | `alcance: cada asesor solo ve y toca SUS clientes…` |
| Robo de contraseña | Verificación en dos pasos (TOTP), obligatoria para admin en producción; códigos de recuperación de un solo uso; anti-repetición | `src/totp.js`, `src/app.js` | `MFA: activar, iniciar sesión…`, vector RFC 6238 |
| Adivinar claves/códigos | Límite de intentos por correo+IP, correo e IP, guardado en base (vale entre instancias), registrado **antes** de verificar | `src/app.js` | `límite de intentos…` |
| Claves débiles | Mínimo 10, no comunes, no repetitivas, no contienen el correo; scrypt | `src/auth.js` | `política de claves…` |
| Alterar el historial | Bitácora **encadenada** (hash de la fila anterior) + trigger de solo-agregar; verificación en la app | `src/audit.js` | `la bitácora… su cadena se verifica (y detecta alteraciones)` |
| Fuga por la propia bitácora | La bitácora no guarda nombres, cédulas ni teléfonos (solo id interno) | `src/audit.js` | misma prueba (busca datos personales en todas las filas) |
| Pagos editados/borrados | Libro inmutable por trigger; anulación con motivo, solo admin | `migrations/003_cartera.sql` | `pagos: idempotencia… libro inmutable…` |
| Doble clic / reintentos | Clave de idempotencia por pago | `src/cartera.js` | misma prueba |
| Dos personas editan a la vez | Versión optimista (409) | `src/cartera.js` | `versión optimista…` |
| CSRF | Cookie `SameSite=Strict` + cabecera obligatoria en toda escritura | `src/auth.js` | `validación… CSRF` |
| XSS | CSP estricto (`script-src 'self'; style-src 'self'`), sin `innerHTML` con datos | `src/app.js`, `public/` | revisado en navegador: 0 violaciones de CSP |
| Inyección en el CSV exportado | Se neutralizan celdas que empiezan con `= + - @` | `src/cartera.js` | `exportación CSV…` |
| Fuga masiva por exportación | Solo admin, auditada | `src/cartera.js` | misma prueba |
| Importación que corrompe datos | Simulación sin escribir, informe **sin datos personales**, todo-o-nada, idempotente | `src/cartera-import.js` | `importación: …` (3 pruebas) |
| Derecho a la supresión | **Anonimizar**: borra datos personales y conserva el libro de pagos | `src/cartera.js` | `anonimizar…` |
| Pérdida de acceso del admin | `ADMIN_RECOVERY` (clave **y** 2FA) | `src/users.js` | `recuperación del admin…` |
| Datos reales en Git | `.gitignore` de CSV/Excel/claves + chequeo en CI | `scripts/verificar-sin-datos-reales.sh`, CI | CI |
| Cabeceras | HSTS, CSP, `X-Frame-Options`, `Permissions-Policy`, COOP/CORP, `no-store` en la API | `src/app.js`, `vercel.json` | `política de claves… cabeceras…` |

Las 46 pruebas pasan contra **PGlite y contra PostgreSQL 16 real** (`TEST_DATABASE_URL`), que es lo que corre el CI.

## 5. Riesgos que quedan (decisiones conscientes)

Un sistema "sin ninguna falencia" no existe; estos son los límites reales:

1. **Quien tenga la clave `DATA_KEY` y la base lo ve todo.** Guárdela solo en el gestor de secretos de la plataforma, nunca en el repositorio ni en chats. **Si pierde la clave, pierde los datos personales** (no hay forma de recuperarlos): haga copia de la clave en un sitio distinto al de la base.
2. **Un administrador con acceso directo a la base de datos** podría desactivar los triggers. La cadena de la bitácora detecta que se alteró el historial de auditoría, pero **no** protege el libro de pagos de alguien con privilegios de superusuario. Mitigación: pocas personas con acceso a Neon/Postgres, con 2FA en esa cuenta, y respaldos con retención.
3. **El rol de base de datos de la app también corre las migraciones** (puede crear/alterar tablas). Más adelante conviene separar un rol de migraciones de un rol de ejecución con permisos mínimos.
4. **La sesión dura 12 h** sin cierre por inactividad. Para datos de deudores puede preferir 8 h o menos (constante `MAX_AGE` en `src/auth.js`).
5. **No hay límite general de lectura por usuario.** Un asesor con la cuenta comprometida (y su 2FA) podría ir abriendo fichas de **sus** clientes; queda en la bitácora (`ver_cliente`), pero no se frena. Revise la bitácora periódicamente.
6. **Si dos personas se llaman igual** el importador rechaza al asesor como ambiguo (hay que distinguirlos).
7. **La existencia de una cédula se puede inferir** al intentar crearla (409 "ya existe"), aun si es de otro asesor; no se revela de quién es.
8. **El segundo factor se configura con la clave de texto** (no hay código QR, para no añadir librerías). Funciona con cualquier app de autenticación.
9. **No hay recordatorios automáticos** de cobro (correo/WhatsApp) ni "olvidé mi clave" por correo: el admin restablece.

## 6. Hallazgos de la matriz actual

Con las 3 filas de muestra y el panel que pude leer de la hoja (no vi las 21), esto es lo que debe confirmar antes de migrar:

1. **La cédula no tiene columna propia**: el encabezado dice «NOMBRE CLIENTE / CÉDULA» pero las filas traen solo el nombre. Sin cédula no se puede buscar por cédula: el importador rechaza esas filas.
2. **«INGRESO NETO FIRMA» parece tener el signo invertido.** Con los 3 casos, la hoja calcula `pago centro − (contrato − honorarios − bonificación − gastos)` = −6.575.000 / −6.575.000 / −7.099.142. Lo esperable es `contrato − costos − pago centro` = **+6.575.000 / +6.575.000 / +7.099.142**. Si el patrón se repite en las 21 filas, el −$183.698.284 del panel sería en realidad ≈ +$183,7 M. La app usa la versión positiva (`utilidad_esperada`). **Confírmelo con quien creó la fórmula.**
3. **Cuota × n.° de cuotas ≠ total del contrato** en las 3 filas (p. ej. 1.230.000 × 6 = 7.380.000 vs. 11.000.000). La app guarda ambos y avisa en la ficha. Aclare qué es cada cosa: ¿el contrato incluye honorarios y gastos además de las cuotas?
4. **% de cumplimiento distinto en dos hojas** con el mismo dinero recibido: MATRIZ 33,0 % y 13,6 % vs. FLUJO 24,6 % y 7,1 %. Una de las dos usa otra base.
5. **«% recuperación promedio» (22,2 %)** es un promedio de porcentajes; el ponderado es 59,93 M / 280,7 M = **21,3 %**. La app muestra el ponderado.
6. **Reglas de mora de la hoja** (la app las replica para que la conciliación cuadre): cuotas pagadas = ⌊recibido ÷ cuota⌋; mora = esperadas − pagadas; días de mora ≈ 30 × cuotas en mora (no son días reales; la app guarda además `dias_reales`); fecha de finalización = inicio + n meses (un mes después de la última cuota). **¿El "total recibido" incluye honorarios/anticipos que no son cuotas del proceso?** Si sí, la mora está subestimada.
7. **Datos faltantes**: fecha de ingreso vacía (clientes 002 y 003), sede vacía (003).
8. **FLUJO guarda los pagos acumulados en un solo mes** (p. ej. 3.630.000 en marzo), así que no existe la fecha real de cada pago: se migra como **un asiento «migración»** y desde ahí cada pago nuevo se registra con su fecha.
9. **TABLA DE ABONOS** duplica pagos y mezcla gastos de viajes a Tunja: la app la reemplaza por el libro de pagos; los gastos de viaje quedan como módulo aparte si los necesita.

## 7. Plan de migración (con datos reales)

Haga todos los ensayos en un entorno **de prueba** (otra base de datos Neon) antes de tocar producción.

1. **Cierre las preguntas de la sección 6** (sobre todo 2, 3 y 6).
2. **Crear usuarios**: en *Usuarios*, un usuario por asesor, **con el mismo nombre** que figura en la columna ASESOR, con `acceso a cartera = solo sus clientes`. Cada uno activa su 2FA.
3. **Preparar el CSV** (en Google Sheets, pestaña *MATRIZ CLIENTES* → Archivo → Descargar → CSV). Agregue la cédula en «NOMBRE CLIENTE / CÉDULA» (p. ej. `María Pérez – 52123456`) o en una columna `CÉDULA`. **No suba ese CSV a Git, correo ni chats**: bórrelo al terminar.
4. **Simular** (*Cartera → Importar*): el informe no muestra datos personales, solo fila y motivo. Corrija la hoja y repita hasta que **no haya rechazos**. Revise los avisos de calidad.
5. **Conciliar**: compare los totales del informe con el PANEL FINANCIERO de la hoja (clientes activos, total a cobrar, total recibido, saldo, mora). **Deben coincidir** (salvo diferencias que ya explicó en la sección 6).
6. **Aplicar**. Es transaccional (todo o nada) e idempotente: repetirlo no duplica.
7. **Verificar a mano** 5 clientes al azar contra la hoja (ficha vs. fila).
8. **Congelar la hoja** (solo lectura) y fijar una fecha de corte. A partir de ahí, solo la app.
9. **Guardar** la clave `DATA_KEY` y probar una restauración de respaldo.

## 8. Operación

- **Claves**: `DATA_KEY` (32 bytes). Rotación: `scripts/rotar-claves.js` (pase la clave vieja a `DATA_KEY_PREV`, la nueva a `DATA_KEY`, ejecute el script, luego quite `DATA_KEY_PREV`).
- **Respaldos**: Neon (restauración a un punto en el tiempo). Pruebe restaurar. El respaldo está cifrado en los campos personales, pero **sin `DATA_KEY` no sirve**.
- **Perdí el teléfono (2FA)**: el admin usa «Quitar 2FA» en *Usuarios*; el usuario vuelve a activarla. Si es el único admin: `ADMIN_RECOVERY=true` + un `OWNER_TOKEN` nuevo restablece clave **y** 2FA (una vez por valor).
- **Revisión periódica**: *Cartera → Auditoría*, «Verificar integridad». Mire accesos fuera de horario, exportaciones y muchos `ver_cliente` seguidos.
- **Salida de una persona**: desactivarla en *Usuarios* (cierra su sesión) y, si tenía acceso total o exportaba, considere rotar `DATA_KEY`.

## 9. Lista de salida a producción

- [ ] Preguntas de la sección 6 respondidas por escrito.
- [ ] `NODE_ENV=production`, `DATABASE_URL` (Neon, rama de producción), `ADMIN_EMAIL`, `OWNER_TOKEN` (≥ 12), `SESSION_SECRET` (aleatorio), **`DATA_KEY`** (aleatoria, con copia en gestor de secretos), `MFA_REQUIRED=admin` (o `all`).
- [ ] Variables **distintas** para *preview deployments* (otra base): que ningún PR toque datos reales.
- [ ] El admin cambió la clave temporal y activó el 2FA.
- [ ] Cuenta de Vercel/Neon/GitHub con 2FA y pocas personas.
- [ ] CI en verde (`npm test` contra PostgreSQL, `npm audit`, chequeo de datos en Git).
- [ ] Ensayo de migración completo en entorno de prueba y conciliación firmada.
- [ ] Prueba de restauración de respaldo.
- [ ] Revisión legal del tratamiento de datos personales: en Colombia aplica la **Ley 1581 de 2012** (autorización del titular, finalidad, seguridad, derecho a conocer, actualizar y suprimir; y, según el caso, registro de bases de datos). **Consúltelo con su abogado**; esta documentación no es asesoría legal.
- [ ] Política interna: quién puede ver qué, y qué hacer ante una sospecha de fuga (cambiar claves, rotar `DATA_KEY`, revisar la bitácora, avisar).
