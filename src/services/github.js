const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(msg, status = 502) { super(msg); this.status = status; }
}

export function parseRepo(s) {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(String(s || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Cliente mínimo. `fetchImpl` es inyectable para pruebas; el token nunca sale del servidor. */
export function crearGitHub({ token, repos, fetchImpl = fetch }) {
  const permitido = repo => {
    const r = parseRepo(repo);
    if (!r) throw new GitHubError('Repositorio inválido (usa dueño/repo).', 400);
    if (!repos.some(x => x.toLowerCase() === r.toLowerCase())) throw new GitHubError('Ese repositorio no está en la lista permitida (GITHUB_REPOS).', 403);
    return r;
  };
  async function llamar(path, init = {}) {
    if (!token) throw new GitHubError('GitHub no está configurado (falta GITHUB_TOKEN).', 503);
    let res;
    try {
      res = await fetchImpl(API + path, {
        ...init,
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`, 'User-Agent': 'gestor-directivo-liva',
          ...(init.body ? { 'Content-Type': 'application/json' } : {})
        }
      });
    } catch { throw new GitHubError('No se pudo contactar a GitHub.'); }
    if (res.status === 404) throw new GitHubError('No encontrado en GitHub (¿el token tiene acceso?).', 404);
    if (res.status === 401) throw new GitHubError('El token de GitHub es inválido o expiró.', 502);
    if (res.status === 403 || res.status === 429) throw new GitHubError('GitHub rechazó la solicitud (permisos o límite de uso).', 502);
    if (!res.ok) throw new GitHubError(`GitHub respondió ${res.status}.`);
    return res.json();
  }
  const normalizar = (repo, x) => ({
    repo, tipo: x.pull_request ? 'pr' : 'issue', numero: x.number, titulo: String(x.title || '').slice(0, 200),
    url: x.html_url, estado: x.pull_request?.merged_at ? 'merged' : x.state
  });
  return {
    configurado: () => Boolean(token),
    repos: () => repos,
    async crearIssue(repo, { titulo, cuerpo }) {
      const r = permitido(repo);
      return normalizar(r, await llamar(`/repos/${r}/issues`, { method: 'POST', body: JSON.stringify({ title: titulo, body: cuerpo }) }));
    },
    async obtener(repo, numero) {
      const r = permitido(repo);
      return normalizar(r, await llamar(`/repos/${r}/issues/${Number(numero)}`));
    },
    async listarAbiertos(repo) {
      const r = permitido(repo);
      const data = await llamar(`/repos/${r}/issues?state=open&per_page=50`);
      return data.map(x => normalizar(r, x));
    }
  };
}
