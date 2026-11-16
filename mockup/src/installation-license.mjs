import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { readSettings } from './database.mjs';
import { failure, isEmail, normalizeEmail } from './security.mjs';
import { communitySeats, createProfessionalSeats } from './professional-seats.mjs';

const origin = 'https://licencas.raelapps.com';
const product = 'rael-schedule';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const testConfig = {
  keyId: 'rael-homologacao-v1',
  key: createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEAX8NBPWcCmQ/amulPflN0g3zXHcS2V7ks9Gxot39EOtE=', 'base64'), type: 'spki', format: 'der' })
};
const messages = {
  email_confirmation_required: 'Confirme o e-mail da contratação antes de abrir o checkout.',
  order_closed: 'Este pedido foi encerrado. Atualize a situação da licença.',
  license_not_found: 'Esta instalação ainda não tem licença para renovar.',
  plan_unavailable: 'Este plano não está disponível para contratação.',
  invalid_proposal: 'Confira o código da proposta.',
  invalid_email: 'Informe um e-mail válido.',
  email_unavailable: 'O serviço de e-mail está indisponível. Tente novamente em alguns minutos.',
  email_rate_limit: 'Aguarde um minuto antes de solicitar outro link.',
  installation_already_licensed: 'Esta instalação já tem uma licença. Use a opção de renovação.',
  purchase_already_open: 'Já existe um pedido em aberto nesta instalação.',
  rate_limited: 'Aguarde alguns minutos antes de tentar novamente.'
};

function unavailable() {
  return failure(503, 'A central de licenças está indisponível no momento. Tente novamente em instantes.');
}

function checkoutUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw unavailable(); }
  if (!['https://sandbox.mercadopago.com.br', 'https://sandbox.mercadopago.com'].includes(url.origin) ||
    url.username || url.password || !/^\/(?:mlb\/)?checkout\//i.test(url.pathname)) throw unavailable();
  return url.href;
}

function claimsOf(token, installation, config) {
  if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [encoded, encodedSignature] = token.split('.');
  const payload = Buffer.from(encoded, 'base64url'), signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64 || !verify(null, payload, config.key, signature)) return null;
  let claims;
  try { claims = JSON.parse(payload); } catch { return null; }
  if (claims?.schema !== 'rael-license-v1' || claims.keyId !== config.keyId || claims.product !== product ||
    claims.installationId !== installation || !uuid.test(claims.licenseId) ||
    !Number.isSafeInteger(claims.activationVersion) || claims.activationVersion < 1 ||
    !['team', 'pro', 'custom'].includes(claims.plan) || !Number.isSafeInteger(claims.seats) || claims.seats < communitySeats ||
    !Array.isArray(claims.features) || !claims.features.every(feature => typeof feature === 'string')) return null;
  const [start, end, grace] = ['validFrom', 'expiresAt', 'graceUntil'].map(key => Date.parse(claims[key]));
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(grace) || start >= end || end > grace) return null;
  return { ...claims, start, end, grace };
}

export function createInstallationLicense(db, enabled, { send = fetch, now = Date.now, config = testConfig } = {}) {
  if (!enabled) return null;
  let syncing, verifiedAt = -Infinity;

  async function central(path, row, data) {
    let response, result;
    try {
      response = await send(origin + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(row ? { 'X-Installation-Id': row.installation_id, Authorization: 'Bearer ' + row.credential } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data),
        redirect: 'error',
        signal: AbortSignal.timeout(8000)
      });
      result = await response.json();
    } catch { throw unavailable(); }
    if (response.ok) return result;
    if (response.status >= 500) throw unavailable();
    const message = Object.hasOwn(messages, result?.error) ? messages[result.error] : 'A central recusou esta operação. Atualize o painel e tente novamente.';
    throw failure(response.status, message);
  }

  async function local(conn = db) {
    const [row] = await conn.query('SELECT * FROM installation_license WHERE id = 1');
    return row;
  }

  async function identity() {
    const row = await db.transaction(async tx => {
      await readSettings(tx, true);
      const existing = await local(tx);
      if (existing) return existing;
      const installation_id = randomUUID(), credential = randomBytes(32).toString('base64url');
      await tx.query('INSERT INTO installation_license (id, installation_id, credential, registered, token, remote_state) VALUES (1, ?, ?, 0, NULL, ?)', [installation_id, credential, 'community']);
      return { installation_id, credential, registered: 0 };
    });
    if (!Number(row.registered)) {
      const registration = await central('/v1/installations', null, { id: row.installation_id, credential: row.credential, product });
      if (registration.id !== row.installation_id || registration.product !== product) throw unavailable();
      await db.query('UPDATE installation_license SET registered = 1 WHERE id = 1');
    }
    return row;
  }

  async function sync() {
    if (!syncing) {
      syncing = (async () => {
        const row = await local();
        if (!Number(row?.registered)) return;
        const result = await central('/v1/license', row);
        let token = null;
        if (['active', 'grace'].includes(result?.status)) {
          const claims = claimsOf(result.license, row.installation_id, config);
          if (!claims || claims.licenseId !== result.id || claims.start > now() || claims.grace <= now()) throw unavailable();
          token = result.license;
        } else if (!['community', 'expired'].includes(result?.status) || result.product !== product) {
          throw unavailable();
        }
        await db.query('UPDATE installation_license SET token = ?, remote_state = ? WHERE id = 1', [token, result.status]);
        verifiedAt = now();
      })().finally(() => { syncing = null; });
    }
    return syncing;
  }

  async function current(conn = db) {
    const row = await local(conn);
    const signed = claimsOf(row?.token, row?.installation_id, config);
    const time = now();
    if (signed && signed.start <= time && time < signed.grace) return {
      plan: signed.plan, status: time < signed.end ? 'active' : 'grace', seats: signed.seats,
      expiresAt: signed.expiresAt, graceUntil: signed.graceUntil
    };
    return { plan: 'community', status: signed || row?.remote_state === 'expired' ? 'expired' : 'community', seats: communitySeats };
  }

  async function view() {
    const row = await local();
    const [catalog, updated, orders] = await Promise.allSettled([
      central('/v1/catalog?product=' + product),
      sync(),
      Number(row?.registered) ? central('/v1/orders', row) : []
    ]);
    const license = await current();
    return { mode: 'test', license, canRenew: license.status !== 'community',
      professionals: (await readSettings(db)).draft.professionals.filter(person => person.active).length,
      online: [catalog, updated, orders].every(result => result.status === 'fulfilled'),
      plans: Array.isArray(catalog.value?.plans) ? catalog.value.plans : [],
      orders: Array.isArray(orders.value) ? orders.value : [] };
  }

  async function action(name, data) {
    if (!['purchase', 'renewal', 'recovery', 'checkout', 'cancel'].includes(name)) throw failure(404, 'Ação não encontrada.');
    let email;
    if (name === 'purchase' || name === 'recovery') {
      email = normalizeEmail(data.email);
      if (!isEmail(email)) throw failure(422, 'Informe um e-mail válido.');
    }
    if (name === 'purchase') {
      if (!['team', 'pro', 'custom'].includes(data.plan)) throw failure(422, 'Escolha um plano disponível.');
      const proposalId = data.plan === 'custom' ? String(data.proposalId ?? '').trim() : '';
      if (data.plan === 'custom' && !uuid.test(proposalId)) throw failure(422, 'Informe o código da proposta.');
      return central('/v1/orders', await identity(), { plan: data.plan, email, ...(proposalId ? { proposalId } : {}) });
    }
    if (name === 'recovery') return central('/v1/recovery', await identity(), { email });
    const row = await local();
    if (!Number(row?.registered)) throw failure(409, 'Esta instalação ainda não tem um pedido de licença.');
    if (name === 'renewal') return central('/v1/orders/renewal', row, {});
    if (!uuid.test(data.orderId)) throw failure(422, 'Pedido inválido.');
    if (name === 'cancel' && (await central('/v1/orders/' + data.orderId, row)).emailVerified) {
      throw failure(409, 'O e-mail já foi confirmado. Consulte a situação do pedido.');
    }
    const result = await central('/v1/orders/' + data.orderId + '/' + name, row, {});
    return name === 'checkout' ? { url: checkoutUrl(result.url) } : result;
  }

  const professionalSeats = createProfessionalSeats(current,
    seats => `A licença permite até ${seats} profissionais ativos. Inative os excedentes ou atualize a licença em Configurações → Licença do sistema.`);

  async function proAccess(conn = db) {
    const time = now();
    if (time - verifiedAt > 5 * 60_000) return null;
    const row = await local(conn);
    const signed = claimsOf(row?.token, row?.installation_id, config);
    if (signed?.plan !== 'pro' || signed.start > time || time >= signed.end) return null;
    return { features: signed.features, version: signed.licenseId + ':' + signed.activationVersion };
  }

  return { view, action, sweep: sync, ...professionalSeats, proAccess };
}
