import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifrado de campos sensibles (nombre, cédula, teléfono, notas) en reposo.
 *  - AES-256-GCM con IV aleatorio por valor; el id de la fila va como dato autenticado (AAD): un texto cifrado
 *    copiado a otra fila no descifra.
 *  - Formato: v1.<idClave>.<iv>.<tag>.<texto> (base64url). El idClave permite rotar claves sin perder datos.
 *  - Índice ciego (HMAC-SHA256) de la cédula para buscar por igualdad y garantizar unicidad sin guardar la cédula en claro.
 * La clave vive SOLO en el entorno (DATA_KEY). Si se pierde, los datos cifrados no se pueden recuperar: guárdala en un gestor de secretos.
 */
const aBuf = (s, nombre) => {
  const t = String(s).trim();
  const b = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (b.length !== 32) throw new Error(`${nombre} debe ser de 32 bytes (64 caracteres hex o base64). Genera una con: openssl rand -hex 32`);
  return b;
};
const idDe = k => createHash('sha256').update(k).digest('hex').slice(0, 8);
const derivar = (k, info) => Buffer.from(hkdfSync('sha256', k, Buffer.alloc(0), info, 32));

export function crearCifrador({ dataKey, dataKeyPrev = '' }) {
  const actual = aBuf(dataKey, 'DATA_KEY');
  const previas = String(dataKeyPrev || '').split(',').map(s => s.trim()).filter(Boolean).map(s => aBuf(s, 'DATA_KEY_PREV'));
  const llaves = new Map([actual, ...previas].map(k => [idDe(k), derivar(k, 'liva-cifrado-v1')]));
  const idActual = idDe(actual);
  const idx = derivar(actual, 'liva-indice-v1');
  const idxPrevias = previas.map(k => derivar(k, 'liva-indice-v1'));

  return {
    idClave: idActual,
    cifrar(valor, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', llaves.get(idActual), iv);
      c.setAAD(Buffer.from(String(aad)));
      const ct = Buffer.concat([c.update(JSON.stringify(valor), 'utf8'), c.final()]);
      return ['v1', idActual, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    descifrar(texto, aad) {
      const [v, id, iv, tag, ct] = String(texto).split('.');
      const llave = v === 'v1' && llaves.get(id);
      if (!llave) throw new Error('Dato cifrado con una clave desconocida.');
      const d = createDecipheriv('aes-256-gcm', llave, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(String(aad)));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
    },
    necesitaRotar: texto => String(texto).split('.')[1] !== idActual,
    /** Normaliza (solo dígitos) y devuelve el índice ciego. */
    indiceCedula: ced => createHmac('sha256', idx).update(String(ced).replace(/\D/g, '')).digest('hex'),
    indicesCedulaPrevios: ced => idxPrevias.map(k => createHmac('sha256', k).update(String(ced).replace(/\D/g, '')).digest('hex'))
  };
}

/** Enmascara una cédula para mostrarla: ••••1234. */
export const enmascarar = ced => { const d = String(ced || '').replace(/\D/g, ''); return d ? '••••' + d.slice(-4) : ''; };
