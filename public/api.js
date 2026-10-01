export class ApiError extends Error { constructor(m, status, code) { super(m); this.status = status; this.code = code; } }

async function call(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'x-requested-with': 'liva', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch { throw new ApiError('Sin conexión con el servidor.', 0); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Error ${res.status}`, res.status, data.code);
  return data;
}
export const api = {
  get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b),
  patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p)
};
