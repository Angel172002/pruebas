CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) BETWEEN 5 AND 120),
  nombre           TEXT NOT NULL CHECK (char_length(nombre) BETWEEN 1 AND 80),
  rol              TEXT NOT NULL CHECK (rol IN ('admin','miembro','lector')),
  area             TEXT,
  pass_hash        TEXT NOT NULL,
  must_change      BOOLEAN NOT NULL DEFAULT TRUE,
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  session_version  INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  last_login       TEXT,
  CHECK ((rol = 'admin' AND area IS NULL) OR (rol <> 'admin' AND area IS NOT NULL AND area <> 'Todos'))
);

CREATE TABLE login_attempts (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clave  TEXT NOT NULL,
  at_ms  BIGINT NOT NULL
);
CREATE INDEX idx_login_clave ON login_attempts(clave, at_ms);
