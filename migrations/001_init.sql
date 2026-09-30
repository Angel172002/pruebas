CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  tipo          TEXT NOT NULL CHECK (tipo IN ('actividad','pago')),
  titulo        TEXT NOT NULL CHECK (char_length(titulo) BETWEEN 1 AND 160),
  categoria     TEXT NOT NULL CHECK (categoria IN ('urgente','prioritario','importante')),
  area          TEXT NOT NULL,
  responsable   TEXT NOT NULL DEFAULT '',
  fecha_limite  TEXT CHECK (fecha_limite IS NULL OR fecha_limite ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  estado        TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('propuesta','pendiente','cerrada','descartada')),
  cerrada_at    TEXT,
  origen        TEXT NOT NULL DEFAULT '',
  notas         TEXT NOT NULL DEFAULT '',
  monto         BIGINT CHECK (monto IS NULL OR monto >= 0),
  serie_id      TEXT,
  periodo       TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (tipo = 'pago' OR monto IS NULL)
);
CREATE INDEX idx_tasks_estado_fecha ON tasks(estado, fecha_limite);
CREATE INDEX idx_tasks_area ON tasks(area, estado);
CREATE INDEX idx_tasks_origen ON tasks(origen);
CREATE UNIQUE INDEX idx_tasks_serie_periodo ON tasks(serie_id, periodo) WHERE serie_id IS NOT NULL;

CREATE TABLE series (
  id          TEXT PRIMARY KEY,
  frecuencia  TEXT NOT NULL CHECK (frecuencia IN ('mensual')),
  dia_ancla   INTEGER NOT NULL CHECK (dia_ancla BETWEEN 1 AND 31),
  fin_fecha   TEXT
);

CREATE TABLE task_events (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id  TEXT NOT NULL,
  actor    TEXT NOT NULL,
  accion   TEXT NOT NULL,
  detalle  TEXT NOT NULL DEFAULT '',
  at       TEXT NOT NULL
);
CREATE INDEX idx_events_task ON task_events(task_id, id);

CREATE TABLE github_links (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo      TEXT NOT NULL,
  tipo      TEXT NOT NULL CHECK (tipo IN ('issue','pr')),
  numero    INTEGER NOT NULL,
  titulo    TEXT NOT NULL DEFAULT '',
  url       TEXT NOT NULL,
  estado    TEXT NOT NULL DEFAULT 'open',
  synced_at TEXT NOT NULL,
  UNIQUE (repo, tipo, numero)
);
CREATE INDEX idx_links_task ON github_links(task_id);
