import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** TOTP (RFC 6238): HMAC-SHA1, 6 dígitos, paso de 30 s. Compatible con Google Authenticator, Microsoft Authenticator, Authy, 1Password… */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = buf => { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; };
export const deBase32 = s => { let bits = 0, v = 0; const out = []; for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) throw new Error('base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };

export const nuevoSecreto = () => base32(randomBytes(20));
export const uri = (secreto, cuenta, emisor = 'LIVA Cartera') =>
  `otpauth://totp/${encodeURIComponent(emisor)}:${encodeURIComponent(cuenta)}?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;

export function codigo(secreto, contador) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(contador));
  const h = createHmac('sha1', deBase32(secreto)).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
const igual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Verifica un código con tolerancia de ±1 paso. Devuelve el contador usado o null.
 * `ultimo`: último contador aceptado; se rechaza todo contador <= ultimo, así un código no sirve dos veces (anti-repetición).
 */
export function verificar(secreto, cod, ultimo = 0, ahora = Date.now()) {
  const c = String(cod ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const t = Math.floor(ahora / 30000);
  let hallado = null;
  for (const d of [-1, 0, 1]) if (t + d > ultimo && igual(codigo(secreto, t + d), c) && hallado === null) hallado = t + d;
  return hallado;
}

/** Códigos de recuperación de un solo uso (se guardan solo como hash). */
const ALF = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const generarRecuperacion = (n = 8) => Array.from({ length: n }, () => Array.from({ length: 10 }, () => ALF[randomInt(ALF.length)]).join('').replace(/^(.{5})/, '$1-'));
export const hashRecuperacion = c => createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
