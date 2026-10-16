-- Cartera (matriz financiera de insolvencia). Datos personales cifrados en la app (ver src/crypto.js).

ALTER TABLE users ADD COLUMN acceso_cartera TEXT NOT NULL DEFAULT 'ninguno' CHECK (acceso_cartera IN ('ninguno','propia','total'));

CREATE TABLE clientes (
  id                TEXT PRIMARY KEY,
  numero            INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,
  pii               TEXT NOT NULL,                       -- JSON cifrado: nombre, cédula, teléfono, correo, notas
  cedula_idx        TEXT NOT NULL UNIQUE,                -- HMAC de la cédula (búsqueda exacta y unicidad)
  cedula_ult4       TEXT NOT NULL DEFAULT '',
  asesor_id         TEXT NOT NULL REFERENCES users(id),
  estado_proceso    TEXT NOT NULL DEFAULT 'A. Inicio',
  fecha_ingreso     TEXT CHECK (fecha_ingreso IS NULL OR fecha_ingreso ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  inicio_pagos      TEXT CHECK (inicio_pagos IS NULL OR inicio_pagos ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  deuda_declarada   BIGINT NOT NULL DEFAULT 0 CHECK (deuda_declarada >= 0),
  deuda_priorizada  BIGINT NOT NULL DEFAULT 0 CHECK (deuda_priorizada >= 0),
  n_cuotas          INTEGER NOT NULL DEFAULT 1 CHECK (n_cuotas BETWEEN 1 AND 120),
  cuota_mensual     BIGINT NOT NULL DEFAULT 0 CHECK (cuota_mensual >= 0),
  total_contrato    BIGINT NOT NULL DEFAULT 0 CHECK (total_contrato >= 0),
  pago_centro       BIGINT NOT NULL DEFAULT 0 CHECK (pago_centro >= 0),
  sede              TEXT NOT NULL DEFAULT '',
  honorarios        BIGINT NOT NULL DEFAULT 0 CHECK (honorarios >= 0),
  bonificacion      BIGINT NOT NULL DEFAULT 0 CHECK (bonificacion >= 0),
  gastos_admin      BIGINT NOT NULL DEFAULT 0 CHECK (gastos_admin >= 0),
  gastos_adq        BIGINT NOT NULL DEFAULT 0 CHECK (gastos_adq >= 0),
  estado            TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','cerrado','anonimizado')),
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_clientes_asesor ON clientes(asesor_id, estado);

-- Libro de pagos: solo se agrega; un error se corrige ANULANDO (queda rastro), nunca borrando.
CREATE TABLE pagos_cliente (
  id             TEXT PRIMARY KEY,
  cliente_id     TEXT NOT NULL REFERENCES clientes(id),
  fecha          TEXT NOT NULL CHECK (fecha ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  valor          BIGINT NOT NULL CHECK (valor > 0),
  concepto       TEXT NOT NULL CHECK (concepto IN ('anticipo','cuota','honorarios','migracion','otro')),
  nota           TEXT NOT NULL DEFAULT '',
  idem           TEXT UNIQUE,                            -- evita doble envío del mismo pago
  registrado_por TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  anulado_at     TEXT,
  anulado_por    TEXT,
  motivo_anulacion TEXT,
  CHECK ((anulado_at IS NULL) = (anulado_por IS NULL))
);
CREATE INDEX idx_pagos_cliente ON pagos_cliente(cliente_id, fecha);

CREATE FUNCTION pagos_inmutables() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Los pagos no se borran; se anulan.'; END IF;
  IF NEW.id <> OLD.id OR NEW.cliente_id <> OLD.cliente_id OR NEW.fecha <> OLD.fecha OR NEW.valor <> OLD.valor
     OR NEW.concepto <> OLD.concepto OR NEW.registrado_por <> OLD.registrado_por OR NEW.created_at <> OLD.created_at
     OR (OLD.anulado_at IS NOT NULL AND NEW.anulado_at IS DISTINCT FROM OLD.anulado_at) THEN
    RAISE EXCEPTION 'Un pago registrado no se puede modificar; solo anular.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pagos_inmutables BEFORE UPDATE OR DELETE ON pagos_cliente FOR EACH ROW EXECUTE FUNCTION pagos_inmutables();

-- Bitácora de auditoría encadenada (cada fila incluye el hash de la anterior): cualquier alteración se detecta.
CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TEXT NOT NULL,
  actor_id    TEXT,
  actor       TEXT NOT NULL,
  accion      TEXT NOT NULL,
  entidad     TEXT NOT NULL DEFAULT '',
  entidad_id  TEXT NOT NULL DEFAULT '',
  detalle     TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX idx_audit_entidad ON audit_log(entidad, entidad_id, id);
CREATE INDEX idx_audit_actor ON audit_log(actor, id);

CREATE FUNCTION audit_inmutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'La bitácora de auditoría no se modifica ni se borra.'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_inmutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_inmutable();
