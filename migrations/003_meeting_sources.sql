-- Notas de reuniones ya procesadas (evita duplicar propuestas al volver a pegar las mismas notas).
CREATE TABLE meeting_sources (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hash        TEXT NOT NULL UNIQUE,
  origen      TEXT NOT NULL,
  creadas     INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
