import { failure } from './security.mjs';

// This client never accepts a host, API path or bearer from public input.
export function createHostingerClient(settings, transport = fetch) {
  const base = `https://developers.hostinger.com/api/hosting/v1/accounts/${settings.account}/databases`;
  async function request(method, suffix = '', data) {
    let response;
    try {
      response = await transport(base + suffix, { method, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json', Authorization: `Bearer ${settings.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    } catch { throw Object.assign(failure(503, 'A hospedagem ainda está preparando seu espaço.'), { category: 'provider_uncertain' }); }
    // A missing resource is not proof of a completed deletion. The caller must
    // still confirm its absence in the provider's complete database listing.
    if (method === 'DELETE' && response.status === 404) return { notFound: true };
    if (!response.ok) {
      const category = [401, 403].includes(response.status) ? 'provider_access' : response.status === 429 ? 'provider_busy' : response.status >= 500 ? 'provider_uncertain' : 'provider_rejected';
      // Do not propagate provider bodies: they may contain usernames or secrets.
      throw Object.assign(failure(503, 'Não foi possível concluir a preparação na hospedagem.'), { category });
    }
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw Object.assign(failure(503, 'Resposta da hospedagem inválida.'), { category: 'provider_uncertain' });
    // Deletion can return 202/204 or a plain acceptance message. Neither is
    // reported as a released database until a separate listing verifies it.
    if (method === 'DELETE') return { accepted: true };
    try { return JSON.parse(raw); } catch { throw Object.assign(failure(503, 'Resposta da hospedagem inválida.'), { category: 'provider_uncertain' }); }
  }
  async function databases() {
    const rows = [], names = new Set(); let total = 0, expectedTotal = null;
    for (let page = 1; page <= 20; page++) {
      const value = await request('GET', `?per_page=100&page=${page}`);
      const totalValue = value?.meta?.total;
      const numericTotal = typeof totalValue === 'number' || typeof totalValue === 'string' && /^\d+$/.test(totalValue);
      if (!Array.isArray(value?.data) || !numericTotal || !Number.isSafeInteger(Number(totalValue)) || Number(totalValue) < 0 || Number(totalValue) > 2000 || value.data.some(r => !r || typeof r.name !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(r.name) || typeof r.user !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(r.user))) throw Object.assign(failure(503, 'A lista de bancos da hospedagem precisa ser conferida.'), { category: 'provider_uncertain' });
      total = Number(value.meta.total);
      if (expectedTotal !== null && total !== expectedTotal) throw Object.assign(failure(503, 'A lista de bancos mudou durante a conferência. Atualize antes de continuar.'), { category: 'provider_uncertain' });
      expectedTotal = total;
      for (const row of value.data) {
        if (names.has(row.name.toLowerCase())) throw Object.assign(failure(503, 'A lista de bancos da hospedagem precisa ser conferida.'), { category: 'provider_uncertain' });
        names.add(row.name.toLowerCase()); rows.push(row);
      }
      if (rows.length > total) throw Object.assign(failure(503, 'A lista de bancos da hospedagem precisa ser conferida.'), { category: 'provider_uncertain' });
      if (rows.length === total) return { rows, total };
      if (!value.data.length) break;
    }
    throw Object.assign(failure(503, 'Não foi possível conferir todos os bancos da hospedagem.'), { category: 'provider_uncertain' });
  }
  async function create(entry) {
    return request('POST', '', { name: entry.database, user: entry.user, password: entry.password, website_domain: settings.domain });
  }
  async function remove(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(name) || !name.startsWith(settings.account + '_')) throw failure(422, 'Banco exclusivo inválido para esta conta de hospedagem.');
    return request('DELETE', '/' + encodeURIComponent(name));
  }
  return { databases, create, remove };
}
