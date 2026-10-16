-- Verificación en dos pasos (TOTP). El secreto se guarda cifrado (src/crypto.js).
ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN mfa_ultimo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_recuperacion TEXT NOT NULL DEFAULT '[]';
